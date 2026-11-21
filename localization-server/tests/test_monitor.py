"""Devices, device log and the monitoring panel (docs/api-v2.md section 9)."""

import json
import re

import cv2
import numpy as np

from locserver.monitor import MAX_BATCH_BYTES, MAX_BATCH_EVENTS, Monitor, usage_flow
from locserver.server import UI_FILE

HEADERS = {"X-Device-Id": "phone-1", "X-Device-Name": "Xiaomi%2014%20Ultra", "X-Session-Id": "run-1", "X-App-Version": "0.3.0 (12)"}


def batch(first=1, n=3, session="run-1", t_ms=1_000_000, **extra):
    events = [{"seq": first + i, "t_ms": t_ms + i, "level": "info", "type": "scan", "message": f"event {first + i}"} for i in range(n)]
    return {"session_id": session, "sent_at_ms": t_ms + n, "events": events, **extra}


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


# -------------------------------------------------------------------- unit --- #
def test_requests_are_booked_on_the_device_named_in_the_headers():
    clock = Clock()
    mon = Monitor(clock=clock)
    assert mon.touch("phone-1", "192.168.1.20", "GET", "/health", 200, 3.14159, "Xiaomi%2014%20Ultra", "run-1", "0.3.0") == "phone-1"
    assert mon.touch(None, "192.168.1.30", "GET", "/health", 200, 1.0) == "ip-192-168-1-30"
    assert mon.touch("not a valid id!", "192.168.1.30", "GET", "/maps", 200, 1.0) == "ip-192-168-1-30"
    clock.t += 4
    mon.touch("phone-1", "192.168.1.20", "GET", "/maps", 200, 2.0)
    newest, other = mon.list_devices()
    assert newest["device_id"] == "phone-1" and newest["name"] == "Xiaomi 14 Ultra" and newest["address"] == "192.168.1.20"
    assert newest["requests"] == 2 and newest["last_request"] == "GET /maps" and newest["server_ms"] == 2.0
    assert newest["session_id"] == "run-1" and newest["app_version"] == "0.3.0" and newest["identified"] and newest["online"]
    assert other["device_id"] == "ip-192-168-1-30" and other["requests"] == 2 and not other["identified"] and other["online"]
    assert other["last_seen_age_s"] == 4.0 and "_seq" not in other and "last_seen" not in other
    clock.t += 7  # the anonymous client was last seen 11 s ago: lost; the phone 7 s ago: still on
    state = {d["device_id"]: d["online"] for d in mon.list_devices()}
    assert state == {"phone-1": True, "ip-192-168-1-30": False}


def test_log_batches_are_deduplicated_by_seq_per_session(tmp_path):
    clock = Clock()
    mon = Monitor(tmp_path, clock=clock)
    r = mon.ingest("phone-1", batch(1, 3, rtt_ms=14, device_name="Pixel", state={"step": "scanning", "detail": "recording 00:42"}), "10.0.0.5")
    assert r == {"accepted": 3, "duplicates": 0, "skipped": 0, "last_seq": 3, "server_time_ms": 1_000_000}
    # the same batch retried with one new event at the end
    r = mon.ingest("phone-1", batch(1, 4))
    assert (r["accepted"], r["duplicates"], r["last_seq"]) == (1, 3, 4)
    # a new session starts counting again
    assert mon.ingest("phone-1", batch(1, 2, session="run-2"))["accepted"] == 2
    d = mon.list_devices()[0]
    assert d["name"] == "Pixel" and d["rtt_ms"] == 14.0 and d["state"]["step"] == "scanning" and d["session_id"] == "run-2"
    assert d["address"] == "10.0.0.5" and d["errors"] == 0
    log = mon.device_log("phone-1")
    assert [e["seq"] for e in log["events"]] == [1, 2, 3, 4, 1, 2] and log["last_id"] == log["events"][-1]["id"]
    assert [e["seq"] for e in mon.device_log("phone-1", after=log["events"][3]["id"])["events"]] == [1, 2]
    assert mon.device_log("phone-1", after=log["last_id"]) == {"device_id": "phone-1", "events": [], "last_id": log["last_id"]}
    # every accepted event is on disk too, one JSON object per line
    lines = (tmp_path / "device-logs" / "phone-1.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 6 and json.loads(lines[0])["message"] == "event 1"


def test_device_times_are_translated_to_the_server_clock():
    mon = Monitor(clock=Clock(2000.0))  # server: 2,000,000 ms; device clock is 5 s behind
    mon.ingest("phone-1", {"session_id": "s", "sent_at_ms": 1_995_000, "events": [{"seq": 1, "t_ms": 1_994_000, "message": "x"}]})
    assert mon.list_devices()[0]["clock_offset_ms"] == 5000
    assert mon.device_log("phone-1")["events"][0]["server_time_ms"] == 1_999_000


def test_bad_events_are_skipped_and_bad_batches_refused():
    mon = Monitor(clock=Clock())
    events = [
        {"seq": 1, "t_ms": 1, "message": "ok", "level": "error", "data": {"attempt": 2}},
        {"seq": "2", "t_ms": 1, "message": "seq is not an integer"},
        {"seq": 3, "message": "no time"},
        {"seq": 4, "t_ms": 1, "message": "   "},
        "not an object",
        {"seq": 5, "t_ms": 1, "message": "m" * 900, "level": "shout", "type": None, "data": {"blob": "x" * 5000}},
    ]
    r = mon.ingest("phone-1", {"session_id": "s", "sent_at_ms": 1, "events": events})
    assert (r["accepted"], r["skipped"], r["last_seq"]) == (2, 4, 5)
    first, last = mon.device_log("phone-1")["events"]
    assert first["level"] == "error" and first["data"] == {"attempt": 2} and mon.list_devices()[0]["errors"] == 1
    assert len(last["message"]) == 500 and last["level"] == "info" and last["type"] == "app" and "dropped" in last["data"]
    for bad in ({"events": []}, {"session_id": "s"}, {"session_id": "s", "events": {}}, {"session_id": "bad id", "events": []}, []):
        try:
            mon.ingest("phone-1", bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad}")


def test_buffers_are_bounded():
    mon = Monitor(max_events=50, max_feed=80, clock=Clock())
    for start in range(1, 400, 100):
        mon.ingest("phone-1", batch(start, 100))
    events = mon.device_log("phone-1", limit=1000)["events"]
    assert len(events) == 50 and events[-1]["seq"] == 400
    feed = mon.feed_after(0, limit=1000)
    assert len(feed["entries"]) == 80 and feed["last_id"] == 400
    assert mon.feed_after(feed["last_id"])["entries"] == []


# --------------------------------------------------------------------- flow --- #
MAP = {"map_id": "room", "num_images": 30, "room_status": "ok", "portal_source": "manual", "portal_size": [0.9, 2.0]}  # door placed by the staff


def job(state="running", **kw):
    return {"kind": "build_map", "map_id": "room", "state": state, "progress": 0.42, "stage": "matching", "eta_s": 60, "error": None, **kw}


def flow(devices=(), maps=(), jobs=(), monitor=None):
    f = usage_flow(list(devices), list(maps), list(jobs), monitor or Monitor(clock=Clock()))
    return {s["key"]: s["status"] for s in f["steps"]}, f


def device(mon, step=None, **state):
    mon.ingest("phone-1", {"session_id": "s", "sent_at_ms": 1, "events": [], "state": {"step": step, **state} if step else {}})
    return mon.list_devices()


def test_usage_flow_follows_the_scenario():
    st, f = flow()
    assert st == {"connect": "active", "scan": "todo", "build": "todo", "doorway": "todo", "localize": "todo", "portal": "todo"}
    assert "Start the app" in f["next"] and f["device_id"] is None

    clock = Clock()
    mon = Monitor(clock=clock)
    st, f = flow(device(mon, "scanning", detail="recording 00:42"), monitor=mon)
    assert (st["connect"], st["scan"], st["build"]) == ("done", "active", "todo") and f["steps"][1]["detail"] == "recording 00:42"

    st, f = flow(device(mon, "building"), jobs=[job()], monitor=mon)
    assert (st["scan"], st["build"], st["doorway"]) == ("done", "active", "todo")
    assert "matching - 42 %" in f["steps"][2]["detail"] and f["map_id"] == "room"

    st, f = flow(device(mon, "ready"), [MAP], [job("succeeded")], mon)
    assert (st["build"], st["doorway"], st["localize"]) == ("done", "done", "todo") and "Point the phone" in f["next"]

    # without the staff's door the step stays open: a doorway the server only found is a suggestion
    for source, word in (("none", "no door yet"), ("auto", "suggests")):
        st, f = flow(device(mon, "ready"), [{**MAP, "portal_source": source, "portal_size": None}], [job("succeeded")], mon)
        assert st["doorway"] == "active" and word in f["steps"][3]["detail"] and "staff mode" in f["next"]

    st, f = flow(device(mon, "ready"), [], [job("failed", error={"code": "sfm_failed", "message": "SfM failed"})], mon)
    assert st["build"] == "problem" and f["steps"][2]["detail"] == "SfM failed"

    mon.record_localization({"device_id": "phone-1", "map_id": "room", "success": False, "quality": "failed", "reason": "too few matches"})
    st, f = flow(device(mon, "localizing"), [MAP], [job("succeeded")], mon)
    assert st["localize"] == "problem" and f["steps"][4]["detail"] == "too few matches"

    mon.record_localization({"device_id": "phone-1", "map_id": "room", "success": True, "quality": "good", "num_inliers": 200})
    st, f = flow(device(mon, "portal_placed"), [MAP], [job("succeeded")], mon)
    assert set(st.values()) == {"done"} and "walk through" in f["next"]

    clock.t += 60  # the phone went away
    st, f = flow(mon.list_devices(), [MAP], [job("succeeded")], mon)
    assert st["connect"] == "problem" and "60 s ago" in f["steps"][0]["detail"]


# ---------------------------------------------------------------------- API --- #
def test_headers_register_a_device_and_the_panel_is_not_one(api):
    assert api.get("/health", headers=HEADERS).status_code == 200
    assert api.get("/maps", headers=HEADERS).status_code == 200
    assert api.get("/ui").status_code == 200 and api.get("/monitor/state").status_code == 200
    assert api.get("/monitor/feed").status_code == 200
    devices = api.get("/devices").json()["devices"]  # this request itself comes from an unnamed client
    by_id = {d["device_id"]: d for d in devices}
    phone = by_id["phone-1"]
    assert phone["name"] == "Xiaomi 14 Ultra" and phone["requests"] == 2 and phone["last_request"] == "GET /maps" and phone["online"]
    assert phone["app_version"] == "0.3.0 (12)" and phone["session_id"] == "run-1" and phone["server_ms"] >= 0
    feed = api.get("/monitor/feed").json()
    paths = [e["path"] for e in feed["entries"] if e["kind"] == "request"]
    assert paths[:2] == ["/health", "/maps"] and not [p for p in paths if p.startswith(("/ui", "/monitor"))]
    assert {"device_log", "monitor_ui"} <= set(api.get("/health").json()["capabilities"])
    assert api.delete("/devices/phone-1").json() == {"deleted": "phone-1"} and api.delete("/devices/phone-1").status_code == 404
    assert "phone-1" not in {d["device_id"] for d in api.get("/devices").json()["devices"]}


def test_device_log_endpoint(api):
    r = api.post("/devices/phone-1/log", json=batch(1, 3, state={"step": "scanning"}), headers=HEADERS)
    assert r.status_code == 200 and r.json()["accepted"] == 3 and r.json()["last_seq"] == 3
    assert api.post("/devices/phone-1/log", json=batch(2, 3)).json()["duplicates"] == 2
    log = api.get("/devices/phone-1/log").json()
    assert [e["seq"] for e in log["events"]] == [1, 2, 3, 4] and log["events"][0]["device_id"] == "phone-1"
    assert api.get("/devices/phone-1/log", params={"after": log["events"][1]["id"]}).json()["events"][0]["seq"] == 3
    assert api.get("/devices/nobody/log").status_code == 404
    feed = api.get("/monitor/feed", params={"after": 0}).json()
    assert {"device", "request"} == {e["kind"] for e in feed["entries"]} and feed["last_id"] >= feed["entries"][-1]["id"]
    assert api.get("/monitor/feed", params={"after": feed["last_id"]}).json()["entries"] == []
    # refusals
    assert api.post("/devices/bad id/log", json=batch()).status_code == 422
    assert api.post("/devices/phone-1/log", json={"events": []}).status_code == 422
    assert api.post("/devices/phone-1/log", content=b"{not json", headers={"Content-Type": "application/json"}).status_code == 422
    assert api.post("/devices/phone-1/log", json=batch(100, MAX_BATCH_EVENTS + 1)).status_code == 413
    big = batch(500, 1)
    big["events"][0]["data"] = {"blob": "x" * (MAX_BATCH_BYTES + 10)}
    assert api.post("/devices/phone-1/log", json=big).status_code == 413
    assert (api.state_obj.work_dir / "device-logs" / "phone-1.jsonl").exists()


def test_localizations_are_recorded_for_the_panel(api):
    jpeg = cv2.imencode(".jpg", np.zeros((48, 64, 3), np.uint8))[1].tobytes()
    api.stub.queue.append(np.array([[1, 0, 0, -2.0], [0, -1, 0, 1.5], [0, 0, -1, 0.0], [0, 0, 0, 1.0]]))
    for _ in range(2):  # the second call has no pose queued: a failed localisation
        r = api.post("/localize", files={"image": ("q.jpg", jpeg, "image/jpeg")}, data={"map_id": "metric_room"}, headers=HEADERS)
        assert r.status_code == 200, r.text
    state = api.get("/monitor/state").json()
    failed, ok = state["localizations"]  # newest first
    assert ok["success"] and ok["quality"] == "good" and ok["device_id"] == "phone-1" and ok["map_id"] == "metric_room"
    assert ok["num_inliers"] == 200 and ok["elapsed_ms"] >= 0 and np.allclose(ok["position"], [2.0, 1.5, 0.0])
    assert np.allclose(ok["forward"], [0, 0, -1]) and not failed["success"] and failed["reason"] == "stub: no pose" and failed["position"] is None
    # the summary the panel polls
    assert state["server"]["version"] and state["server"]["port"] and state["server"]["uptime_s"] >= 0
    assert {m["map_id"] for m in state["maps"]} == {"metric_room", "scaleless_room"} and state["jobs"] == []
    assert state["devices"][0]["device_id"] == "phone-1" and state["flow"]["device_id"] == "phone-1"
    assert [s["key"] for s in state["flow"]["steps"]] == ["connect", "scan", "build", "doorway", "localize", "portal"]
    assert state["last_id"] == api.get("/monitor/feed").json()["last_id"]
    # the device id sent as a form field is used when there is no header
    api.post("/localize", files={"image": ("q.jpg", jpeg, "image/jpeg")}, data={"map_id": "metric_room", "device_id": "tablet"})
    assert api.get("/monitor/state").json()["localizations"][0]["device_id"] == "tablet"


def test_map_view_for_the_panel(api):
    jpeg = cv2.imencode(".jpg", np.zeros((48, 64, 3), np.uint8))[1].tobytes()
    v = api.get("/monitor/map/metric_room").json()
    assert v["map_id"] == "metric_room" and v["metric"] and len(v["up"]) == 3 and v["last_localization"] is None
    assert len(v["points"]) == 80 and len(v["cameras"]) == 3 and v["room"]["status"] == "unavailable" and v["portal"]["source"] == "none"
    assert len(api.get("/monitor/map/metric_room", params={"max_points": 10}).json()["points"]) == 10
    assert api.get("/monitor/map/nope").status_code == 404
    api.stub.queue.append(np.array([[1, 0, 0, -2.0], [0, -1, 0, 1.5], [0, 0, -1, 0.0], [0, 0, 0, 1.0]]))
    api.post("/localize", files={"image": ("q.jpg", jpeg, "image/jpeg")}, data={"map_id": "metric_room"})
    assert api.get("/monitor/map/metric_room").json()["last_localization"]["success"]


def test_the_panel_page_loads_nothing_from_the_internet(api):
    r = api.get("/ui")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html") and "<canvas" in r.text
    page = UI_FILE.read_text(encoding="utf-8")
    assert r.text == page
    urls = [u for u in re.findall(r"""(?:https?:)?//[\w.-]+\.[a-z]{2,}[^\s"'<>)]*""", page) if "www.w3.org" not in u]
    assert urls == [], f"the panel must work offline, found {urls}"
    assert not re.search(r"<script[^>]+src=|<link[^>]+href=|@import|url\(", page)


# ------------------------------------------------------- locserver-panel --- #
def test_panel_command_opens_an_app_window_or_falls_back(monkeypatch, capsys):
    from locserver import panel

    started, opened = [], []
    monkeypatch.setattr(panel.subprocess, "Popen", lambda cmd, **kw: started.append(cmd))
    monkeypatch.setattr(panel.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.setattr(panel, "check_server", lambda base, timeout=3.0: (True, f"server at {base}"))
    monkeypatch.setattr(panel, "find_app_browser", lambda: "C:/Edge/msedge.exe")
    assert panel.main(["--port", "8078"]) == 0
    assert started == [["C:/Edge/msedge.exe", "--app=http://127.0.0.1:8078/ui", "--window-size=1500,950"]] and not opened
    assert "in a window of msedge" in capsys.readouterr().out
    # no Chromium browser installed -> the default browser
    monkeypatch.setattr(panel, "find_app_browser", lambda: None)
    assert panel.main(["--url", "192.168.1.50:8077/ui"]) == 0
    assert opened == ["http://192.168.1.50:8077/ui"] and len(started) == 1
    assert panel.main(["--tab"]) == 0 and opened[-1].endswith("/ui") and len(started) == 1
    # a server that does not answer: say so and open nothing
    monkeypatch.setattr(panel, "check_server", lambda base, timeout=3.0: (False, "no answer"))
    assert panel.main([]) == 1 and len(opened) == 2
    assert "no answer" in capsys.readouterr().out


def test_panel_command_recognises_the_server(monkeypatch):
    import io

    from locserver import SERVICE_ID, panel

    def answer(health):
        monkeypatch.setattr(panel.urllib.request, "urlopen", lambda url, timeout=0: io.BytesIO(json.dumps(health).encode()))
        return panel.check_server("http://127.0.0.1:1")

    assert answer({"service": SERVICE_ID, "version": "0.3.0", "capabilities": ["monitor_ui"], "server_name": "pc"})[0]
    ok, message = answer({"service": SERVICE_ID, "version": "0.2.0", "capabilities": ["jobs"]})
    assert not ok and "older than the panel" in message
    assert not answer({"service": "something else"})[0]

    def refuse(url, timeout=0):
        raise OSError("connection refused")

    monkeypatch.setattr(panel.urllib.request, "urlopen", refuse)
    ok, message = panel.check_server("http://127.0.0.1:1")
    assert not ok and "locserver-serve" in message


def test_flow_follows_the_most_telling_device_or_the_one_asked_for(api):
    from locserver.monitor import pick_device

    api.get("/health")  # an unnamed client, e.g. a browser
    api.post("/devices/phone-1/log", json=batch(1, 1, state={"step": "scanning"}), headers=HEADERS)
    api.get("/health")  # the unnamed client is the newest again
    devices = api.get("/monitor/state").json()["devices"]
    assert devices[0]["device_id"].startswith("ip-") and pick_device(devices)["device_id"] == "phone-1"
    assert api.get("/monitor/state").json()["flow"]["device_id"] == "phone-1"
    anon = devices[0]["device_id"]
    assert api.get("/monitor/state", params={"device": anon}).json()["flow"]["device_id"] == anon
    assert api.get("/monitor/state", params={"device": "gone"}).json()["flow"]["device_id"] == "phone-1"
    assert pick_device([]) is None
    # the panel's Forget button
    assert api.post(f"/monitor/forget/{anon}").json() == {"deleted": anon}
    assert api.post(f"/monitor/forget/{anon}").json() == {"deleted": None}
    assert [d["device_id"] for d in api.get("/monitor/state").json()["devices"]] == ["phone-1"]


# ------------------------------------------------------ stalls of the server --- #
def test_watchdog_reports_a_stalled_event_loop(tmp_path):
    from locserver.monitor import LoopWatchdog

    clock = Clock(100.0)
    wd = LoopWatchdog(tmp_path, limit_s=2.0, clock=clock)
    clock.t = 101.0  # one second without a beat is nothing
    wd.check()
    assert wd.public()["count"] == 0 and not (tmp_path / "stalls.log").exists()
    clock.t = 103.5
    wd.check()
    p = wd.public()
    assert (p["count"], p["last_s"], p["longest_s"]) == (1, 3.5, 3.5) and p["last_utc"] and p["report"].endswith("stalls.log")
    report = (tmp_path / "stalls.log").read_text(encoding="utf-8")
    assert "event loop silent for 3.5 s" in report and "test_monitor.py" in report  # the stack of this very thread
    clock.t = 110.0  # still stalled: the same stall, no second report
    wd.check()
    assert wd.public()["count"] == 1 and wd.public()["longest_s"] == 10.0
    wd.beat, clock.t = 112.8, 113.0  # the loop turns again
    wd.check()
    assert wd.public()["last_s"] == 12.8 and wd.public()["longest_s"] == 12.8
    wd.beat = clock.t = 120.0
    wd.check()
    clock.t = 123.0  # a second, shorter stall
    wd.check()
    assert wd.public()["count"] == 2 and wd.public()["last_s"] == 3.0 and wd.public()["longest_s"] == 12.8
    assert (tmp_path / "stalls.log").read_text(encoding="utf-8").count("=====") == 4


def test_running_server_has_a_beating_watchdog(maps_dir, tmp_path):
    import time

    from fastapi.testclient import TestClient

    from conftest import StubLocalizer, StubPipe
    from locserver.server import State, create_app

    state = State(maps_dir, pipe=StubPipe(), localizer=StubLocalizer(), calibration_dir=tmp_path / "calib", work_dir=tmp_path / "work")
    with TestClient(create_app(state)) as c:  # the context manager runs the start-up handlers
        first = state.watchdog.beat
        time.sleep(0.6)
        stalls = c.get("/monitor/state").json()["server"]["stalls"]
        assert state.watchdog.beat > first and stalls["count"] == 0 and stalls["limit_s"] == 2.0


def test_a_slow_disk_does_not_block_the_job_queries(tmp_path):
    """`jobs.json` is written without holding the lock that `/health` and `/jobs/...` need."""
    import threading

    from locserver.jobs import JobManager

    jm = JobManager(tmp_path / "maps", tmp_path / "work", runner=lambda job: {"map_id": job.map_id})
    with jm._io_lock:  # a disk write that does not come back
        writer = threading.Thread(target=jm._save, daemon=True)
        writer.start()
        got = {}
        reader = threading.Thread(target=lambda: got.update(counts=jm.counts(), jobs=jm.list()), daemon=True)
        reader.start()
        reader.join(2.0)
        assert not reader.is_alive() and got["counts"] == {"running": 0, "queued": 0}
        assert writer.is_alive()  # the writer is the one that waits
    writer.join(2.0)
    assert not writer.is_alive() and (tmp_path / "work" / "jobs" / "jobs.json").exists()
