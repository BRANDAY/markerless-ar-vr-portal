"""Send a recording (video.mp4 + session.jsonl) to a running server, like the app would.

Prints the alignment the server returns and, if the recording folder contains
``expected.json`` (written by make_demo_recording.py), how far it is from the
known answer.

    uv run python scripts/demo_recording_query.py data/work/demo_rec --map-id tum_room
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx
import numpy as np

from locserver import geometry as g


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording")
    ap.add_argument("--map-id", required=True)
    ap.add_argument("--server", default="http://127.0.0.1:8077")
    ap.add_argument("--max-frames", type=int, default=5)
    a = ap.parse_args()
    rec = Path(a.recording)
    with open(rec / "video.mp4", "rb") as v, open(rec / "session.jsonl", "rb") as s:
        r = httpx.post(
            f"{a.server}/localize",
            files={"video": ("video.mp4", v, "video/mp4"), "session_jsonl": ("session.jsonl", s, "application/x-ndjson")},
            data={"map_id": a.map_id, "max_frames": str(a.max_frames)},
            timeout=300,
        )
    r.raise_for_status()
    out = r.json()
    al = out["alignment"]
    summary = {
        "success": out["success"], "quality": out["quality"], "intrinsics_source": out["intrinsics_source"],
        "frames": [(f["index"], f["quality"], f["num_inliers"]) for f in out["frames"]],
        "elapsed_ms": out["elapsed_ms"],
        "alignment": {k: al.get(k) for k in ("status", "scale", "scale_source", "scale_reliable", "scale_rel_std",
                                             "observations_used", "observations_total", "position_rms_m",
                                             "rotation_max_deg", "baseline_m", "ar_pose_pairing")},
        "anchors": al.get("anchors"),
    }
    exp_file = rec / "expected.json"
    if exp_file.exists() and al.get("T_arworld_from_map"):
        # expected arworld <- map: the session transform of the recording, composed with
        # the known transform of a derived (scale-less) map back to its metric source
        M_exp = np.array(json.loads(exp_file.read_text(encoding="utf-8"))["expected_T_arworld_from_map"])
        derived = httpx.get(f"{a.server}/maps/{a.map_id}", timeout=30).json().get("derived_from")
        if derived:
            M_exp = M_exp @ np.linalg.inv(np.array(derived["T_this_from_source"]))
        M = np.array(al["T_arworld_from_map"])
        s_exp = float(np.cbrt(np.linalg.det(M_exp[:3, :3])))
        cam = np.array(out["pose"]["position"])  # camera of the best frame, map coordinates
        fwd = np.array(out["pose"]["T_map_from_cvcam"])[:3, 2]
        ahead = cam + fwd * (2.0 / s_exp)  # a point 2 m in front of that camera

        def place(Mx, p):
            return Mx[:3, :3] @ p + Mx[:3, 3]

        summary["vs_expected"] = {
            "true_scale": round(s_exp, 5),
            "scale_error_pct": round((al["scale"] / s_exp - 1) * 100, 2),
            "rotation_error_deg": round(g.rotation_angle_deg(M[:3, :3] / al["scale"], M_exp[:3, :3] / s_exp), 3),
            "placement_error_at_camera_m": round(float(np.linalg.norm(place(M, cam) - place(M_exp, cam))), 4),
            "placement_error_2m_ahead_m": round(float(np.linalg.norm(place(M, ahead) - place(M_exp, ahead))), 4),
        }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
