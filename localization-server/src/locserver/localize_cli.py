"""CLI: localise one image against a map without running the server.

    uv run locserver-localize photo.jpg --map-id room
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

from . import config
from .features import FeaturePipeline
from .localize import LocalizeOptions, Localizer
from .mapstore import load_map
from .responses import localization_dict


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--map-id", required=True)
    ap.add_argument("--maps-dir", default=None)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--intrinsics", default=None, help="fx,fy,cx,cy of the image, or 'map' for the map camera")
    ap.add_argument("--repeat", type=int, default=1, help="run N times and report the last (warm) timing")
    a = ap.parse_args(argv)
    config.setup_logging("WARNING")

    lmap = load_map(Path(a.maps_dir or config.maps_dir()) / a.map_id)
    img = cv2.imread(a.image, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {a.image}")
    intr = None
    if a.intrinsics and a.intrinsics != "map":
        fx, fy, cx, cy = (float(v) for v in a.intrinsics.split(","))
        intr = dict(fx=fx, fy=fy, cx=cx, cy=cy)
    opts = LocalizeOptions()
    loc = Localizer(FeaturePipeline(a.device), None, opts)
    for _ in range(max(1, a.repeat)):
        res = loc.localize(lmap, img, intr, assume_map_camera=a.intrinsics == "map")
    out = localization_dict(res, lmap, opts)
    out.pop("thresholds")
    print(json.dumps(out, indent=2))
    return 0 if res.success else 1


if __name__ == "__main__":
    raise SystemExit(main())
