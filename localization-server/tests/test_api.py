import json

import cv2
import numpy as np
import pytest

from locserver import geometry as g


def jpeg(w=64, h=48) -> bytes:
    img = np.random.default_rng(0).integers(0, 255, (h, w, 3), dtype=np.uint8)
    return cv2.imencode(".jpg", img)[1].tobytes()


def cam_pose_in_map(position, R_map_from_arcam=np.eye(3)) -> np.ndarray:
    """COLMAP pose (T_cvcam_from_map) of a camera given GL-style in the map."""
    T_map_from_cvcam = g.make_T(R_map_from_arcam @ g.GL_FROM_CV, position)
    return g.invert_T(T_map_from_cvcam)


def test_health_and_maps(api):
    h = api.get("/health").json()
    assert h["status"] == "ok" and h["maps"] == ["metric_room", "scaleless_room"]
    maps = {m["map_id"]: m for m in api.get("/maps").json()["maps"]}
    assert maps["metric_room"]["metric"] is True and maps["scaleless_room"]["metric"] is False
    info = api.get("/maps/metric_room").json()
    assert info["camera"]["fx"] == 500.0 and info["anchors"] == {}
    assert api.get("/maps/nope").status_code == 404


def test_anchor_crud_in_map_coordinates(api):
    r = api.put("/maps/metric_room/anchors/portal", json={"position": [2, 0, -3], "rotation_euler_deg": [0, 90, 0], "note": "door"})
    assert r.status_code == 200, r.text
    a = api.get("/maps/metric_room/anchors/portal").json()
    assert a["position"] == [2.0, 0.0, -3.0] and a["frame"] == "map"
    assert np.allclose(g.quat_to_rotmat(a["quaternion_xyzw"]), g.viro_euler_to_rotmat([0, 90, 0]))
    assert "portal" in api.get("/maps/metric_room/anchors").json()["anchors"]
    assert api.get("/maps").json()["maps"][0]["anchors"] == ["portal"]
    assert api.put("/maps/metric_room/anchors/bad name", json={"position": [0, 0, 0]}).status_code == 422
    assert api.put("/maps/metric_room/anchors/x", json={"rotation_euler_deg": [0, 0, 0]}).status_code == 422
    assert api.delete("/maps/metric_room/anchors/portal").status_code == 200
    assert api.get("/maps/metric_room/anchors/portal").status_code == 404


def test_localize_worked_example_from_readme(api):
    """The numbers of README section "Worked example"."""
    api.put("/maps/metric_room/anchors/portal", json={"position": [2.0, 0.0, -3.0], "quaternion_xyzw": [0, 0, 0, 1]})
    # the server localises the camera at (2, 1.5, 0) in the map, upright, looking along map -z
    T_cvcam_from_map = cam_pose_in_map([2.0, 1.5, 0.0])
    assert np.allclose(T_cvcam_from_map, [[1, 0, 0, -2.0], [0, -1, 0, 1.5], [0, 0, -1, 0.0], [0, 0, 0, 1]])
    api.stub.queue.append(T_cvcam_from_map)
    # meanwhile ViroReact says the camera is at (0.5, 1.5, -1) with rotation [0, 90, 0]
    r = api.post(
        "/localize",
        files={"image": ("q.jpg", jpeg(), "image/jpeg")},
        data={"map_id": "metric_room", "ar_pose": json.dumps({"position": [0.5, 1.5, -1.0], "rotation": [0, 90, 0]})},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["success"] and out["quality"] == "good"
    assert np.allclose(out["pose"]["position"], [2.0, 1.5, 0.0])
    al = out["alignment"]
    assert al["status"] == "ok" and al["scale"] == 1.0 and al["scale_source"] == "map_metric"
    expected = [[0, 0, 1, 0.5], [0, 1, 0, 0.0], [-1, 0, 0, 1.0], [0, 0, 0, 1]]
    assert np.allclose(al["T_arworld_from_map"], expected, atol=1e-9)
    portal = al["anchors"]["portal"]
    assert np.allclose(portal["position"], [-2.5, 0.0, -1.0], atol=1e-9)
    assert np.allclose(portal["rotation_euler_deg"], [0, 90, 0], atol=1e-7)
    # sanity: the portal is 3 m in front of the camera and 1.5 m below it, in both frames
    cam_ar = np.array([0.5, 1.5, -1.0])
    forward_ar = g.viro_euler_to_rotmat([0, 90, 0]) @ [0, 0, -1]
    assert np.isclose((np.array(portal["position"]) - cam_ar) @ forward_ar, 3.0)


def test_localize_flat_ar_fields_and_forward_up(api):
    api.stub.queue.append(cam_pose_in_map([0, 0, 0]))
    R = g.viro_euler_to_rotmat([10, 40, -5])
    f, u = R @ [0, 0, -1], R @ [0, 1, 0]
    r = api.post(
        "/localize",
        files={"image": ("q.jpg", jpeg(), "image/jpeg")},
        data={"map_id": "metric_room", "ar_position": "1,2,3", "ar_forward": ",".join(map(str, f)), "ar_up": json.dumps(list(u))},
    )
    al = r.json()["alignment"]
    assert np.allclose(np.array(al["T_arworld_from_map"])[:3, :3], R, atol=1e-9)
    assert np.allclose(al["translation"], [1, 2, 3])


def test_localize_without_ar_pose_and_failures(api):
    api.stub.queue.append(cam_pose_in_map([0, 0, 0]))
    out = api.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"map_id": "metric_room"}).json()
    assert out["success"] and out["alignment"] is None
    out = api.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"map_id": "metric_room"}).json()
    assert out["success"] is False and out["quality"] == "failed" and out["pose"] is None
    assert api.post("/localize", data={"map_id": "metric_room"}).status_code == 422  # no file
    assert api.post("/localize", files={"image": ("q.jpg", b"not an image", "image/jpeg")}, data={"map_id": "metric_room"}).status_code == 422
    # two maps loaded and none named: since revision 5 the server looks for the room itself (tests/test_wifi_rooms.py)
    r = api.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")})
    assert r.status_code == 200 and r.json()["room_choice"]["mode"] == "auto" and r.json()["room_choice"]["rooms_tried"] == 2
    assert api.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"map_id": "metric_room", "fx": "500"}).status_code == 422


def test_image_rotation_and_intrinsics_are_rotated_together(api):
    api.stub.queue.append(cam_pose_in_map([0, 0, 0]))
    r = api.post(
        "/localize",
        files={"image": ("q.jpg", jpeg(64, 48), "image/jpeg")},
        data={"map_id": "metric_room", "image_rotation_cw": "90", "fx": "50", "fy": "51", "cx": "30", "cy": "20"},
    )
    assert r.status_code == 200, r.text
    call = api.stub.calls[-1]
    assert call["shape"][:2] == (64, 48)  # landscape upload became portrait
    i = call["intrinsics"]
    assert (i["fx"], i["fy"], i["cx"], i["cy"], i["width"], i["height"]) == (51.0, 50.0, 48 - 20, 30.0, 48, 64)


def test_scaleless_map_single_frame_then_session(api):
    """Without metric scale one frame gives only the rotation; a session gives the rest."""
    api.put("/maps/scaleless_room/anchors/portal", json={"position": [1.0, 0.0, -2.0]})
    rng = np.random.default_rng(3)
    true = g.Sim3(2.5, g.viro_euler_to_rotmat([0, 30, 0]), np.array([0.3, 0.0, -0.4]))  # arworld <- map

    def observe(p_ar, euler):
        R_a = g.viro_euler_to_rotmat(euler)
        c_map = true.inverse().apply(np.array(p_ar))
        R_c = g.CV_FROM_GL @ R_a.T @ true.R
        api.stub.queue.append(g.make_T(R_c, -R_c @ c_map))
        return api.post(
            "/localize",
            files={"image": ("q.jpg", jpeg(), "image/jpeg")},
            data={"map_id": "scaleless_room", "session_id": "s1", "ar_pose": json.dumps({"position": p_ar, "rotation": euler})},
        ).json()

    first = observe([0.0, 1.5, 0.0], [0, 10, 0])
    assert first["alignment"]["status"] == "scale_unknown" and first["alignment"]["anchors"] == {}
    assert first["alignment"]["T_arworld_from_map"] is None
    second = observe([0.6, 1.5, -0.3], [-5, 40, 2])
    third = observe([1.1, 1.4, 0.4], [3, -20, 0])
    al = third["alignment"]
    assert third["session"]["num_observations"] == 3 and second["alignment"]["status"] == "ok"
    assert al["status"] == "ok" and al["scale_source"] == "estimated_from_session" and al["observations_used"] == 3
    assert np.isclose(al["scale"], 2.5, rtol=1e-6) and al["scale_reliable"] is True
    assert np.allclose(al["anchors"]["portal"]["position"], true.apply(np.array([1.0, 0.0, -2.0])), atol=1e-6)
    assert np.allclose(al["anchors"]["portal"]["rotation_euler_deg"], [0, 30, 0], atol=1e-6)

    s = api.get("/sessions/s1").json()
    assert s["num_observations"] == 3 and s["alignment"]["status"] == "ok"

    # author a second anchor from the AR side, using the session's alignment
    r = api.put("/maps/scaleless_room/anchors/window", json={"ar_pose": {"position": [2.0, 1.0, 0.0], "rotation": [0, 30, 0]}, "session_id": "s1"})
    assert r.status_code == 200, r.text
    w = r.json()
    assert np.allclose(w["position"], true.inverse().apply(np.array([2.0, 1.0, 0.0])), atol=1e-6)
    assert np.allclose(g.quat_to_rotmat(w["quaternion_xyzw"]), np.eye(3), atol=1e-6)

    # stateless variant with the same three frames, and persisting the scale
    obs = [
        {"T_cvcam_from_map": f["pose"]["T_cvcam_from_map"], "ar_pose": p}
        for f, p in zip(
            (first, second, third),
            ({"position": [0.0, 1.5, 0.0], "rotation": [0, 10, 0]}, {"position": [0.6, 1.5, -0.3], "rotation": [-5, 40, 2]},
             {"position": [1.1, 1.4, 0.4], "rotation": [3, -20, 0]}),
        )
    ]
    al2 = api.post("/align", json={"map_id": "scaleless_room", "observations": obs, "persist_scale": True}).json()["alignment"]
    assert np.allclose(al2["T_arworld_from_map"], al["T_arworld_from_map"], atol=1e-9) and al2["scale_persisted"] is True
    info = api.get("/maps/scaleless_room").json()
    assert np.isclose(info["scale_m_per_unit"], 2.5, rtol=1e-6) and info["scale_source"] == "ar_session" and info["metric"] is False

    # from now on a single frame in a brand-new session is enough
    api.stub.queue.append(np.array(first["pose"]["T_cvcam_from_map"]))
    out = api.post(
        "/localize",
        files={"image": ("q.jpg", jpeg(), "image/jpeg")},
        data={"map_id": "scaleless_room", "ar_pose": json.dumps({"position": [0.0, 1.5, 0.0], "rotation": [0, 10, 0]})},
    ).json()
    assert out["alignment"]["status"] == "ok" and out["alignment"]["scale_source"] == "map_calibrated"
    assert np.allclose(out["alignment"]["anchors"]["portal"]["position"], true.apply(np.array([1.0, 0.0, -2.0])), atol=1e-6)

    assert api.delete("/sessions/s1").status_code == 200 and api.get("/sessions/s1").status_code == 404


def test_anchor_from_ar_pose_with_explicit_matrix(api):
    S = g.Sim3(1.0, g.viro_euler_to_rotmat([0, -45, 0]), np.array([1.0, 0.0, 2.0]))
    body = {"ar_pose": {"position": [0.0, 0.0, -1.0], "rotation": [0, -45, 0]}, "T_arworld_from_map": S.matrix().tolist()}
    a = api.put("/maps/metric_room/anchors/door", json=body).json()
    assert np.allclose(a["position"], S.inverse().apply(np.array([0.0, 0.0, -1.0])), atol=1e-9)
    assert np.allclose(g.quat_to_rotmat(a["quaternion_xyzw"]), np.eye(3), atol=1e-9)
    assert api.put("/maps/metric_room/anchors/door2", json={"ar_pose": {"position": [0, 0, 0]}}).status_code == 422


def test_manual_scale_endpoint(api):
    assert api.put("/maps/metric_room/scale", json={"scale_m_per_unit": 2}).status_code == 422  # already metric
    assert api.put("/maps/scaleless_room/scale", json={"scale_m_per_unit": -1}).status_code == 422
    r = api.put("/maps/scaleless_room/scale", json={"scale_m_per_unit": 0.5})
    assert r.status_code == 200 and r.json()["scale_m_per_unit"] == 0.5


@pytest.mark.parametrize("bad", ["[1,2]", "{}", "not json"])
def test_bad_ar_pose_is_rejected(api, bad):
    r = api.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"map_id": "metric_room", "ar_pose": bad})
    assert r.status_code == 422
