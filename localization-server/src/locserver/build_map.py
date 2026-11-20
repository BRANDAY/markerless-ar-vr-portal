"""CLI: build a map from a video, an image folder or a recording.

    uv run locserver-build-map data/input/room.mp4 --map-id room
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import config
from .features import FeaturePipeline
from .mapping import BuildOptions, build_map


def parse_intrinsics(text: str | None) -> dict | None:
    if not text:
        return None
    v = [float(x) for x in text.split(",")]
    if len(v) != 4:
        raise argparse.ArgumentTypeError("--intrinsics expects fx,fy,cx,cy")
    return dict(fx=v[0], fy=v[1], cx=v[2], cy=v[3])


def main(argv: list[str] | None = None) -> int:
    d = BuildOptions()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="video file, image folder, TUM sequence folder or ViroReact recording folder")
    ap.add_argument("--map-id", required=True, help="name of the map (folder name under the maps directory)")
    ap.add_argument("--maps-dir", default=None, help=f"default: {config.maps_dir()}")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--fps", type=float, default=d.target_fps, help="frames kept per second of video")
    ap.add_argument("--every", type=int, default=None, help="keep one frame out of N (overrides --fps)")
    ap.add_argument("--max-frames", type=int, default=d.max_frames)
    ap.add_argument("--max-size", type=int, default=d.max_size, help="longer image side in pixels")
    ap.add_argument("--blur-ratio", type=float, default=d.blur_ratio, help="reject frames below ratio x median sharpness")
    ap.add_argument("--max-keypoints", type=int, default=2048)
    ap.add_argument("--seq-window", type=int, default=d.seq_window)
    ap.add_argument("--retrieval-k", type=int, default=d.retrieval_k)
    ap.add_argument("--intrinsics", default=None, help="fx,fy,cx,cy of the native frames (optional prior)")
    ap.add_argument("--no-poses", action="store_true", help="ignore metric poses of the capture (arbitrary-scale map)")
    ap.add_argument("--no-pose-priors", action="store_true",
                    help="use the capture's metric poses only for the final similarity alignment, not inside SfM")
    ap.add_argument("--recording-rotation", type=int, default=None, choices=[0, 90, 180, 270],
                    help="ViroReact recording only: rotate frames clockwise by this instead of the container hint")
    ap.add_argument("--keep-work", action="store_true", help="keep the COLMAP database of the build")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--log-level", default="INFO")
    a = ap.parse_args(argv)
    config.setup_logging(a.log_level)

    map_dir = Path(a.maps_dir or config.maps_dir()) / a.map_id
    if (map_dir / "map.json").exists():
        if not a.overwrite:
            print(f"map {map_dir} exists - pass --overwrite to rebuild it", file=sys.stderr)
            return 2
        anchors = (map_dir / "anchors.json").read_text(encoding="utf-8") if (map_dir / "anchors.json").exists() else None
        shutil.rmtree(map_dir)
        if anchors and anchors.strip() != "{}":
            # A rebuilt map has a new coordinate frame: old anchors would be wrong.
            map_dir.mkdir(parents=True)
            (map_dir / "anchors.stale.json").write_text(anchors, encoding="utf-8")

    opts = BuildOptions(
        target_fps=a.fps, every=a.every, max_frames=a.max_frames, max_size=a.max_size, blur_ratio=a.blur_ratio,
        seq_window=a.seq_window, retrieval_k=a.retrieval_k, intrinsics=parse_intrinsics(a.intrinsics),
        use_metric_poses=not a.no_poses, use_pose_priors=not a.no_pose_priors, keep_work=a.keep_work,
    )
    capture = None
    if a.recording_rotation is not None:
        from .recording import ViroRecordingCapture

        capture = ViroRecordingCapture(a.input, display_rotation_cw=a.recording_rotation)
    pipe = FeaturePipeline(a.device, max_keypoints=a.max_keypoints)
    m = build_map(a.input, map_dir, a.map_id, pipe, opts, capture=capture)
    keys = ("map_id", "num_images_selected", "num_images_registered", "num_points3D",
            "mean_reprojection_error_px", "metric", "scale_m_per_unit", "camera")
    print(json.dumps({k: m.meta[k] for k in keys} | {"timings_s": m.meta["build"]["timings_s"], "path": str(map_dir)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
