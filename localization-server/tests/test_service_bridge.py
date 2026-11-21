"""One door per room; an external positioning service is tied to the room by a bridge, not by a second door."""

from __future__ import annotations

import numpy as np
import pytest

from locserver import bridge
from locserver import geometry as g
from test_staff_door import DOOR, build, localize, make_server


def rigid(euler, t):
    return g.make_T(g.viro_euler_to_rotmat(euler), t)


def noisy(T, rng, pos=0.01, deg=0.5):
    """``T`` with an error as a phone makes it: a small turn about a point near the phone (the origin of
    the frame ``T`` maps into), not about the far origin of the service's map."""
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    a = np.radians(rng.normal(scale=deg))
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    dR = np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K
    return g.make_T(dR, rng.normal(scale=pos, size=3)) @ T


# the service's map lies somewhere else entirely: 40 m away and turned
T_MAP_FROM_SERVICE = rigid([0, 70, 0], [38.0, -1.5, 12.0])


# ------------------------------------------------------------------ the maths --- #
def test_the_average_is_taken_at_the_room_not_at_the_far_origin_of_the_service():
    rng = np.random.default_rng(1)
    door = np.array([1.2, 0.0, -2.5])
    # every estimate is right at the door up to 1 cm, with half a degree of rotation noise
    Ms = []
    for _ in range(12):
        M = noisy(np.eye(4), rng, pos=0.01, deg=0.5)
        Ms.append(g.make_T(np.eye(3), door) @ M @ g.make_T(np.eye(3), -door) @ T_MAP_FROM_SERVICE)
    r = bridge.average(Ms, door)
    x_door = (bridge.invert_similarity(T_MAP_FROM_SERVICE) @ np.append(door, 1))[:3]
    assert np.linalg.norm((r["T_map_from_service"] @ np.append(x_door, 1))[:3] - door) < 0.01
    assert r["samples"] == 12 and r["position_spread_m"] < 0.03 and r["rotation_spread_deg"] < 1.0
    # compared at the origin of the service's map, 40 m away, the same estimates look tens of centimetres apart
    assert bridge.average(Ms, None)["samples"] <= 12
    far = np.array([M[:3, 3] for M in Ms])
    assert np.linalg.norm(far - far.mean(axis=0), axis=1).max() > 0.2


def test_wild_samples_are_left_out_and_disagreement_is_refused():
    rng = np.random.default_rng(2)
    good = [noisy(T_MAP_FROM_SERVICE, rng, pos=0.005, deg=0.05) for _ in range(8)]
    bad = [rigid([0, 10, 0], [5, 0, 5]) @ T_MAP_FROM_SERVICE, rigid([0, 0, 0], [0.6, 0, 0]) @ T_MAP_FROM_SERVICE]
    r = bridge.average(good + bad)
    assert r["samples"] == 8 and r["samples_total"] == 10 and r["used"][-2:] == [False, False]
    with pytest.raises(ValueError, match="disagree"):
        bridge.average([rigid([0, 0, 0], [i * 1.0, 0, 0]) for i in range(6)])
    one = bridge.average([T_MAP_FROM_SERVICE])
    assert one["samples"] == 1 and one["position_spread_m"] is None and np.allclose(one["T_map_from_service"], T_MAP_FROM_SERVICE)


def test_a_sample_can_be_the_camera_seen_by_both():
    cam_ar = rigid([10, 30, 0], [0.4, 1.5, -0.2])
    T_ar_from_service = rigid([0, -20, 0], [3.0, 0.1, 7.0])
    cam_service = bridge.invert_similarity(T_ar_from_service) @ cam_ar
    q = lambda T: {"position": T[:3, 3].tolist(), "quaternion_xyzw": g.rotmat_to_quat(T[:3, :3]).tolist()}  # noqa: E731
    got = bridge.sample_arworld_from_service({"camera_in_arworld": q(cam_ar), "camera_in_service": cam_service.tolist()}, 0)
    assert np.allclose(got, T_ar_from_service, atol=1e-6)
    for bad in ({}, {"camera_in_arworld": q(cam_ar)}, {"T_arworld_from_service": [[1, 0], [0, 1]]},
                {"T_arworld_from_service": (2 * np.eye(4) - np.diag([0, 0, 0, 1])).tolist()}):
        with pytest.raises((ValueError, KeyError)):
            bridge.sample_arworld_from_service(bad, 0)


# -------------------------------------------------------------------- the API --- #
def test_the_bridge_is_measured_in_the_session_that_recorded_and_serves_the_one_door(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7", label="Main hall")
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    rng = np.random.default_rng(3)
    # in the recording's session the AR world is the room's frame, so arworld <- service is the bridge itself
    samples = [{"T_arworld_from_service": noisy(T_MAP_FROM_SERVICE, rng, pos=0.01, deg=0.2).tolist()} for _ in range(10)]
    r = c.post("/maps/hall/vps/bridge", json={"session_id": "ar-7", "location_id": "loc_42", "samples": samples},
               headers={"X-Device-Id": "staff-phone"})
    assert r.status_code == 200, r.text
    v = r.json()["vps"]
    b = v["bridge"]
    assert v["provider"] == "reactvision" and v["location_id"] == "loc_42"
    assert b["method"] == "dual_localization" and b["samples"] == 10 and b["alignment_used"] == "recording_session"
    assert b["compared_at"] == "door" and b["valid"] is True and b["measured_by"] == "staff-phone" and b["measured_utc"]
    assert b["warnings"] == []  # ten samples, in the session whose world is the room's frame
    assert b["position_error_m"] < 0.03 and b["rotation_error_deg"] < 0.5 and b["scale"] == pytest.approx(1.0)
    assert np.allclose(np.array(b["T_map_from_service"]) @ np.array(b["T_service_from_map"]), np.eye(4), atol=1e-9)
    # the bridge is within the noise of the truth at the door
    door = np.array(c.get("/maps/hall/portal").json()["position"])
    x = (bridge.invert_similarity(T_MAP_FROM_SERVICE) @ np.append(door, 1))[:3]
    assert np.linalg.norm((np.array(b["T_map_from_service"]) @ np.append(x, 1))[:3] - door) < 0.02
    m = {x["map_id"]: x for x in c.get("/maps").json()["maps"]}["hall"]
    assert m["recognition"] == ["self-hosted", "reactvision"] and m["vps"]["bridge"]["valid"] and m["frame_id"]
    assert {x["map_id"]: x for x in c.get("/maps").json()["maps"]}["metric_room"]["recognition"] == ["self-hosted"]

    # what a visitor located by the service does with it: door in AR = (arworld <- service) (service <- map) (map <- door)
    T_ar_from_service = rigid([0, -35, 0], [2.0, 0.3, -4.0])  # this visitor's AR world, as the service reports it
    T_ar_from_map = T_ar_from_service @ np.array(b["T_service_from_map"])
    truth = T_ar_from_service @ bridge.invert_similarity(T_MAP_FROM_SERVICE) @ np.append(door, 1)
    assert np.linalg.norm((T_ar_from_map @ np.append(door, 1) - truth)[:3]) < 0.02

    # moving the door moves it for both ways: there is no second copy to forget
    moved = {**DOOR, "ar_pose": {"position": [2.0, 0.0, -1.0], "rotation": [0, 90, 0]}, "session_id": "ar-7"}
    assert c.put("/maps/hall/anchors/portal", json=moved).status_code == 200
    v2 = c.get("/maps/hall").json()["vps"]
    assert v2["bridge"]["T_map_from_service"] == b["T_map_from_service"] and "door" not in v2
    assert c.get("/maps/hall/portal").json()["position"] == pytest.approx([2.0, 0.0, -1.0])


def test_another_session_needs_its_own_alignment_first_and_the_error_adds_up(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7")
    one = [{"T_arworld_from_service": np.eye(4).tolist()}]
    r = c.post("/maps/hall/vps/bridge", json={"session_id": "ar-8", "location_id": "loc_42", "samples": one})
    assert r.status_code == 422 and "/localize" in r.json()["detail"]
    true = g.Sim3(1.0, g.viro_euler_to_rotmat([0, 25, 0]), np.array([0.5, 0.0, -1.0]))  # arworld <- map of session ar-8
    localize(c, "hall", "ar-8", true, [0.0, 1.5, 0.0], [0, 10, 0])
    rng = np.random.default_rng(4)
    T_ar_from_service = true.matrix() @ T_MAP_FROM_SERVICE
    samples = [{"T_arworld_from_service": noisy(T_ar_from_service, rng, pos=0.005, deg=0.1).tolist()} for _ in range(6)]
    r = c.post("/maps/hall/vps/bridge", json={"session_id": "ar-8", "location_id": "loc_42", "samples": samples})
    assert r.status_code == 200, r.text
    b = r.json()["vps"]["bridge"]
    assert b["alignment_used"] == "session_alignment" and b["compared_at"] == "map_origin"
    assert b["alignment_frames"] == 1 and any("NOT in position_error_m" in w for w in b["warnings"])
    assert b["position_error_m"] >= b["position_spread_m"] and b["alignment_position_rms_m"] is not None
    got = np.array(b["T_map_from_service"])
    x0 = (bridge.invert_similarity(T_MAP_FROM_SERVICE) @ np.array([0, 0, 0, 1.0]))[:3]
    assert np.linalg.norm((got @ np.append(x0, 1))[:3]) < 0.02 and g.rotation_angle_deg(got[:3, :3], T_MAP_FROM_SERVICE[:3, :3]) < 0.5
    # one sample: stored, but nothing can be said about its error
    r = c.post("/maps/hall/vps/bridge", json={"session_id": "ar-8", "samples": samples[:1]})  # the place is known already
    b1 = r.json()["vps"]["bridge"]
    assert r.status_code == 200 and b1["samples"] == 1 and b1["position_error_m"] is None and r.json()["vps"]["location_id"] == "loc_42"
    assert any("only 1 sample" in w for w in b1["warnings"])
    for bad in ({"session_id": "ar-8"}, {"session_id": "ar-8", "samples": []}, {"samples": one},
                {"session_id": "ar-8", "samples": one, "door": {}}, {"session_id": "ar-8", "samples": [{"x": 1}]}):
        assert c.post("/maps/hall/vps/bridge", json=bad).status_code == 422, bad
    assert c.post("/maps/side/vps/bridge", json={"session_id": "ar-8", "samples": one}).status_code == 404
    # a room without a place at the service needs the location id with the first measurement
    assert c.post("/maps/metric_room/vps/bridge", json={"T_arworld_from_map": np.eye(4).tolist(), "samples": one}).status_code == 422
    r = c.post("/maps/metric_room/vps/bridge", json={"T_arworld_from_map": np.eye(4).tolist(), "samples": one,
                                                      "location_id": "loc_1", "provider": "arcore"})
    assert r.status_code == 200 and r.json()["vps"]["bridge"]["alignment_used"] == "matrix"
    assert c.get("/maps/metric_room").json()["recognition"] == ["self-hosted", "arcore"]


def test_the_app_may_send_a_bridge_it_worked_out_itself(tmp_path):
    c = make_server(tmp_path)
    b = {"T_map_from_service": T_MAP_FROM_SERVICE.tolist(), "position_error_m": 0.04, "rotation_error_deg": 0.8, "samples": 12}
    r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", "bridge": b, "note": "scanned today"}},
                headers={"X-Device-Id": "staff-phone"})
    assert r.status_code == 200, r.text
    got = r.json()["vps"]
    assert got["bridge"]["method"] == "client" and got["bridge"]["position_error_m"] == 0.04 and got["bridge"]["valid"]
    assert got["bridge"]["measured_by"] == "staff-phone" and got["bridge"]["measured_utc"] and got["note"] == "scanned today"
    assert np.allclose(got["bridge"]["T_service_from_map"], bridge.invert_similarity(T_MAP_FROM_SERVICE))
    # position + quaternion is accepted as well
    q = {"position": T_MAP_FROM_SERVICE[:3, 3].tolist(), "quaternion_xyzw": g.rotmat_to_quat(T_MAP_FROM_SERVICE[:3, :3]).tolist()}
    r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", "bridge": {"T_map_from_service": q}}})
    assert r.status_code == 200 and np.allclose(r.json()["vps"]["bridge"]["T_map_from_service"], T_MAP_FROM_SERVICE, atol=1e-9)
    # a new note keeps the bridge; another place or an explicit null drops it
    r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", "note": "second visit"}})
    assert r.json()["vps"]["bridge"] is not None and r.json()["vps"]["note"] == "second visit"
    assert c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", "bridge": None}}).json()["vps"]["bridge"] is None
    c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", "bridge": b}})
    r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_other"}})
    assert r.json()["vps"]["bridge"] is None and r.json()["recognition"] == ["self-hosted"]
    shear = np.eye(4)
    shear[0, 1] = 0.3
    for bad in ({"door": {"position": [1, 0, 2], "quaternion_xyzw": [0, 0, 0, 1]}}, {"bridge": {}}, {"bridge": {"T_map_from_service": shear.tolist()}},
                {"bridge": {"T_map_from_service": np.eye(4).tolist(), "api_key": "secret"}},
                {"bridge": {"T_map_from_service": np.eye(4).tolist(), "position_error_m": -1}}):
        r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123", **bad}})
        assert r.status_code == 422, bad
    assert "one door" in c.patch("/maps/metric_room", json={"vps": {"location_id": "a", "door": {}}}).json()["detail"]


def test_a_new_scan_of_the_room_drops_the_bridge_with_the_door_and_keeps_the_place(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7", label="Main hall")
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    one = [{"T_arworld_from_service": T_MAP_FROM_SERVICE.tolist()}]
    assert c.post("/maps/hall/vps/bridge", json={"session_id": "ar-7", "location_id": "loc_42", "samples": one}).status_code == 200
    build(c, "hall", session_id="ar-9", replace="true")
    m = c.get("/maps/hall").json()
    assert m["vps"]["location_id"] == "loc_42" and m["vps"]["bridge"] is None
    assert m["vps"]["bridge_dropped"]["reason"] == "room_rescanned" and m["recognition"] == ["self-hosted"]
    assert c.get("/maps/hall/portal").json()["source"] == "none"
    # measured again in the new scan's session: both are back
    assert c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-9"}).status_code == 200
    r = c.post("/maps/hall/vps/bridge", json={"session_id": "ar-9", "samples": one})
    assert r.status_code == 200 and "bridge_dropped" not in r.json()["vps"] and r.json()["vps"]["bridge"]["valid"]


def test_localize_still_hands_out_the_shift_of_the_room_and_names_its_frame(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7")
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    true = g.Sim3(1.0, g.viro_euler_to_rotmat([0, 25, 0]), np.array([0.5, 0.0, -1.0]))
    out = localize(c, "hall", "visit-1", true, [0.0, 1.5, 0.0], [0, 10, 0])
    al = out["alignment"]
    door = c.get("/maps/hall/portal").json()
    assert out["frame_id"] == door["frame_id"] == c.get("/maps/hall").json()["frame_id"]
    # the app's common layer: door in AR = T_arworld_from_map x the one door record; the ready door says the same
    T = np.array(al["T_arworld_from_map"]) @ g.make_T(g.quat_to_rotmat(door["quaternion_xyzw"]), door["position"])
    assert np.allclose(T[:3, 3], al["portal"]["position"], atol=1e-6)
    assert np.allclose(T[:3, :3], g.quat_to_rotmat(al["portal"]["quaternion_xyzw"]), atol=1e-6)
    assert (al["portal"]["width"], al["portal"]["height"]) == (door["width"], door["height"])


def test_health_announces_the_bridge(tmp_path):
    h = make_server(tmp_path).get("/health").json()
    assert h["api_revision"] >= 4 and "service_bridge" in h["capabilities"]
