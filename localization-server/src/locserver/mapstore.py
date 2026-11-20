"""On-disk map format and in-memory map object.

A map directory contains::

    map.json        metadata (see README "Map directory")
    anchors.json    named poses in map coordinates (mutable through the API)
    features.npz    per-image keypoints, descriptors, 3D points, poses, VLAD index
    sfm/            the COLMAP model (cameras.bin, images.bin, points3D.bin, ...)
    images/         the mapping frames (JPEG), for inspection and re-processing

``features.npz`` is everything the server needs at query time; ``sfm/`` and
``images/`` are not read by the server.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import geometry as g
from .features import VLAD, Features

MAP_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
ANCHOR_RE = MAP_ID_RE
FORMAT_VERSION = 1


ROOM_FILE = "room.json"
PORTAL_FILE = "portal.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_id(value: str, what: str = "id") -> str:
    if not MAP_ID_RE.match(value or ""):
        raise ValueError(f"invalid {what} {value!r}: use letters, digits, '_', '-', '.' (max 64)")
    return value


@dataclass
class MapImage:
    name: str
    T_cvcam_from_map: np.ndarray  # 4x4, COLMAP cam_from_world
    features: Features
    xyz: np.ndarray  # (N, 3) float32, NaN where the keypoint has no 3D point
    point3D_ids: np.ndarray  # (N,) int64, -1 where the keypoint has no 3D point

    @property
    def center(self) -> np.ndarray:
        T = self.T_cvcam_from_map
        return -T[:3, :3].T @ T[:3, 3]


class LocMap:
    """A loaded map. Immutable except for anchors and the calibrated scale."""

    def __init__(self, path: Path, meta: dict, images: list[MapImage], vlad: VLAD, global_desc: np.ndarray):
        self.path = Path(path)
        self.meta = meta
        self.images = images
        self.vlad = vlad
        self.global_desc = global_desc  # (n_images, vlad.dim), L2-normalised rows
        self._lock = threading.Lock()

    # ------------------------------------------------------------- basics --- #
    @property
    def map_id(self) -> str:
        return self.meta["map_id"]

    @property
    def metric(self) -> bool:
        return bool(self.meta.get("metric"))

    @property
    def scale_m_per_unit(self) -> float | None:
        """Metres per map unit: 1.0 for a metric map, a calibrated value, or None."""
        s = self.meta.get("scale_m_per_unit")
        return float(s) if s else None

    @property
    def camera(self) -> dict:
        return self.meta["camera"]

    def retrieve(self, query_global: np.ndarray, k: int) -> np.ndarray:
        sim = self.global_desc @ query_global
        return np.argsort(-sim)[: min(k, len(sim))]

    def summary(self) -> dict:
        m = self.meta
        return {
            "map_id": self.map_id,
            "metric": self.metric,
            "scale_m_per_unit": self.scale_m_per_unit,
            "scale_source": m.get("scale_source"),
            "num_images": len(self.images),
            "num_points3D": m.get("num_points3D"),
            "created_utc": m.get("created_utc"),
            "anchors": sorted(self.anchors()),
        }

    # ------------------------------------------------------------ anchors --- #
    def anchors(self) -> dict:
        f = self.path / "anchors.json"
        return json.loads(f.read_text(encoding="utf-8-sig")) if f.exists() else {}

    def set_anchor(self, name: str, T_map_from_anchor: np.ndarray, note: str | None = None) -> dict:
        check_id(name, "anchor name")
        if not g.is_rotation(T_map_from_anchor[:3, :3], tol=1e-4):
            raise ValueError("anchor rotation is not a rotation matrix")
        R = g.project_to_rotation(T_map_from_anchor[:3, :3])
        entry = {
            "position": [float(v) for v in T_map_from_anchor[:3, 3]],
            "quaternion_xyzw": [float(v) for v in g.rotmat_to_quat(R)],
            "note": note,
            "updated_utc": utc_now(),
        }
        with self._lock:
            all_ = self.anchors()
            all_[name] = entry
            _write_json(self.path / "anchors.json", all_)
        return entry

    def delete_anchor(self, name: str) -> bool:
        with self._lock:
            all_ = self.anchors()
            if name not in all_:
                return False
            del all_[name]
            _write_json(self.path / "anchors.json", all_)
        return True

    @staticmethod
    def anchor_T(entry: dict) -> np.ndarray:
        return g.make_T(g.quat_to_rotmat(entry["quaternion_xyzw"]), entry["position"])

    # ---------------------------------------------------- room and portal --- #
    def room(self) -> dict | None:
        """The room plan (``room.json``, frame ``map``) or None. Re-read when the file changes."""
        f = self.path / ROOM_FILE
        try:
            mtime = f.stat().st_mtime_ns
        except OSError:
            return None
        cached = getattr(self, "_room_cache", None)
        if cached is None or cached[0] != mtime:
            try:
                cached = (mtime, json.loads(f.read_text(encoding="utf-8-sig")))
            except (OSError, ValueError):
                return None
            self._room_cache = cached
        return cached[1]

    def portal_selection(self) -> str | None:
        """Id of the opening the user chose for the portal (None = automatic)."""
        f = self.path / PORTAL_FILE
        try:
            return json.loads(f.read_text(encoding="utf-8-sig")).get("opening_id") if f.exists() else None
        except (OSError, ValueError):
            return None

    def set_portal_selection(self, opening_id: str | None) -> None:
        with self._lock:
            _write_json(self.path / PORTAL_FILE, {"opening_id": opening_id, "updated_utc": utc_now()})

    # -------------------------------------------------------------- scale --- #
    def set_scale(self, scale_m_per_unit: float, source: str) -> None:
        """Persist a metres-per-map-unit calibration for a non-metric map."""
        if self.metric:
            raise ValueError("map is already metric")
        if not (np.isfinite(scale_m_per_unit) and scale_m_per_unit > 0):
            raise ValueError("scale must be a positive number")
        with self._lock:
            self.meta["scale_m_per_unit"] = float(scale_m_per_unit)
            self.meta["scale_source"] = source
            self.meta["scale_updated_utc"] = utc_now()
            _write_json(self.path / "map.json", self.meta)

    # ---------------------------------------------------------- transform --- #
    def transformed_images(self, new_from_old: g.Sim3) -> list[MapImage]:
        """The map's images re-expressed in another frame: ``X_new = s R X_old + t``."""
        s, R, t = new_from_old.scale, new_from_old.R, new_from_old.t
        out = []
        for im in self.images:
            R_c = im.T_cvcam_from_map[:3, :3] @ R.T
            t_c = s * im.T_cvcam_from_map[:3, 3] - R_c @ t
            xyz = (s * im.xyz.astype(np.float64) @ R.T + t).astype(np.float32)  # NaN rows stay NaN
            out.append(MapImage(im.name, g.make_T(R_c, t_c), im.features, xyz, im.point3D_ids))
        return out

    # ------------------------------------------------------------- subset --- #
    def subset(self, keep: list[int], min_track: int = 2) -> "LocMap":
        """In-memory copy with only the images ``keep`` (indices).

        3D points seen by fewer than ``min_track`` of the kept images are dropped,
        which is what the map would roughly look like had the other images never
        been captured. Used by the evaluation to hold out query frames.
        """
        kept = [self.images[i] for i in keep]
        ids = np.concatenate([im.point3D_ids[im.point3D_ids >= 0] for im in kept]) if kept else np.zeros(0, int)
        uniq, counts = np.unique(ids, return_counts=True)
        good = set(uniq[counts >= min_track].tolist())
        out = []
        for im in kept:
            ok = np.fromiter((p in good for p in im.point3D_ids.tolist()), dtype=bool, count=len(im.point3D_ids))
            xyz = im.xyz.copy()
            xyz[~ok] = np.nan
            out.append(MapImage(im.name, im.T_cvcam_from_map, im.features, xyz, np.where(ok, im.point3D_ids, -1)))
        meta = dict(self.meta, num_points3D=len(good), subset_of=self.map_id)
        return LocMap(self.path, meta, out, self.vlad, self.global_desc[keep])


# --------------------------------------------------------------------------- #
def _write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    tmp.replace(path)


def save_map(path: Path, meta: dict, images: list[MapImage], vlad: VLAD, global_desc: np.ndarray) -> None:
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    offsets = np.cumsum([0] + [len(im.features.keypoints) for im in images])
    np.savez(
        path / "features.npz",
        format_version=FORMAT_VERSION,
        names=np.array([im.name for im in images]),
        offsets=offsets.astype(np.int64),
        sizes=np.array([[im.features.width, im.features.height] for im in images], dtype=np.int32),
        poses=np.stack([im.T_cvcam_from_map for im in images]).astype(np.float64),
        keypoints=np.concatenate([im.features.keypoints for im in images]).astype(np.float32),
        descriptors=np.concatenate([im.features.descriptors for im in images]).astype(np.float16),
        scores=np.concatenate([im.features.scores for im in images]).astype(np.float16),
        xyz=np.concatenate([im.xyz for im in images]).astype(np.float32),
        point3D_ids=np.concatenate([im.point3D_ids for im in images]).astype(np.int64),
        vlad_centers=vlad.centers,
        global_desc=global_desc.astype(np.float32),
    )
    _write_json(path / "map.json", meta)
    if not (path / "anchors.json").exists():
        _write_json(path / "anchors.json", {})


def load_map(path: Path) -> LocMap:
    path = Path(path)
    meta = json.loads((path / "map.json").read_text(encoding="utf-8-sig"))
    with np.load(path / "features.npz") as z:
        if int(z["format_version"]) != FORMAT_VERSION:
            raise ValueError(f"unsupported map format in {path}")
        off = z["offsets"]
        kp, desc, sc = z["keypoints"], z["descriptors"].astype(np.float32), z["scores"].astype(np.float32)
        xyz, pid, sizes, poses, names = z["xyz"], z["point3D_ids"], z["sizes"], z["poses"], z["names"]
        images = []
        for i, name in enumerate(names):
            a, b = int(off[i]), int(off[i + 1])
            feats = Features(kp[a:b], desc[a:b], sc[a:b], int(sizes[i, 0]), int(sizes[i, 1]))
            images.append(MapImage(str(name), poses[i], feats, xyz[a:b], pid[a:b]))
        return LocMap(path, meta, images, VLAD(z["vlad_centers"]), z["global_desc"])


def list_map_dirs(maps_dir: Path) -> list[Path]:
    maps_dir = Path(maps_dir)
    if not maps_dir.exists():
        return []
    return sorted(
        p for p in maps_dir.iterdir()
        if not p.name.startswith(".") and (p / "map.json").exists() and (p / "features.npz").exists()
    )
