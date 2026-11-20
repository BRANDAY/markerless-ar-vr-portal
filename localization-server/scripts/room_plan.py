"""Compute (or recompute) the room plan of a map from the command line.

    uv run python scripts/room_plan.py room                      # writes data/maps/room/room.json
    uv run python scripts/room_plan.py room --plot plan.png      # + a top-down picture for a quick look
    uv run python scripts/room_plan.py tum_room --tum-depth <TUM sequence folder> --no-save
                                                                 # measured Kinect depth instead of the depth network

The server does the same in a background job after a recording upload; this
script is for experiments and for the evaluation on the test sequence.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from locserver import config
from locserver.mapstore import load_map
from locserver.roomplan import plan_basis
from locserver.roomstage import compute_room_for_map, map_up, save_room


def tum_depth_provider(folder: Path, lmap):
    """Measured depth (registered to the colour image) for the frames of a TUM sequence."""
    from locserver.capture import TumCapture

    cap = TumCapture(folder)
    lines = [ln.split()[:2] for ln in (folder / "depth.txt").read_text().splitlines() if ln and not ln.startswith("#")]
    ts = np.array([float(a) for a, _ in lines])

    def provider(im):
        t = cap.rgb[int(Path(im.name).stem)][0]
        j = int(np.argmin(np.abs(ts - t)))
        if abs(ts[j] - t) > 0.03:
            return None
        d = cv2.imread(str(folder / lines[j][1]), cv2.IMREAD_UNCHANGED)
        return None if d is None else d.astype(np.float32) / 5000.0

    return provider


def plot(room: dict, lmap, path: Path, px_per_m: float = 110.0) -> None:
    """Top-down picture: map points (grey), camera path (blue), walls (black), corners (red), openings (green)."""
    B = plan_basis(room["up"])
    pts = np.concatenate([im.xyz[np.isfinite(im.xyz).all(1)][::4] for im in lmap.images]).astype(float) @ B.T
    cams = np.array([im.center for im in lmap.images]) @ B.T
    geo = [np.array(w["corners"]) @ B.T for w in room["walls"]]
    allp = np.concatenate([cams[:, :2]] + [c[:, :2] for c in geo]) if geo else cams[:, :2]
    lo, hi = allp.min(0) - 1.0, allp.max(0) + 1.0
    size = np.ceil((hi - lo) * px_per_m).astype(int)
    img = np.full((size[1], size[0], 3), 255, np.uint8)
    def to_px(p):
        x, y = ((np.asarray(p)[:2] - lo) * px_per_m).round()
        return int(x), int(size[1] - 1 - y)

    fl = room["floor"]["level"] if room.get("floor") else np.median(pts[:, 2])
    for p in pts[(pts[:, 2] > fl + 0.2) & (pts[:, 2] < fl + 2.3)]:
        x, y = to_px(p)
        if 0 <= x < size[0] and 0 <= y < size[1]:
            img[y, x] = (170, 170, 170)
    for a, b in zip(cams[:-1], cams[1:]):
        cv2.line(img, to_px(a), to_px(b), (220, 120, 0), 1, cv2.LINE_AA)
    for w, c in zip(room["walls"], geo):
        cv2.line(img, to_px(c[0]), to_px(c[1]), (0, 0, 0), 2, cv2.LINE_AA)
        mid = (c[0] + c[1]) / 2
        cv2.line(img, to_px(mid), to_px(mid + 0.25 * (np.array(w["normal"]) @ B.T)), (0, 0, 0), 1, cv2.LINE_AA)
        cv2.putText(img, f"{w['id']} {w['width']:.1f}m", to_px(mid + 0.35 * (np.array(w["normal"]) @ B.T)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
    for c in room["corners"]:
        cv2.circle(img, to_px(np.array(c["bottom"]) @ B.T), 5, (0, 0, 255), -1, cv2.LINE_AA)
    for o in room["openings"]:
        c = np.array(o["corners"]) @ B.T
        cv2.line(img, to_px(c[0]), to_px(c[1]), (0, 170, 0), 5, cv2.LINE_AA)
        cv2.putText(img, f"{o['id']} {o['confidence']:.2f} {o['state']}", to_px(c[0] + 0.15), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (0, 120, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(path), img)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map_id")
    ap.add_argument("--maps-dir", default=None)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--mesh", default=None, help="OBJ/PLY mesh in map coordinates")
    ap.add_argument("--max-views", type=int, default=40)
    ap.add_argument("--no-detector", action="store_true")
    ap.add_argument("--tum-depth", default=None, help="TUM sequence folder: use its measured depth images")
    ap.add_argument("--plot", default=None, help="write a top-down PNG")
    ap.add_argument("--out", default=None, help="also write the plan JSON here")
    ap.add_argument("--no-save", action="store_true", help="do not write room.json into the map")
    ap.add_argument("--dump-views", default=None, help="write the depth views + door boxes (npz) for experiments")
    a = ap.parse_args()
    config.setup_logging("INFO")
    lmap = load_map(Path(a.maps_dir or config.maps_dir()) / a.map_id)
    if map_up(lmap) is None:
        print("this map has no gravity direction (it was not built from a recording with poses)")
    t0 = time.perf_counter()
    stages = {}

    def progress(stage, frac, msg):
        stages.setdefault(stage, time.perf_counter())

    room, warnings = compute_room_for_map(
        lmap, a.device, a.mesh, None, not a.no_detector, progress, a.max_views,
        depth_provider=tum_depth_provider(Path(a.tum_depth), lmap) if a.tum_depth else None, views_out=a.dump_views,
    )
    dt = time.perf_counter() - t0
    if not a.no_save:
        save_room(lmap.path, room)
    if a.out:
        Path(a.out).write_text(json.dumps(room, indent=1), encoding="utf-8")
    if a.plot and room["status"] != "unavailable":
        plot(room, lmap, Path(a.plot))
    print(json.dumps({
        "status": room["status"], "reason": room["reason"], "sources": room["sources"], "seconds": round(dt, 1),
        "floor_level": room["floor"] and room["floor"]["level"], "height": room["height"],
        "walls": [(w["id"], w["width"], w["confidence"], w["coverage"]) for w in room["walls"]],
        "corners": [(c["id"], c["walls"], c["angle_deg"]) for c in room["corners"]],
        "openings": [(o["id"], o["wall_id"], o["state"], o["width"], o["height"], o["confidence"], o["evidence"]) for o in room["openings"]],
        "best_opening_id": room["best_opening_id"], "key_frames": len(room.get("key_frames", [])), "warnings": warnings,
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
