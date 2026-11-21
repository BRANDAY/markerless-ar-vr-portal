"""Two modes of the app: a staff member places the door once, a visitor's device gets room, plan and door.

Door = the anchor ``portal``. It carries its size, always wins over a doorway the server found itself (that one
is handed out as a suggestion), and can be saved in the AR session that recorded the room without a /localize.
"""
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import StubLocalizer, StubPipe, make_map
from locserver import geometry as g
from locserver.monitor import Monitor, usage_flow
from locserver.roomplan import compute_room_plan
from locserver.roomstage import save_room
from locserver.server import State, create_app
from locserver.synthroom import make_room, make_views
from test_api_v2 import session_jsonl, upload


@pytest.fixture(scope="module")
def plan():
    return compute_room_plan(make_views(make_room()), (0, 1, 0))


def make_server(tmp_path, room=None, metric=True):
    maps = tmp_path / "maps"
    make_map(maps / "metric_room", "metric_room", metric=True)

    def runner(job):  # what the real worker does, without SfM: a map that remembers the recording's session
        out = maps / f".build-{job.job_id}"
        make_map(out, job.map_id, metric=metric)
        meta = json.loads((out / "map.json").read_text(encoding="utf-8"))
        meta.update({k: job.params[k] for k in ("label", "device_id", "recording_session_id") if job.params.get(k)})
        (out / "map.json").write_text(json.dumps(meta), encoding="utf-8")
        if room is not None:
            save_room(out, room)
        return {"map_id": job.map_id, "num_images": 3, "warnings": []}

    state = State(maps, pipe=StubPipe(), localizer=StubLocalizer(), calibration_dir=tmp_path / "calib",
                  work_dir=tmp_path / "work", job_runner=runner)
    client = TestClient(create_app(state))
    client.state_obj = state
    return client


def build(c, map_id="hall", **data):
    r = upload(c, map_id, **data)
    assert r.status_code == 202, r.text
    assert c.state_obj.jobs.wait(r.json()["job"]["job_id"])["state"] == "succeeded"


def jpeg():
    return cv2.imencode(".jpg", np.zeros((48, 64, 3), np.uint8))[1].tobytes()


def localize(c, map_id, session, true: g.Sim3, p_ar, euler, headers=None):
    """One /localize whose stub answer is the camera pose that fits ``true`` (arworld <- map)."""
    R_a = g.viro_euler_to_rotmat(euler)
    c_map = true.inverse().apply(np.array(p_ar))
    R_c = g.CV_FROM_GL @ R_a.T @ true.R
    c.state_obj.localizer.queue.append(g.make_T(R_c, -R_c @ c_map))
    r = c.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, headers=headers or {},
               data={"map_id": map_id, "session_id": session, "ar_pose": json.dumps({"position": p_ar, "rotation": euler})})
    assert r.status_code == 200, r.text
    return r.json()


DOOR = {"ar_pose": {"position": [1.2, 0.0, -2.5], "rotation": [0, 40, 0]}, "width": 0.9, "height": 2.05}


# ------------------------------------------------------------ the staff's door --- #
def test_the_door_is_saved_right_after_the_build_in_the_session_that_recorded(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7", label="Main hall")
    # no /localize was made: in the recording's own AR session the map frame is the AR world
    r = c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"}, headers={"X-Device-Id": "staff-phone"})
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["alignment_used"] == "recording_session"
    assert np.allclose(a["position"], [1.2, 0.0, -2.5]) and np.allclose(g.quat_to_rotmat(a["quaternion_xyzw"]), g.viro_euler_to_rotmat([0, 40, 0]))
    assert a["width"] == 0.9 and a["height"] == 2.05 and a["placed_by"] == "staff-phone"
    p = c.get("/maps/hall/portal").json()
    assert p["source"] == "manual" and p["confirmed"] is True and (p["width"], p["height"]) == (0.9, 2.05)
    assert p["placed_by"] == "staff-phone" and p["updated_utc"] and a["portal"] == p
    m = {x["map_id"]: x for x in c.get("/maps").json()["maps"]}["hall"]
    assert m["label"] == "Main hall" and m["portal_source"] == "manual" and m["portal_confirmed"] and m["portal_size"] == [0.9, 2.05]


def test_another_session_has_to_localise_before_it_can_place_the_door(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7")
    r = c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-8"})
    assert r.status_code == 422 and "/localize" in r.json()["detail"]
    assert c.get("/maps/hall/portal").json()["source"] == "none"
    # a map that was uploaded without the session id gives no shortcut either
    build(c, "side", label="Side room")
    assert c.put("/maps/side/anchors/portal", json={**DOOR, "session_id": "ar-7"}).status_code == 422
    # after a /localize in that session its alignment is used, and the size is stored with it
    true = g.Sim3(1.0, g.viro_euler_to_rotmat([0, 25, 0]), np.array([0.5, 0.0, -1.0]))
    localize(c, "hall", "ar-8", true, [0.0, 1.5, 0.0], [0, 10, 0])
    r = c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-8"})
    assert r.status_code == 200, r.text
    assert r.json()["alignment_used"] == "session_alignment"
    assert np.allclose(r.json()["position"], true.inverse().apply(np.array([1.2, 0.0, -2.5])), atol=1e-6)


def test_a_map_that_is_not_metric_gives_no_shortcut(tmp_path):
    c = make_server(tmp_path, metric=False)
    build(c, "hall", session_id="ar-7")
    assert c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"}).status_code == 422


def test_door_size_is_checked_and_optional(tmp_path):
    c = make_server(tmp_path)
    pose = {"position": [1, 0, -2], "rotation_euler_deg": [0, 90, 0]}
    assert c.put("/maps/metric_room/anchors/portal", json={**pose, "width": 0.1}).status_code == 422
    assert c.put("/maps/metric_room/anchors/portal", json={**pose, "height": "tall"}).status_code == 422
    assert c.put("/maps/metric_room/anchors/portal", json=pose).status_code == 200  # v1 clients send no size
    p = c.get("/maps/metric_room/portal").json()
    assert p["source"] == "manual" and p["width"] is None and p["height"] is None and p["confirmed"] is True


def test_the_staffs_door_wins_and_the_found_doorway_is_a_suggestion(tmp_path, plan):
    c = make_server(tmp_path, room=plan)
    build(c, "hall", session_id="ar-7")
    auto = c.get("/maps/hall/portal").json()
    assert auto["source"] == "auto" and auto["confirmed"] is False  # nobody decided it: a visitor's app must not show it
    assert auto["suggested"]["opening_id"] == auto["opening_id"] and auto["suggested"]["position"] == auto["position"]
    assert "_T" not in auto["suggested"]
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    p = c.get("/maps/hall/portal").json()
    assert p["source"] == "manual" and p["confirmed"] and np.allclose(p["position"], [1.2, 0.0, -2.5])
    assert p["suggested"]["source"] == "auto" and p["suggested"]["position"] == auto["position"] and p["suggested"]["confidence"] == auto["confidence"]
    # "use the doorway that was found": stored as `selected`, and it replaces the door placed by hand before
    assert c.put("/maps/hall/anchors/portal", json={"opening_id": auto["opening_id"]}).status_code == 422  # not this call
    r = c.put("/maps/hall/portal", json={"opening_id": auto["opening_id"]}, headers={"X-Device-Id": "staff-phone"})
    assert r.status_code == 200
    p = c.get("/maps/hall/portal").json()
    assert p == r.json() and p["source"] == "selected" and p["confirmed"] is True and p["opening_id"] == auto["opening_id"]
    assert np.allclose(p["position"], auto["position"]) and (p["width"], p["height"]) == (auto["width"], auto["height"])
    assert p["placed_by"] == "staff-phone" and p["updated_utc"]
    assert c.put("/maps/hall/portal", json={"opening_id": "o99"}).status_code == 404
    # a door placed by hand afterwards wins again
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    assert c.get("/maps/hall/portal").json()["source"] == "manual"
    # "remove the door": one call, whatever it was; the suggestion stays
    r = c.delete("/maps/hall/portal")
    assert r.status_code == 200 and r.json()["deleted"] is True
    p = c.get("/maps/hall/portal").json()
    assert p["source"] == "auto" and p["confirmed"] is False and p == r.json()["portal"]
    assert c.delete("/maps/hall/portal").json()["deleted"] is False


# ------------------------------------------------------------------ the visitor --- #
def test_a_visitor_gets_rooms_plan_and_the_door_with_its_size(tmp_path, plan):
    c = make_server(tmp_path, room=plan)
    build(c, "hall", session_id="ar-7", label="Main hall")
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"}, headers={"X-Device-Id": "staff-phone", "X-Device-Role": "staff"})
    v = {"X-Device-Id": "visitor-1", "X-Device-Name": "Visitor", "X-Device-Role": "visitor"}
    rooms = {m["map_id"]: m for m in c.get("/maps", headers=v).json()["maps"]}
    assert rooms["hall"]["label"] == "Main hall" and rooms["hall"]["portal_confirmed"] and not rooms["metric_room"]["portal_confirmed"]
    assert c.get("/maps/hall/room", headers=v).json()["room"]["status"] == "ok"
    true = g.Sim3(1.0, g.viro_euler_to_rotmat([0, -35, 0]), np.array([0.8, 0.25, -1.2]))  # the visitor's own AR world
    al = localize(c, "hall", "visit-1", true, [0.0, 1.5, 0.0], [0, 10, 0], v)["alignment"]
    assert al["status"] == "ok"
    door = al["portal"]
    assert door["frame"] == "arworld" and door["source"] == "manual" and door["confirmed"] is True
    assert (door["width"], door["height"]) == (0.9, 2.05)
    assert np.allclose(door["position"], true.apply(np.array([1.2, 0.0, -2.5])), atol=1e-6)
    assert np.allclose(al["anchors"]["portal"]["position"], door["position"])  # v1 clients read it here
    assert np.allclose(door["suggested"]["position"], true.apply(np.array(c.get("/maps/hall/portal").json()["suggested"]["position"])), atol=1e-4)
    roles = {d["device_id"]: d["role"] for d in c.get("/devices").json()["devices"]}
    assert roles["visitor-1"] == "visitor" and roles["staff-phone"] == "staff"


def test_the_flow_strip_of_a_visitor_has_no_scan_and_asks_for_the_staffs_door():
    mon = Monitor(None)
    mon.touch("visitor-1", "10.0.0.7", "GET", "/maps", 200, 2.0, role="visitor")
    devices = mon.list_devices()
    hall = {"map_id": "hall", "label": "Main hall", "num_images": 30, "room_status": "ok", "portal_source": "auto", "portal_size": None}
    flow = usage_flow(devices, [hall], [], mon)
    assert [s["key"] for s in flow["steps"]] == ["connect", "room", "doorway", "localize", "portal"]
    door = flow["steps"][2]
    assert door["status"] == "problem" and "staff" in flow["next"]
    flow = usage_flow(devices, [dict(hall, portal_source="manual", portal_size=[0.9, 2.05])], [], mon)
    assert flow["steps"][2]["status"] == "done" and "0.90 x 2.05 m" in flow["steps"][2]["detail"]
    # a device without a role keeps the scanning flow; a doorway that was only found is not "done" any more
    mon.touch("staff-1", "10.0.0.8", "GET", "/maps", 200, 2.0)
    flow = usage_flow(mon.list_devices(), [hall], [], mon, prefer_device="staff-1")
    assert [s["key"] for s in flow["steps"]] == ["connect", "scan", "build", "doorway", "localize", "portal"]
    assert flow["steps"][3]["status"] == "active" and "suggests" in flow["steps"][3]["detail"]


# ------------------------------------------------------------ rooms: housekeeping --- #
def test_rename_a_room_and_attach_its_place_at_an_external_service(tmp_path):
    c = make_server(tmp_path)
    r = c.patch("/maps/metric_room", json={"label": "  Exhibition 2  "})
    assert r.status_code == 200 and r.json()["label"] == "Exhibition 2"
    r = c.patch("/maps/metric_room", json={"vps": {"location_id": "loc_123"}})
    assert r.status_code == 200
    got = c.get("/maps/metric_room").json()["vps"]
    assert got["provider"] == "reactvision" and got["location_id"] == "loc_123" and got["bridge"] is None and got["updated_utc"]
    assert {m["map_id"]: m for m in c.get("/maps").json()["maps"]}["metric_room"]["vps"]["location_id"] == "loc_123"
    assert json.loads((tmp_path / "maps" / "metric_room" / "map.json").read_text(encoding="utf-8"))["label"] == "Exhibition 2"
    for bad in ({}, {"map_id": "x"}, {"label": 5}, {"label": "x" * 81}, {"vps": {"door": {}}}, {"vps": {"location_id": ""}},
                {"vps": {"location_id": "a", "door": {"position": [1, 0, 2], "quaternion_xyzw": [0, 0, 0, 1]}}}, {"vps": {"location_id": "a", "api_key": "secret"}}):
        assert c.patch("/maps/metric_room", json=bad).status_code == 422, bad
    assert c.patch("/maps/metric_room", json={"label": None, "vps": None}).status_code == 200
    got = c.get("/maps/metric_room").json()
    assert got["label"] is None and got["vps"] is None
    assert c.patch("/maps/nope", json={"label": "x"}).status_code == 404


def test_a_new_scan_keeps_the_rooms_name_and_drops_the_door(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7", label="Main hall")
    c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"})
    c.patch("/maps/hall", json={"vps": {"location_id": "loc_9"}})
    build(c, "hall", session_id="ar-9", replace="true")  # scanned again, no label sent this time
    m = c.get("/maps/hall").json()
    assert m["label"] == "Main hall" and m["vps"]["location_id"] == "loc_9" and m["recording_session_id"] == "ar-9"
    assert c.get("/maps/hall/portal").json()["source"] == "none"  # the old door stood in the old scan's frame
    assert c.put("/maps/hall/anchors/portal", json={**DOOR, "session_id": "ar-7"}).status_code == 422


def test_delete_a_room_moves_it_to_the_trash(tmp_path):
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-7")
    true = g.Sim3(1.0, np.eye(3), np.zeros(3))
    localize(c, "hall", "visit-1", true, [0.0, 1.5, 0.0], [0, 10, 0])
    r = c.delete("/maps/hall")
    assert r.status_code == 200 and r.json()["deleted"] == "hall" and r.json()["kept_as"].startswith(".trash/hall-")
    assert (tmp_path / "maps" / r.json()["kept_as"] / "map.json").exists() and not (tmp_path / "maps" / "hall").exists()
    assert "hall" not in {m["map_id"] for m in c.get("/maps").json()["maps"]}
    assert c.get("/maps/hall").status_code == 404 and c.get("/sessions/visit-1").status_code == 404
    assert c.delete("/maps/hall").status_code == 404
    assert c.post("/maps/reload").json()["maps"] == ["metric_room"]  # the trash is not a map
    build(c, "hall", session_id="ar-8")  # the id is free again


def test_health_announces_the_new_parts(tmp_path):
    h = make_server(tmp_path).get("/health").json()
    assert h["api_version"] == 1 and h["api_revision"] >= 3 and {"staff_door", "door_size", "rooms_admin"} <= set(h["capabilities"])
