"""Turn a stretch of a TUM RGB-D sequence into a fake ViroReact AR recording.

The result (``video.mp4`` + ``session.jsonl``) has the schema ViroReact writes,
with the motion-capture ground truth playing the role of the ARCore poses. It
lets the whole "clip + session.jsonl -> alignment" path run on real images
before a phone recording exists.

The poses are turned from the z-up motion-capture world into a y-up world, as
an AR session reports them (gravity along -y).
``--session-transform yaw_deg,tx,ty,tz`` moves them further into a different world
frame, the way a new AR session has a new origin and heading. The server must
then report exactly that transform as ``T_arworld_from_map`` (for a metric map
built from the same sequence), which is what this script prints for comparison.

    uv run python scripts/make_demo_recording.py <tum sequence> <out dir> --start 400 --count 30
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from locserver import geometry as g
from locserver.capture import TumCapture
from locserver.recording import T_YUP_FROM_ZUP, write_recording


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sequence")
    ap.add_argument("out")
    ap.add_argument("--start", type=int, default=400)
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--step", type=int, default=1)
    ap.add_argument("--session-transform", default="0,0,0,0", help="yaw_deg,tx,ty,tz of the new session frame")
    a = ap.parse_args()

    yaw, tx, ty, tz = (float(v) for v in a.session_transform.split(","))
    # the TUM world has z up, an AR world has y up: turn it first, then apply the session offset
    T_session_from_world = g.make_T(g.rot_y(np.radians(yaw)), [tx, ty, tz]) @ T_YUP_FROM_ZUP

    cap = TumCapture(a.sequence)
    want = set(range(a.start, a.start + a.count * a.step, a.step))
    images, poses, used = [], [], []
    for fr in cap.frames():
        if fr.index in want and fr.T_world_from_arcam is not None:
            images.append(fr.image)
            poses.append(T_session_from_world @ fr.T_world_from_arcam)
            used.append(fr.index)
        if fr.index > max(want):
            break
    if not images:
        raise SystemExit("no frames with ground truth in that range")
    out = write_recording(a.out, images, poses, cap.info.intrinsics, fps=30.0 / a.step)
    travel = float(np.linalg.norm(poses[-1][:3, 3] - poses[0][:3, 3]))
    info = {
        "frames": used,
        "camera_travel_m": round(travel, 3),
        "expected_T_arworld_from_map": [[round(float(v), 6) for v in row] for row in T_session_from_world],
    }
    (Path(out) / "expected.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in info.items() if k != "frames"} | {"num_frames": len(used), "out": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
