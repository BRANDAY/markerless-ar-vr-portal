"""Upload a room recording to a running server and follow the build, like the app does.

    uv run python scripts/demo_room_upload.py data/work/demo_rec_long --map-id demo_room

The folder has to contain ``video.mp4`` and ``session.jsonl`` (and optionally a
mesh given with ``--mesh``). Prints one line per progress change and, at the
end, what the server found: walls, corners, openings and the portal.
This is the reference for the client flow of docs/api-v2.md, section 7.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import httpx


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording")
    ap.add_argument("--map-id", required=True)
    ap.add_argument("--server", default="http://127.0.0.1:8077")
    ap.add_argument("--mesh", default=None)
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("--max-frames", type=int, default=200)
    ap.add_argument("--poll", type=float, default=2.0)
    a = ap.parse_args()
    rec = Path(a.recording)
    caps = httpx.get(f"{a.server}/health", timeout=10).json().get("capabilities", [])
    if "recording_upload" not in caps:
        print("this server does not announce 'recording_upload' (v1 server?)")
        return 2
    files = {"video": ("video.mp4", open(rec / "video.mp4", "rb"), "video/mp4"),
             "session_jsonl": ("session.jsonl", open(rec / "session.jsonl", "rb"), "application/x-ndjson")}
    if a.mesh:
        files["mesh"] = (Path(a.mesh).name, open(a.mesh, "rb"), "application/octet-stream")
    t0 = time.time()
    r = httpx.post(f"{a.server}/maps/{a.map_id}/recording", files=files,
                   data={"replace": str(a.replace).lower(), "max_frames": str(a.max_frames)}, timeout=600)
    if r.status_code != 202:
        print("upload refused:", r.status_code, r.text)
        return 1
    job = r.json()["job"]
    print(f"uploaded in {time.time() - t0:.1f} s, job {job['job_id']}")
    last, worst_poll_ms = None, 0.0
    while job["state"] not in ("succeeded", "failed", "cancelled"):
        time.sleep(a.poll)
        t = time.perf_counter()
        job = httpx.get(f"{a.server}/jobs/{job['job_id']}", timeout=30).json()
        worst_poll_ms = max(worst_poll_ms, (time.perf_counter() - t) * 1000)
        line = (job["state"], job["stage"], round(job["progress"] * 100))
        if line != last:
            print(f"{job['elapsed_s']:7.1f} s  {job['progress'] * 100:5.1f} %  step {job['stage_index']}/{job['stage_count']} "
                  f"{job['stage'] or '-':10s} eta {job['eta_s']}  {job['message']}", flush=True)
            last = line
    print("final state:", job["state"], "| slowest poll %.0f ms" % worst_poll_ms)
    if job["state"] != "succeeded":
        print(json.dumps(job["error"], indent=1))
        return 1
    print(json.dumps(job["result"], indent=1))
    room = httpx.get(f"{a.server}/maps/{a.map_id}/room", timeout=30).json()["room"]
    print(json.dumps({
        "status": room["status"], "up": room["up"], "floor_level": room["floor"] and room["floor"]["level"], "height": room["height"],
        "walls": [(w["id"], w["width"], w["confidence"]) for w in room["walls"]],
        "corners": [(c["id"], c["walls"], c["angle_deg"]) for c in room["corners"]],
        "openings": [(o["id"], o["wall_id"], o["state"], o["width"], o["height"], o["confidence"], o["evidence"]) for o in room["openings"]],
        "portal": httpx.get(f"{a.server}/maps/{a.map_id}/portal", timeout=30).json(),
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
