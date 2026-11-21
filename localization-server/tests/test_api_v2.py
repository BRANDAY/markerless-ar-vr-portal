"""API v2: recording upload as a background job, room plan, automatic doorway."""

import json
import threading

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from conftest import StubLocalizer, StubPipe, make_map
from locserver import jobworker
from locserver.jobs import STAGES, Job, JobError, JobManager
from locserver.roomplan import compute_room_plan
from locserver.roomstage import save_room
from locserver.server import State, create_app
from locserver.synthroom import make_room, make_views


@pytest.fixture(scope="module")
def plan():
    truth = make_room()
    return truth, compute_room_plan(make_views(truth), (0, 1, 0))


def session_jsonl(n=120, header=True) -> bytes:
    lines = [json.dumps({"type": "header", "intrinsics": {"fx": 500, "fy": 500, "cx": 320, "cy": 240, "width": 640, "height": 480}})] if header else []
    lines += [json.dumps({"type": "pose", "t": i * 33_000_000, "orientation": [0, 0, 0, 1], "position": [0.01 * i, 1.4, 0]}) for i in range(n)]
    return ("\n".join(lines) + "\n").encode()


def upload(client, map_id="room", video=b"not really a video", session=None, **data):
    files = {"video": ("video.mp4", video, "video/mp4"), "session_jsonl": ("session.jsonl", session or session_jsonl(), "application/x-ndjson")}
    return client.post(f"/maps/{map_id}/recording", files=files, data={k: str(v) for k, v in data.items()})


def jpeg():
    return cv2.imencode(".jpg", np.zeros((48, 64, 3), np.uint8))[1].tobytes()


def make_server(tmp_path, runner):
    maps = tmp_path / "maps"
    make_map(maps / "metric_room", "metric_room", metric=True)
    state = State(maps, pipe=StubPipe(), localizer=StubLocalizer(), calibration_dir=tmp_path / "calib",
                  work_dir=tmp_path / "work", job_runner=runner and (lambda job: runner(job, maps)))
    client = TestClient(create_app(state))
    client.state_obj = state
    return client


def builder(room=None, fail=None, gate=None):
    """A job runner that "builds" the synthetic map of the fixtures instead of running SfM."""

    def run(job, maps):
        job.report("frames", 1.0, "12 frames selected")
        job.report("matching", 0.5, "matched 5 of 10 image pairs")
        if gate is not None:
            gate.wait(10)
        if fail:
            raise JobError(*fail)
        out = maps / f".build-{job.job_id}" if job.kind == "build_map" else maps / job.map_id
        if job.kind == "build_map":
            make_map(out, job.map_id, metric=True)
        if room is not None:
            save_room(out, room)
        return {"map_id": job.map_id, "num_images": 3, "warnings": []}

    return run


# ------------------------------------------------------------------- jobs --- #
def test_health_announces_v2_without_breaking_v1_clients(tmp_path):
    c = make_server(tmp_path, builder())
    h = c.get("/health").json()
    assert h["api_version"] == 1 and h["api_revision"] == 2  # the current app accepts only api_version 1
    assert {"recording_upload", "jobs", "room_plan", "auto_portal"} <= set(h["capabilities"])
    assert h["jobs"] == {"running": 0, "queued": 0}


def test_recording_upload_builds_a_map_in_the_background(tmp_path, plan):
    c = make_server(tmp_path, builder(room=plan[1]))
    r = upload(c, "room", label="Living room", device_id="pixel7")
    assert r.status_code == 202, r.text
    job = r.json()["job"]
    assert job["kind"] == "build_map" and job["map_id"] == "room" and job["state"] in ("queued", "running", "succeeded")
    assert job["stage_count"] == 7 and 0 <= job["progress"] <= 1
    done = c.state_obj.jobs.wait(job["job_id"])
    assert done["state"] == "succeeded" and done["progress"] == 1.0 and done["error"] is None
    assert done["result"]["map_id"] == "room" and done["finished_utc"] and done["eta_s"] is None
    assert c.get(f"/jobs/{job['job_id']}").json()["state"] == "succeeded"
    assert [j["job_id"] for j in c.get("/jobs", params={"map_id": "room"}).json()["jobs"]] == [job["job_id"]]
    assert c.get("/jobs", params={"map_id": "other"}).json()["jobs"] == [] and c.get("/jobs/nope").status_code == 404
    # the map is loaded, has its plan, and no hidden build directory is left or listed as a map
    maps = {m["map_id"]: m for m in c.get("/maps").json()["maps"]}
    assert set(maps) == {"metric_room", "room"} and maps["room"]["room_status"] == "ok" and maps["room"]["portal_source"] == "auto"
    assert not list((tmp_path / "maps").glob(".build-*"))
    assert (tmp_path / "work" / "jobs" / job["job_id"] / "video.mp4").exists()  # recording kept for a rebuild
    # same id again: refused unless replace=true
    assert upload(c, "room").status_code == 409
    r2 = upload(c, "room", replace="true")
    assert r2.status_code == 202 and c.state_obj.jobs.wait(r2.json()["job"]["job_id"])["state"] == "succeeded"
    assert not (tmp_path / "work" / "jobs" / job["job_id"]).exists()  # only the newest recording of a map is kept


def test_upload_validation(tmp_path, monkeypatch):
    c = make_server(tmp_path, builder())
    assert upload(c, "bad id").status_code == 422
    assert upload(c, "room", max_frames=5).status_code == 422
    assert upload(c, "room", display_rotation_cw=45).status_code == 422
    assert upload(c, "room", session=session_jsonl(header=False)).status_code == 422
    assert upload(c, "room", session=session_jsonl(n=3)).status_code == 422
    assert upload(c, "room", session=b"this is not json\n").status_code == 422
    assert c.post("/maps/room/recording", files={"video": ("v.mp4", b"x", "video/mp4")}).status_code == 422
    monkeypatch.setenv("LOCSERVER_MAX_RECORDING_MB", "1")
    assert upload(c, "room", video=b"x" * (2 * 2**20)).status_code == 413
    assert c.get("/jobs").json()["jobs"] == [] and not list((tmp_path / "work" / "jobs").glob("*/video.mp4"))


def test_failed_build_reports_a_code_and_keeps_the_old_map(tmp_path):
    c = make_server(tmp_path, builder(fail=("sfm_failed", "SfM failed: no model could be initialised")))
    before = c.get("/maps/metric_room").json()["created_utc"]
    job = upload(c, "metric_room", replace="true").json()["job"]
    done = c.state_obj.jobs.wait(job["job_id"])
    assert done["state"] == "failed" and done["error"]["code"] == "sfm_failed" and done["progress"] < 1 and done["result"] is None
    assert c.get("/maps/metric_room").json()["created_utc"] == before and not list((tmp_path / "maps").glob(".build-*"))


def test_queue_positions_conflict_and_cancel(tmp_path):
    gate = threading.Event()
    c = make_server(tmp_path, builder(gate=gate))
    a = upload(c, "room_a").json()["job"]
    b = upload(c, "room_b").json()["job"]
    assert upload(c, "room_a").status_code == 409 and a["job_id"] in upload(c, "room_a").json()["detail"]
    jb = c.get(f"/jobs/{b['job_id']}").json()
    assert jb["state"] == "queued" and jb["queue_position"] == 1 and jb["stage"] is None and jb["eta_s"] is None
    assert c.get("/health").json()["jobs"] == {"running": 1, "queued": 1}
    assert c.post(f"/jobs/{b['job_id']}/cancel").json()["state"] == "cancelled"
    gate.set()
    assert c.state_obj.jobs.wait(a["job_id"])["state"] == "succeeded"
    assert c.get(f"/jobs/{b['job_id']}").json()["state"] == "cancelled" and "room_b" not in c.state_obj.maps
    assert c.post(f"/jobs/{a['job_id']}/cancel").json()["state"] == "succeeded"  # no effect on a finished job
    assert c.post("/jobs/nope/cancel").status_code == 404


def test_progress_is_monotonic_and_weighted():
    job = Job("j", "build_map", "m", {})
    seen = []
    for stage, _ in STAGES["build_map"]:
        for f in (0.0, 0.5, 1.0):
            job.report(stage, f, stage)
            seen.append(job.progress)
    job.report("frames", 0.1)  # a late message of an earlier stage must not move the bar back
    assert seen == sorted(seen) and seen[-1] < 1.0 and job.progress == seen[-1]
    assert sum(w for _, w in STAGES["build_map"]) == pytest.approx(1.0) and sum(w for _, w in STAGES["room_plan"]) == pytest.approx(1.0)
    pub = job.public()
    assert pub["stage"] == "frames" and pub["stage_index"] == 1 and pub["stage_count"] == 7


def test_unfinished_jobs_of_a_stopped_server_are_reported_failed(tmp_path):
    root = tmp_path / "work" / "jobs"
    root.mkdir(parents=True)
    (root / "jobs.json").write_text(json.dumps([{"job_id": "old1", "kind": "build_map", "map_id": "room", "state": "running"},
                                                {"job_id": "old2", "kind": "build_map", "map_id": "x", "state": "succeeded"}]))
    stale = tmp_path / "maps" / ".build-old1"
    stale.mkdir(parents=True)
    jm = JobManager(tmp_path / "maps", tmp_path / "work", runner=lambda job: {})
    assert jm.get("old1")["state"] == "failed" and jm.get("old1")["error"]["code"] == "server_restarted"
    assert jm.get("old2")["state"] == "succeeded" and not stale.exists()


def test_worker_error_codes_and_throttling(capsys):
    assert jobworker.classify(RuntimeError("only 2 usable frames - need a longer or sharper capture")) == "too_few_frames"
    assert jobworker.classify(RuntimeError("SfM failed: no model could be initialised")) == "sfm_failed"
    assert jobworker.classify(MemoryError()) == "out_of_memory" and jobworker.classify(RuntimeError("CUDA out of memory")) == "out_of_memory"
    assert jobworker.classify(ValueError("no pose lines")) == "bad_recording" and jobworker.classify(TypeError("x")) == "internal"
    rep = jobworker.Reporter()
    for k in range(50):
        rep("matching", k / 100, "m")
    rep("matching", 1.0, "done")
    rep("sfm", 0.0, "s")
    lines = [json.loads(ln) for ln in capsys.readouterr().out.splitlines()]
    assert len(lines) <= 5 and lines[-2] == {"stage": "matching", "p": 1.0, "msg": "done"} and lines[-1]["stage"] == "sfm"


def test_real_worker_process_end_to_end(tmp_path):
    """The default runner starts ``python -m locserver.jobworker``. A map without gravity needs no network."""
    c = make_server(tmp_path, None)
    assert c.get("/maps/metric_room/room").json()["room"]["status"] == "unavailable"
    r = c.post("/maps/metric_room/room/rebuild")
    assert r.status_code == 202 and r.json()["job"]["kind"] == "room_plan" and r.json()["job"]["stage_count"] == 3
    done = c.state_obj.jobs.wait(r.json()["job"]["job_id"], timeout=120)
    assert done["state"] == "succeeded", done
    assert done["result"]["room"]["status"] == "unavailable" and "gravity" in done["result"]["warnings"][0]
    assert done["result"]["portal"] == {"source": "none", "opening_id": None, "confidence": None}
    assert "gravity" in c.get("/maps/metric_room/room").json()["room"]["reason"]
    assert c.post("/maps/unknown/room/rebuild").status_code == 404


# ---------------------------------------------------------- room + portal --- #
def localize(c, **data):
    pose = json.dumps({"position": [0.5, 1.5, -1.0], "rotation": [0, 90, 0]})
    # the stub "localises" the camera at (2, 1.5, 0) in the map, upright, looking along map -z
    c.state_obj.localizer.queue.append(np.array([[1, 0, 0, -2.0], [0, -1, 0, 1.5], [0, 0, -1, 0.0], [0, 0, 0, 1.0]]))
    r = c.post("/localize", files={"image": ("q.jpg", jpeg(), "image/jpeg")}, data={"map_id": "metric_room", "ar_pose": pose, **data})
    assert r.status_code == 200, r.text
    return r.json()["alignment"]


def test_room_plan_and_automatic_portal_in_localize(tmp_path, plan):
    truth, room = plan
    c = make_server(tmp_path, builder())
    save_room(tmp_path / "maps" / "metric_room", room)
    got = c.get("/maps/metric_room/room").json()
    assert got["map_id"] == "metric_room" and got["room"]["frame"] == "map" and len(got["room"]["walls"]) == 4
    p = c.get("/maps/metric_room/portal").json()
    assert p["source"] == "auto" and p["opening_id"] == "o0" and p["frame"] == "map" and "_T" not in p
    assert np.allclose(p["position"], truth["door"]["center_bottom"], atol=0.08) and abs(p["width"] - 0.9) < 0.12

    al = localize(c)
    M = np.array(al["T_arworld_from_map"])
    want = M[:3, :3] @ np.array(p["position"]) + M[:3, 3]
    assert al["portal"]["source"] == "auto" and al["portal"]["frame"] == "arworld" and np.allclose(al["portal"]["position"], want, atol=1e-3)
    assert al["anchors"]["portal"]["position"] == al["portal"]["position"]  # what a v1 client reads
    assert al["anchors"]["portal"]["rotation_euler_deg"] == al["portal"]["rotation_euler_deg"]
    r = al["room"]
    assert r["frame"] == "arworld" and r["up"] == [0.0, 1.0, 0.0] and len(r["walls"]) == 4 and len(r["corners"]) == 4
    assert np.allclose(r["openings"][0]["portal_pose"]["position"], al["portal"]["position"], atol=1e-3)
    assert localize(c, include_room="false")["room"] is None

    # a manual anchor wins; deleting it returns to the automatic doorway
    assert c.put("/maps/metric_room/anchors/portal", json={"position": [9, 0, 9], "rotation_euler_deg": [0, 10, 0]}).status_code == 200
    pm = c.get("/maps/metric_room/portal").json()
    assert pm["source"] == "manual" and pm["position"] == [9.0, 0.0, 9.0] and pm["opening_id"] is None and pm["width"] is None
    al = localize(c)
    assert al["portal"]["source"] == "manual" and np.allclose(al["anchors"]["portal"]["position"], M[:3, :3] @ [9, 0, 9] + M[:3, 3], atol=1e-3)
    assert c.delete("/maps/metric_room/anchors/portal").status_code == 200
    assert c.get("/maps/metric_room/portal").json()["source"] == "auto"

    # explicit choice of an opening
    assert c.put("/maps/metric_room/portal", json={"opening_id": "o7"}).status_code == 404
    assert c.put("/maps/metric_room/portal", json={}).status_code == 422
    assert c.put("/maps/metric_room/portal", json={"opening_id": "o0"}).json()["source"] == "selected"
    assert c.put("/maps/metric_room/portal", json={"opening_id": None}).json()["source"] == "auto"
    info = c.get("/maps/metric_room").json()
    assert info["room_status"] == "ok" and info["portal_source"] == "auto"


def test_no_door_found_is_an_honest_none(tmp_path):
    room = compute_room_plan(make_views(make_room(door_closed=True)), (0, 1, 0))
    c = make_server(tmp_path, builder())
    p = c.get("/maps/metric_room/portal").json()
    assert p["source"] == "none" and p["position"] is None and "no room plan" in p["reason"]
    al = localize(c)
    assert al["portal"]["source"] == "none" and "portal" not in al["anchors"] and al["room"] is None
    save_room(tmp_path / "maps" / "metric_room", room)
    p = c.get("/maps/metric_room/portal").json()
    assert p["source"] == "none" and p["position"] is None and p["reason"] == "no door opening was found in this room"
    al = localize(c)
    assert al["portal"]["source"] == "none" and "portal" not in al["anchors"]
    assert al["room"]["status"] == "ok" and al["room"]["openings"] == [] and len(al["room"]["walls"]) == 4
    assert c.get("/maps/metric_room").json()["portal_source"] == "none"


def test_mesh_readers_and_orientation(tmp_path):
    from locserver.roomstage import mesh_points

    # a 2 x 2 m wall patch at z = -1, two triangles; the camera stands at the origin
    v = [(-1, 0, -1), (1, 0, -1), (1, 2, -1), (-1, 2, -1)]
    obj = tmp_path / "wall.obj"
    obj.write_text("".join(f"v {a} {b} {c}\n" for a, b, c in v) + "f 1 2 3\nf 1/1/1 3/3/3 4/4/4\n")
    ply = tmp_path / "wall.ply"
    ply.write_text("ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n"
                   "element face 1\nproperty list uchar int vertex_indices\nend_header\n"
                   + "".join(f"{a} {b} {c}\n" for a, b, c in v) + "4 0 3 2 1\n")
    import struct

    plyb = tmp_path / "wall_bin.ply"
    plyb.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n"
                     b"element face 2\nproperty list uchar int vertex_indices\nend_header\n"
                     + b"".join(struct.pack("<3f", *p) for p in v) + struct.pack("<B3i", 3, 0, 1, 2) + struct.pack("<B3i", 3, 0, 2, 3))
    cams = np.zeros((1, 3))
    for f in (obj, ply, plyb):
        pts, nrm = mesh_points(f, None, cams)
        assert len(pts) == 2 and np.allclose(pts[:, 2], -1) and np.allclose(nrm, [0, 0, 1])  # towards the camera, whatever the winding
    with pytest.raises(ValueError):
        (tmp_path / "pts.obj").write_text("v 0 0 0\nv 1 0 0\n")
        mesh_points(tmp_path / "pts.obj", None, cams)
