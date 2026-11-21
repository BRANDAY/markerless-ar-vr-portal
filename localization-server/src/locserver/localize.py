"""Single-image localisation against a map: retrieval -> LightGlue -> PnP."""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pycolmap

from .capture import resize_max
from .features import FeaturePipeline, to_colmap_xy
from .mapstore import LocMap, check_id

log = logging.getLogger(__name__)


@dataclass
class LocalizeOptions:
    retrieval_k: int = 8  # map images matched against the query at most
    min_images: int = 3  # ...and at least, before early stopping is considered
    enough_matches: int = 600  # stop matching once this many 2D-3D matches exist
    ransac_max_error_px: float = 8.0  # at the working resolution
    # Verdict thresholds (see README "Quality verdict"):
    good_min_inliers: int = 60
    good_min_inlier_ratio: float = 0.25
    weak_min_inliers: int = 25
    # Extra margin when the focal length had to be estimated from the same data:
    good_min_inliers_unknown_focal: int = 100
    weak_min_inliers_unknown_focal: int = 40
    min_hfov_deg: float = 25.0
    max_hfov_deg: float = 130.0

    def thresholds(self) -> dict:
        return {
            "good": {
                "min_inliers": self.good_min_inliers,
                "min_inliers_if_focal_estimated": self.good_min_inliers_unknown_focal,
                "min_inlier_ratio": self.good_min_inlier_ratio,
            },
            "weak": {
                "min_inliers": self.weak_min_inliers,
                "min_inliers_if_focal_estimated": self.weak_min_inliers_unknown_focal,
            },
            "ransac_max_error_px": self.ransac_max_error_px,
        }


@dataclass
class LocalizationResult:
    success: bool
    quality: str  # "good" | "weak" | "failed"
    reason: str | None = None
    T_cvcam_from_map: np.ndarray | None = None
    num_matches: int = 0
    num_inliers: int = 0
    inlier_ratio: float = 0.0
    reproj_error_px_mean: float | None = None
    reproj_error_px_median: float | None = None
    intrinsics: dict | None = None  # at the working resolution
    intrinsics_source: str | None = None
    working_size: tuple[int, int] | None = None  # (width, height) the pose/intrinsics refer to
    num_keypoints: int = 0
    retrieved: list[dict] = field(default_factory=list)
    timings_ms: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
class DeviceCalibrationStore:
    """Remembers the focal length of a device once it has been estimated reliably.

    Samples are focal lengths divided by the image width, taken only from "good"
    localisations where the focal length was estimated. After ``min_samples``
    samples that agree within ``max_rel_spread`` (robust sigma / median) the
    calibration is locked and used as fixed intrinsics for that device id and
    aspect ratio, which makes PnP both faster and more stable.
    """

    def __init__(self, directory: Path, min_samples: int = 5, max_rel_spread: float = 0.03, max_samples: int = 50):
        self.dir = Path(directory)
        self.min_samples, self.max_rel_spread, self.max_samples = min_samples, max_rel_spread, max_samples
        self._lock = threading.Lock()

    def _file(self, device_id: str) -> Path:
        return self.dir / f"{check_id(device_id, 'device_id')}.json"

    def _read(self, device_id: str) -> dict:
        f = self._file(device_id)
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"device_id": device_id, "profiles": {}}

    @staticmethod
    def _key(width: int, height: int) -> str:
        return f"{width / height:.3f}"

    def get(self, device_id: str, width: int, height: int) -> dict | None:
        prof = self._read(device_id)["profiles"].get(self._key(width, height))
        if not prof or not prof.get("locked"):
            return None
        f = prof["f_over_width"] * width
        return dict(fx=f, fy=f, cx=width / 2, cy=height / 2, width=width, height=height)

    def add_sample(self, device_id: str, width: int, height: int, focal: float) -> dict:
        with self._lock:
            data = self._read(device_id)
            prof = data["profiles"].setdefault(self._key(width, height), {"samples": [], "locked": False})
            prof["samples"] = (prof["samples"] + [focal / width])[-self.max_samples :]
            s = np.array(prof["samples"])
            med = float(np.median(s))
            spread = float(1.4826 * np.median(np.abs(s - med)) / med)
            prof.update(f_over_width=med, rel_spread=spread, locked=bool(len(s) >= self.min_samples and spread <= self.max_rel_spread))
            self.dir.mkdir(parents=True, exist_ok=True)
            self._file(device_id).write_text(json.dumps(data, indent=2), encoding="utf-8")
            return prof

    def all(self) -> list[dict]:
        if not self.dir.exists():
            return []
        return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(self.dir.glob("*.json"))]

    def delete(self, device_id: str) -> bool:
        f = self._file(device_id)
        if f.exists():
            f.unlink()
            return True
        return False


# --------------------------------------------------------------------------- #
def scale_intrinsics(intr: dict, width: int, height: int) -> dict:
    """Rescale fx, fy, cx, cy given for (intr.width, intr.height) to another size."""
    sx = width / float(intr.get("width") or width)
    sy = height / float(intr.get("height") or height)
    return dict(fx=intr["fx"] * sx, fy=intr["fy"] * sy, cx=intr["cx"] * sx, cy=intr["cy"] * sy, width=width, height=height)


def project(model: str, params: np.ndarray, X_cam: np.ndarray) -> np.ndarray:
    """Pixel coordinates (COLMAP convention) of camera-frame points."""
    u, v = X_cam[:, 0] / X_cam[:, 2], X_cam[:, 1] / X_cam[:, 2]
    if model == "SIMPLE_PINHOLE":
        f, cx, cy = params[:3]
        return np.stack([f * u + cx, f * v + cy], 1)
    if model == "PINHOLE":
        fx, fy, cx, cy = params[:4]
        return np.stack([fx * u + cx, fy * v + cy], 1)
    if model == "SIMPLE_RADIAL":
        f, cx, cy, k = params[:4]
        d = 1.0 + k * (u * u + v * v)
        return np.stack([f * u * d + cx, f * v * d + cy], 1)
    raise ValueError(f"unsupported camera model {model}")


class Localizer:
    def __init__(self, pipe: FeaturePipeline, calib: DeviceCalibrationStore | None = None, opts: LocalizeOptions | None = None):
        self.pipe = pipe
        self.calib = calib
        self.opts = opts or LocalizeOptions()

    # ------------------------------------------------------------------ #
    def _camera(self, lmap: LocMap, w: int, h: int, intrinsics, device_id, assume_map_camera):
        """Returns (pycolmap.Camera, source, estimate_focal)."""
        mc = lmap.camera
        same_aspect = abs(w / h - mc["width"] / mc["height"]) < 0.01
        if intrinsics:
            i = intrinsics
            cam = pycolmap.Camera(model="PINHOLE", width=w, height=h, params=[i["fx"], i["fy"], i["cx"], i["cy"]])
            return cam, "request", False
        if assume_map_camera:
            if not same_aspect:
                raise ValueError("intrinsics=map requires the aspect ratio of the map camera")
            s = w / mc["width"]
            if mc["model"] == "SIMPLE_RADIAL":
                f, cx, cy, k = mc["params"]
                cam = pycolmap.Camera(model="SIMPLE_RADIAL", width=w, height=h, params=[f * s, cx * s, cy * s, k])
            else:
                cam = pycolmap.Camera(model="PINHOLE", width=w, height=h, params=[mc["fx"] * s, mc["fy"] * s, mc["cx"] * s, mc["cy"] * s])
            return cam, "map_camera", False
        if device_id and self.calib:
            c = self.calib.get(device_id, w, h)
            if c:
                cam = pycolmap.Camera(model="PINHOLE", width=w, height=h, params=[c["fx"], c["fy"], c["cx"], c["cy"]])
                return cam, "device_cache", False
        f0 = mc["fx"] * w / mc["width"] if same_aspect else 1.2 * max(w, h)
        cam = pycolmap.Camera(model="SIMPLE_PINHOLE", width=w, height=h, params=[f0, w / 2, h / 2])
        return cam, "estimated", True

    # ------------------------------------------------------------------ #
    def localize(
        self,
        lmap: LocMap,
        image_bgr: np.ndarray,
        intrinsics: dict | None = None,
        device_id: str | None = None,
        assume_map_camera: bool = False,
    ) -> LocalizationResult:
        """Localise one upright BGR image.

        ``intrinsics`` (fx, fy, cx, cy[, width, height]) refer to ``image_bgr`` as
        given; they are rescaled to the working resolution internally. The returned
        pose does not depend on the working resolution.
        """
        o = self.opts
        tm: dict[str, float] = {}
        t_start = time.perf_counter()

        img, scale = resize_max(image_bgr, int(lmap.meta["features"]["image_max_size"]))
        h, w = img.shape[:2]
        if intrinsics:
            full = dict(intrinsics, width=intrinsics.get("width") or image_bgr.shape[1], height=intrinsics.get("height") or image_bgr.shape[0])
            intrinsics = scale_intrinsics(full, w, h)
        res = LocalizationResult(False, "failed", working_size=(w, h))

        t0 = time.perf_counter()
        feats = self.pipe.extract(img)
        self.pipe.sync()
        tm["extract"] = time.perf_counter() - t0
        res.num_keypoints = len(feats.keypoints)
        if len(feats.keypoints) < 20:
            return self._finish(res, tm, t_start, "too few keypoints in the image (blur, darkness or a blank wall)")

        t0 = time.perf_counter()
        order = lmap.retrieve(lmap.vlad.encode(feats.descriptors), o.retrieval_k)
        tm["retrieve"] = time.perf_counter() - t0

        t0 = time.perf_counter()
        q_idx, p3d_ids, p3d = [], [], []
        for rank, di in enumerate(order):
            mi = lmap.images[int(di)]
            m, _ = self.pipe.match(feats, mi.features)
            ok = mi.point3D_ids[m[:, 1]] >= 0 if len(m) else np.zeros(0, bool)
            m = m[ok]
            q_idx.append(m[:, 0])
            p3d_ids.append(mi.point3D_ids[m[:, 1]])
            p3d.append(mi.xyz[m[:, 1]])
            res.retrieved.append({"image": mi.name, "matches_3d": int(len(m))})
            if rank + 1 >= o.min_images and sum(len(q) for q in q_idx) >= o.enough_matches:
                break
        self.pipe.sync()
        tm["match"] = time.perf_counter() - t0

        q_idx = np.concatenate(q_idx)
        p3d_ids = np.concatenate(p3d_ids)
        p3d = np.concatenate(p3d).astype(np.float64)
        _, uniq = np.unique(np.stack([q_idx, p3d_ids], 1), axis=0, return_index=True)  # same 3D point seen twice
        q_idx, p3d = q_idx[uniq], p3d[uniq]
        res.num_matches = int(len(q_idx))
        if res.num_matches < 8:
            return self._finish(res, tm, t_start, "not enough 2D-3D matches: the view does not look like the mapped room")

        t0 = time.perf_counter()
        try:
            cam, source, estimate_f = self._camera(lmap, w, h, intrinsics, device_id, assume_map_camera)
        except ValueError as e:
            return self._finish(res, tm, t_start, str(e))
        res.intrinsics_source = source
        est = pycolmap.AbsolutePoseEstimationOptions()
        est.estimate_focal_length = estimate_f
        est.ransac.max_error = o.ransac_max_error_px
        ref = pycolmap.AbsolutePoseRefinementOptions()
        ref.refine_focal_length = estimate_f
        ref.refine_extra_params = False
        p2d = to_colmap_xy(feats.keypoints[q_idx])
        ret = pycolmap.estimate_and_refine_absolute_pose(p2d, p3d, cam, est, ref)
        tm["pose"] = time.perf_counter() - t0
        if ret is None:
            return self._finish(res, tm, t_start, "PnP RANSAC found no pose")

        inl = np.asarray(ret["inlier_mask"], dtype=bool)
        T = np.eye(4)
        T[:3, :4] = np.asarray(ret["cam_from_world"].matrix(), dtype=float)
        res.num_inliers = int(inl.sum())
        res.inlier_ratio = float(inl.mean())
        res.intrinsics = dict(
            fx=float(cam.focal_length_x), fy=float(cam.focal_length_y),
            cx=float(cam.principal_point_x), cy=float(cam.principal_point_y), width=w, height=h,
        )
        if res.num_inliers >= 4:
            Xc = p3d[inl] @ T[:3, :3].T + T[:3, 3]
            err = np.linalg.norm(project(cam.model.name, np.asarray(cam.params), Xc) - p2d[inl], axis=1)
            res.reproj_error_px_mean = float(err.mean())
            res.reproj_error_px_median = float(np.median(err))

        hfov = float(np.degrees(2 * np.arctan(w / (2 * res.intrinsics["fx"]))))
        res.intrinsics["hfov_deg"] = hfov
        min_good = o.good_min_inliers_unknown_focal if estimate_f else o.good_min_inliers
        min_weak = o.weak_min_inliers_unknown_focal if estimate_f else o.weak_min_inliers
        if not (o.min_hfov_deg <= hfov <= o.max_hfov_deg):
            return self._finish(res, tm, t_start, f"implausible estimated field of view ({hfov:.0f} deg)")
        if res.num_inliers < min_weak:
            return self._finish(res, tm, t_start, f"only {res.num_inliers} PnP inliers (< {min_weak})")
        res.T_cvcam_from_map = T
        res.success = True
        res.quality = "good" if (res.num_inliers >= min_good and res.inlier_ratio >= o.good_min_inlier_ratio) else "weak"
        if estimate_f and res.quality == "good" and device_id and self.calib:
            try:
                self.calib.add_sample(device_id, w, h, res.intrinsics["fx"])
            except ValueError:
                pass
        return self._finish(res, tm, t_start, None)

    def room_similarity(self, lmaps, image_bgr: np.ndarray) -> dict[str, float]:
        """How much the picture looks like each room: mean of the three best global-descriptor similarities.

        One feature extraction, no matching - cheap enough to order many rooms before
        the costly attempt. Every map has its own VLAD vocabulary, so the numbers of
        different rooms are comparable only roughly: good for an order, not for a decision.
        """
        out: dict[str, float] = {}
        feats_by_size: dict[int, object] = {}
        for lm in lmaps:
            size = int(lm.meta["features"]["image_max_size"])
            if size not in feats_by_size:
                feats_by_size[size] = self.pipe.extract(resize_max(image_bgr, size)[0])
            feats = feats_by_size[size]
            if len(feats.keypoints) < 20 or not len(lm.global_desc):
                out[lm.map_id] = 0.0
                continue
            sim = lm.global_desc @ lm.vlad.encode(feats.descriptors)
            out[lm.map_id] = float(np.sort(sim)[-3:].mean())
        self.pipe.sync()
        return out

    @staticmethod
    def _finish(res: LocalizationResult, tm: dict, t_start: float, reason: str | None) -> LocalizationResult:
        res.reason = reason
        tm["total"] = time.perf_counter() - t_start
        res.timings_ms = {k: round(v * 1000, 1) for k, v in tm.items()}
        return res
