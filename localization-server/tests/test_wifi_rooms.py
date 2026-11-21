"""The API of the Wi-Fi hint: the staff phone leaves the networks with a room, /localize finds the room itself."""

from __future__ import annotations

import json

import numpy as np

from locserver import geometry as g
from test_staff_door import build, jpeg, make_server
from test_wifi_hint import ELSEWHERE, HALL, SIDE

POSE = g.make_T(np.eye(3), [0.0, 0.0, 0.0])


def three_rooms(tmp_path):
    """metric_room (no fingerprint), hall and side (fingerprints sent by the staff phone with the recording)."""
    c = make_server(tmp_path)
    build(c, "hall", session_id="ar-1", label="Main hall", wifi=json.dumps(HALL))
    build(c, "side", session_id="ar-2", label="Side room", wifi=json.dumps({"networks": SIDE}))
    return c


def look(c, wifi=None, **data):
    """One /localize that does not say which room."""
    if wifi is not None:
        data["wifi"] = wifi if isinstance(wifi, str) else json.dumps(wifi)
    r = c.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data=data)
    assert r.status_code == 200, r.text
    return r.json()


def test_the_staff_phone_leaves_the_networks_with_the_room_and_nobody_gets_them_back(tmp_path):
    c = three_rooms(tmp_path)
    rooms = {m["map_id"]: m for m in c.get("/maps").json()["maps"]}
    assert rooms["hall"]["wifi"]["networks"] == 3 and rooms["hall"]["wifi"]["scans"] == 1 and rooms["metric_room"]["wifi"] is None
    r = c.put("/maps/hall/wifi", json={"networks": [{"bssid": "aa:bb:cc:00:00:05", "rssi": -70}]})  # a second look adds up
    assert r.status_code == 200 and r.json()["wifi"]["networks"] == 4 and r.json()["wifi"]["scans"] == 2
    everything = json.dumps([c.get("/maps").json(), c.get("/maps/hall").json(), c.get("/jobs").json(), c.get("/health").json(),
                             c.post("/maps/candidates", json={"wifi": HALL}).json()]).lower()
    assert "aa:bb:cc" not in everything and "museum" not in everything
    stored = (tmp_path / "maps" / "hall" / "map.json").read_text(encoding="utf-8")
    assert "aa:bb:cc:00:00:05" in stored and "museum" not in stored  # in the room's folder only, and without the names
    # a new scan of the room without a list keeps what is known; with a list it starts over
    build(c, "hall", session_id="ar-3", replace="true")
    assert c.get("/maps/hall").json()["wifi"]["networks"] == 4
    build(c, "hall", session_id="ar-4", replace="true", wifi=json.dumps(ELSEWHERE))
    assert c.get("/maps/hall").json()["wifi"]["networks"] == 1
    assert c.put("/maps/hall/wifi", json={"networks": HALL, "replace": True}).json()["wifi"]["networks"] == 3
    for bad in ({}, {"networks": []}, {"networks": [{"bssid": "nonsense"}]}, {"networks": HALL, "password": "x"},
                {"networks": [{"bssid": "02:00:00:00:00:00"}]}):
        assert c.put("/maps/hall/wifi", json=bad).status_code == 422, bad
    assert c.put("/maps/nope/wifi", json={"networks": HALL}).status_code == 404
    r = c.delete("/maps/hall/wifi")
    assert r.json()["deleted"] is True and c.get("/maps/hall").json()["wifi"] is None and c.delete("/maps/hall/wifi").json()["deleted"] is False
    bad_upload = c.post("/maps/x/recording", data={"wifi": "not json"}, files={"video": ("v.mp4", b"0"), "session_jsonl": ("s.jsonl", b"0")})
    assert bad_upload.status_code == 422


def test_the_networks_only_order_the_rooms_the_picture_decides(tmp_path):
    c = three_rooms(tmp_path)
    loc = c.state_obj.localizer
    # standing in the hall: the hall is tried first, and one attempt is enough
    loc.queue.append(POSE)
    out = look(c, HALL)
    rc = out["room_choice"]
    assert out["map_id"] == "hall" and out["success"] and rc["mode"] == "auto" and rc["hint"] == "wifi" and rc["networks_sent"] == 3
    assert [x["map_id"] for x in rc["candidates"]] == ["hall", "side", "metric_room"] and rc["rooms_tried"] == 1 and rc["chosen"] == "hall"
    assert rc["candidates"][0]["tried"] and rc["candidates"][0]["success"] and rc["candidates"][0]["label"] == "Main hall"
    assert rc["candidates"][1]["tried"] is False and "aa:bb" not in json.dumps(out)
    assert out["frame_id"] == c.get("/maps/hall").json()["frame_id"]
    # the hint points to the side room, but the picture is not from there: the next candidate is taken
    loc.queue += [None, POSE]
    out = look(c, SIDE)
    rc = out["room_choice"]
    assert [x["map_id"] for x in rc["candidates"]][:2] == ["side", "hall"] and rc["rooms_tried"] == 2
    assert out["map_id"] == "hall" and out["success"] and rc["candidates"][0]["success"] is False
    # max_rooms bounds the work; with nothing found the answer is still an answer, for the most likely room
    n = len(loc.calls)
    out = look(c, HALL, max_rooms=1)
    assert out["success"] is False and out["map_id"] == "hall" and out["room_choice"]["rooms_tried"] == 1 and len(loc.calls) == n + 1
    out = look(c, HALL, max_rooms=99)
    assert out["room_choice"]["rooms_tried"] == 3 and out["success"] is False


def test_without_wifi_the_rooms_are_tried_by_how_alike_the_pictures_are(tmp_path):
    c = three_rooms(tmp_path)
    loc = c.state_obj.localizer
    loc.room_similarity = lambda maps, image: {m.map_id: {"side": 0.8, "metric_room": 0.5, "hall": 0.1}[m.map_id] for m in maps}
    loc.queue.append(POSE)
    out = look(c)
    rc = out["room_choice"]
    assert rc["hint"] == "none" and [x["map_id"] for x in rc["candidates"]] == ["side", "metric_room", "hall"]
    assert out["map_id"] == "side" and rc["candidates"][0]["visual_score"] == 0.8 and rc["candidates"][0]["wifi_score"] is None
    # "auto" says the same as leaving map_id out; networks of a place nobody knows do not bring a room forward
    loc.queue.append(POSE)
    assert look(c, ELSEWHERE, map_id="auto")["map_id"] == "metric_room"  # the only room that cannot be ruled out comes first
    # a broken hint is reported and ignored - it never costs the visitor the localisation
    loc.queue.append(POSE)
    out = look(c, "{not json")
    assert out["success"] and out["room_choice"]["hint"] == "invalid" and out["room_choice"]["hint_error"]
    # if the similarity itself fails, the rooms are still tried
    loc.room_similarity = lambda maps, image: 1 / 0
    loc.queue += [None, None, POSE]
    out = look(c)
    assert out["success"] and out["room_choice"]["rooms_tried"] == 3


def test_a_session_stays_in_its_room_and_a_given_room_is_not_questioned(tmp_path):
    c = three_rooms(tmp_path)
    loc = c.state_obj.localizer
    pose = json.dumps({"position": [0, 1.5, 0], "rotation": [0, 0, 0]})
    loc.queue.append(POSE)
    first = look(c, HALL, session_id="visit-1", ar_pose=pose)
    assert first["map_id"] == "hall" and first["room_choice"]["mode"] == "auto"
    n = len(loc.calls)
    loc.queue.append(POSE)
    again = look(c, SIDE, session_id="visit-1", ar_pose=pose)  # other networks now, same AR session
    assert again["map_id"] == "hall" and again["room_choice"] == {"mode": "session", "hint": "none", "chosen": "hall"}
    assert len(loc.calls) == n + 1 and again["session"]["num_observations"] == 2
    loc.queue.append(POSE)
    given = look(c, HALL, map_id="side")
    assert given["map_id"] == "side" and given["room_choice"] == {"mode": "given", "hint": "none", "chosen": "side"}
    # visitors can be kept to rooms whose door a staff member placed
    c.put("/maps/side/anchors/portal", json={"position": [0, 0, 0], "quaternion_xyzw": [0, 0, 0, 1]})
    loc.queue.append(POSE)
    only = look(c, HALL, only_with_door="true")
    assert only["map_id"] == "side" and only["room_choice"]["mode"] == "only_room"
    c.delete("/maps/side/portal")
    r = c.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"only_with_door": "true"})
    assert r.status_code == 404 and "door" in r.json()["detail"]


def test_candidates_can_be_asked_for_without_a_picture(tmp_path):
    c = three_rooms(tmp_path)
    c.put("/maps/hall/anchors/portal", json={"position": [0, 0, 0], "quaternion_xyzw": [0, 0, 0, 1]})
    r = c.post("/maps/candidates", json={"wifi": HALL}).json()
    assert r["hint"] == "wifi" and [x["map_id"] for x in r["candidates"]] == ["hall", "side", "metric_room"]
    assert r["candidates"][0]["portal_confirmed"] is True and r["candidates"][0]["label"] == "Main hall" and r["candidates"][0]["wifi_matched"] == 3
    assert [x["map_id"] for x in c.post("/maps/candidates", json={"wifi": HALL, "only_with_door": True}).json()["candidates"]] == ["hall"]
    assert c.post("/maps/candidates", json={}).json()["hint"] == "none"
    assert c.post("/maps/candidates", json={"wifi": [{"bssid": "x"}]}).status_code == 422
    h = c.get("/health").json()
    assert "wifi_hint" in h["capabilities"] and h["api_revision"] >= 5
