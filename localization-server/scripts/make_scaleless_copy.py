"""Copy a metric map into an arbitrary-scale, arbitrarily rotated one.

A map built from a plain video has unknown scale and orientation. To test how
well the server recovers the scale from an AR session on real images, this
script takes a metric map and re-expresses it in a frame that is scaled,
rotated and shifted by known amounts, marking the copy as non-metric. The
server should then report ``scale ~= 1 / --scale`` for sessions against it.

    uv run python scripts/make_scaleless_copy.py tum_room tum_room_units --scale 0.37

(The copy shares no COLMAP model: only what the server needs is written.)
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from locserver import config
from locserver import geometry as g
from locserver.mapstore import load_map, save_map, utc_now


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src_map_id")
    ap.add_argument("dst_map_id")
    ap.add_argument("--scale", type=float, default=0.37, help="map units per metre of the copy")
    ap.add_argument("--maps-dir", default=None)
    a = ap.parse_args()
    maps = Path(a.maps_dir or config.maps_dir())
    src = load_map(maps / a.src_map_id)
    if not src.metric:
        raise SystemExit("the source map must be metric")
    sim = g.Sim3(a.scale, g.viro_euler_to_rotmat([25.0, -40.0, 10.0]), np.array([3.0, -1.0, 2.0]))
    images = src.transformed_images(sim)
    meta = dict(src.meta)
    for k in ("metric_alignment", "map_frame", "bounds"):
        meta.pop(k, None)
    meta.update(map_id=a.dst_map_id, created_utc=utc_now(), metric=False, scale_m_per_unit=None, scale_source=None,
                derived_from={"map_id": a.src_map_id, "true_scale_m_per_unit": 1.0 / a.scale,
                              "T_this_from_source": sim.matrix().tolist()})
    dst = maps / a.dst_map_id
    save_map(dst, meta, images, src.vlad, src.global_desc)
    print(f"wrote {dst}: non-metric copy, true scale {1.0 / a.scale:.6f} m per map unit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
