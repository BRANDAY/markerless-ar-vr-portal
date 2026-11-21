"""Map building: frames -> ALIKED -> LightGlue -> COLMAP SfM -> map directory."""

from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
import pycolmap

from . import geometry as g
from .capture import Capture, open_capture, select_frames
from .features import EXTRACTOR_NAME, MATCHER_NAME, VLAD, FeaturePipeline, Features, to_colmap_xy
from .mapstore import FORMAT_VERSION, LocMap, MapImage, check_id, load_map, save_map, utc_now

log = logging.getLogger(__name__)


@dataclass
class BuildOptions:
    target_fps: float | None = 3.0  # frames kept per second of video
    every: int | None = None  # ...or keep one frame out of N (overrides target_fps)
    max_frames: int = 200
    max_size: int = 1024  # longer image side used for mapping and stored in the map
    blur_ratio: float = 0.35
    seq_window: int = 6  # match each frame with its N successors
    retrieval_k: int = 8  # ...and with its N most similar non-neighbours (loop closure)
    exhaustive_below: int = 40  # match all pairs when the capture is this small
    min_matches: int = 15
    vlad_clusters: int = 32
    intrinsics: dict | None = None  # fx, fy, cx, cy for the *native* frame size
    use_metric_poses: bool = True  # use AR / ground-truth poses of the capture if present
    # ...also as position priors inside bundle adjustment (prevents SfM drift):
    use_pose_priors: bool = True
    pose_prior_sigma_m: float = 0.05
    metric_ransac_threshold_m: float = 0.10
    # The capture poses (AR recording) are trusted. A reconstruction in which fewer than this
    # share of the cameras lands within the threshold of its recorded position is wrong
    # somewhere: SfM is run again (it is not deterministic) and the best attempt is kept.
    metric_min_inlier_fraction: float = 0.6
    sfm_attempts: int = 3
    # ...and single images further than this from their recorded position are not exported.
    metric_drop_m: float = 0.30
    # Sequential captures: drop short runs of images that "jump" away from the camera path.
    drop_jump_factor: float = 8.0  # a jump is a step larger than this x the median step
    drop_max_run: int = 8  # only runs up to this many images are dropped
    # Images with fewer triangulated keypoints than this are poorly registered and
    # useless as localisation references; they are left out of the map.
    min_image_points3D: int = 75
    keep_work: bool = False
    num_threads: int = max(1, min(8, (os.cpu_count() or 4) - 2))


def _cam_from_world(image) -> np.ndarray:
    """4x4 ``T_cvcam_from_map`` of a registered COLMAP image (attribute or method)."""
    cfw = image.cam_from_world
    cfw = cfw() if callable(cfw) else cfw
    T = np.eye(4)
    T[:3, :4] = np.asarray(cfw.matrix(), dtype=float)
    return T


def find_jump_outliers(centers: np.ndarray, jump_factor: float = 8.0, max_run: int = 8) -> list[int]:
    """Indices of images that left the camera path of a sequential capture.

    ``centers`` are camera centres in capture order. A walking camera moves in
    small steps; a wrongly registered image (or a short run of them) shows up as
    a jump away from the path and a jump back. The sequence is cut at every step
    larger than ``jump_factor`` x the median step; every piece of at most
    ``max_run`` images other than the largest piece is reported.
    """
    centers = np.asarray(centers, dtype=float)
    if len(centers) < 5:
        return []
    step = np.linalg.norm(np.diff(centers, axis=0), axis=1)
    med = float(np.median(step))
    if med <= 0:
        return []
    cuts = np.flatnonzero(step > jump_factor * med) + 1
    pieces = np.split(np.arange(len(centers)), cuts)
    largest = max(pieces, key=len)
    return [int(i) for p in pieces if p is not largest and len(p) <= max_run for i in p]


def choose_pairs(n: int, global_desc: np.ndarray, opts: BuildOptions) -> list[tuple[int, int]]:
    if n <= opts.exhaustive_below:
        return [(i, j) for i in range(n) for j in range(i + 1, n)]
    pairs = {(i, j) for i in range(n) for j in range(i + 1, min(n, i + 1 + opts.seq_window))}
    sim = global_desc @ global_desc.T
    for i in range(n):
        s = sim[i].copy()
        s[max(0, i - opts.seq_window) : i + opts.seq_window + 1] = -np.inf
        for j in np.argsort(-s)[: opts.retrieval_k]:
            if np.isfinite(s[j]):
                pairs.add((min(i, int(j)), max(i, int(j))))
    return sorted(pairs)


def build_map(
    input_path: str | Path,
    map_dir: str | Path,
    map_id: str,
    pipe: FeaturePipeline,
    opts: BuildOptions | None = None,
    capture: Capture | None = None,
    progress=None,
) -> LocMap:
    """Build a map from a capture and write it to ``map_dir``. Returns the loaded map.

    ``progress(stage, fraction, message)`` is called while working; stages are
    ``frames``, ``features``, ``matching``, ``sfm`` and ``finalize``.
    """
    opts = opts or BuildOptions()
    progress = progress or (lambda stage, fraction, message: None)
    progress("frames", 0.0, "reading the capture")
    check_id(map_id, "map id")
    map_dir = Path(map_dir)
    work = map_dir / "_work"
    img_dir = map_dir / "images"
    for d in (work, img_dir, map_dir / "sfm"):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
    timings: dict[str, float] = {}
    t_all = time.perf_counter()

    # 1. frames ------------------------------------------------------------- #
    t0 = time.perf_counter()
    capture = capture or open_capture(input_path)
    selected, sel_stats = select_frames(
        capture, opts.target_fps, opts.every, opts.max_frames, opts.max_size, opts.blur_ratio
    )
    if len(selected) < 3:
        raise RuntimeError(f"only {len(selected)} usable frames - need a longer or sharper capture")
    names, frames = [], {}
    for s in selected:
        name = f"{s.frame.index:06d}.jpg"
        cv2.imwrite(str(img_dir / name), s.frame.image, [cv2.IMWRITE_JPEG_QUALITY, 95])
        names.append(name)
        frames[name] = s
    sizes = {s.frame.image.shape[:2] for s in selected}
    timings["frames_s"] = time.perf_counter() - t0
    log.info("selected %d frames (%s)", len(names), sel_stats)
    progress("frames", 1.0, f"{len(names)} frames selected")

    # 2. local features ------------------------------------------------------ #
    t0 = time.perf_counter()
    feats: dict[str, Features] = {}
    for k, n in enumerate(names):
        feats[n] = pipe.extract(frames[n].frame.image)
        progress("features", (k + 1) / len(names), f"features of frame {k + 1} of {len(names)}")
    pipe.sync()
    timings["extract_s"] = time.perf_counter() - t0
    log.info("features: median %d keypoints/image", int(np.median([len(f.keypoints) for f in feats.values()])))

    # 3. pairs --------------------------------------------------------------- #
    t0 = time.perf_counter()
    all_desc = np.concatenate([feats[n].descriptors for n in names])
    vlad0 = VLAD.fit(all_desc, opts.vlad_clusters)
    gdesc0 = np.stack([vlad0.encode(feats[n].descriptors) for n in names])
    pairs = choose_pairs(len(names), gdesc0, opts)
    timings["pairs_s"] = time.perf_counter() - t0

    # 4. COLMAP database + matching ------------------------------------------ #
    t0 = time.perf_counter()
    db_path = work / "database.db"
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "SIMPLE_RADIAL"
    intr = opts.intrinsics or capture.info.intrinsics
    intr_source = "self-calibrated"
    if intr and len(sizes) == 1:
        s = selected[0].scale
        reader.camera_params = f"{(intr['fx'] + intr['fy']) / 2 * s},{intr['cx'] * s},{intr['cy'] * s},0"
        intr_source = "prior from capture, refined by bundle adjustment"
    mode = pycolmap.CameraMode.SINGLE if len(sizes) == 1 else pycolmap.CameraMode.PER_IMAGE
    pycolmap.Database.open(db_path).close()  # import_images needs an existing database
    pycolmap.import_images(db_path, img_dir, mode, names, reader)
    n_posed = sum(frames[n].frame.T_world_from_arcam is not None for n in names)
    use_priors = bool(opts.use_metric_poses and opts.use_pose_priors and n_posed >= max(3, 0.8 * len(names)))
    with pycolmap.Database.open(db_path) as db:
        db_images = {im.name: im for im in db.read_all_images()}
        ids = {n: im.image_id for n, im in db_images.items()}
        if use_priors:
            for n in names:
                T = frames[n].frame.T_world_from_arcam
                if T is None:
                    continue
                prior = pycolmap.PosePrior()
                prior.position = np.asarray(T[:3, 3], dtype=float).reshape(3, 1)
                prior.position_covariance = np.eye(3) * opts.pose_prior_sigma_m**2
                prior.coordinate_system = pycolmap.PosePriorCoordinateSystem.CARTESIAN
                prior.corr_data_id = db_images[n].data_id
                db.write_pose_prior(prior)
        for n in names:
            db.write_keypoints(ids[n], to_colmap_xy(feats[n].keypoints).astype(np.float32))
        kept_pairs = []
        for k, (i, j) in enumerate(pairs):
            m, _ = pipe.match(feats[names[i]], feats[names[j]])
            if len(m) >= opts.min_matches:
                db.write_matches(ids[names[i]], ids[names[j]], m.astype(np.uint32))
                kept_pairs.append((names[i], names[j]))
            if (k + 1) % 10 == 0 or k + 1 == len(pairs):
                progress("matching", (k + 1) / len(pairs), f"matched {k + 1} of {len(pairs)} image pairs")
            if (k + 1) % 250 == 0:
                log.info("matched %d / %d pairs", k + 1, len(pairs))
    pipe.sync()
    pairs_file = work / "pairs.txt"
    pairs_file.write_text("\n".join(f"{a} {b}" for a, b in kept_pairs), encoding="utf-8")
    timings["match_s"] = time.perf_counter() - t0
    log.info("matching done: %d of %d pairs kept", len(kept_pairs), len(pairs))

    # 5. geometric verification + incremental SfM ----------------------------- #
    t0 = time.perf_counter()
    tvg = pycolmap.TwoViewGeometryOptions()
    tvg.ransac.max_num_trials = 20000
    tvg.ransac.min_inlier_ratio = 0.1
    progress("sfm", 0.0, "verifying matches")
    pycolmap.verify_matches(db_path, pairs_file, tvg)
    timings["verify_s"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    registered = [0]

    def _on_image(first: bool = False) -> None:
        registered[0] = 2 if first else registered[0] + 1
        # several models may be tried, so the count can exceed the number of images
        frac = min(0.97, 0.05 + 0.92 * registered[0] / len(names))
        progress("sfm", frac, f"reconstructed {min(registered[0], len(names))} of {len(names)} frames")

    def reconstruct(attempt: int) -> dict | None:
        """One run of incremental SfM, outlier removal and metric alignment."""
        mopts = pycolmap.IncrementalPipelineOptions()
        mopts.num_threads = opts.num_threads
        mopts.min_num_matches = opts.min_matches
        if attempt and hasattr(mopts, "random_seed"):
            mopts.random_seed = attempt
        if use_priors:
            mopts.use_prior_position = True
            mopts.use_robust_loss_on_prior_position = True
        registered[0] = 0
        progress("sfm", 0.05, "starting the reconstruction" if not attempt else f"reconstructing again (attempt {attempt + 1})")
        recs = pycolmap.incremental_mapping(
            db_path, img_dir, work / ("models" if not attempt else f"models_{attempt}"), mopts,
            initial_image_pair_callback=lambda: _on_image(True), next_image_callback=_on_image,
        )
        if not recs:
            return None
        rec = max(recs.values(), key=lambda r: r.num_reg_images())
        log.info("SfM: %d models, largest has %d / %d images", len(recs), rec.num_reg_images(), len(names))

        # 6. metric alignment (only when the capture carries metric poses) -------- #
        metric_info: dict = {"metric": False, "scale_m_per_unit": None, "scale_source": None, "pose_priors_used": use_priors}
        reg = sorted((im for im in rec.images.values() if im.has_pose), key=lambda im: im.name)

        # 5b. sequential captures: images that jumped off the camera path are not exported
        dropped: list[str] = [im.name for im in reg if im.num_points3D < opts.min_image_points3D]
        if dropped:
            log.warning("dropping %d images with < %d 3D points: %s", len(dropped), opts.min_image_points3D, dropped)
            reg = [im for im in reg if im.name not in set(dropped)]
        if capture.info.kind != "images":
            bad = find_jump_outliers(
                np.array([im.projection_center() for im in reg]), opts.drop_jump_factor, opts.drop_max_run
            )
            if bad:
                log.warning("dropping %d images that jumped off the camera path: %s", len(bad), [reg[i].name for i in bad])
                dropped += [reg[i].name for i in bad]
                reg = [im for i, im in enumerate(reg) if i not in set(bad)]
        if len(reg) < 3:
            return None
        fraction = None
        posed = [im for im in reg if frames[im.name].frame.T_world_from_arcam is not None]
        if opts.use_metric_poses and len(posed) >= 3:
            src = np.array([im.projection_center() for im in posed])
            dst = np.array([frames[im.name].frame.T_world_from_arcam[:3, 3] for im in posed])
            try:
                sim, inl = g.umeyama_ransac(src, dst, opts.metric_ransac_threshold_m)
                rec.transform(pycolmap.Sim3d(sim.scale, pycolmap.Rotation3d(sim.R), sim.t))
                res = np.linalg.norm(sim.apply(src) - dst, axis=1)
                fraction = float(inl.sum()) / len(posed)
                far = [im.name for im, r in zip(posed, res) if r > opts.metric_drop_m]
                if far and len(reg) - len(far) >= 3:
                    log.warning("dropping %d images further than %.2f m from their recorded position: %s", len(far), opts.metric_drop_m, far)
                    dropped += far
                else:
                    far = []
                metric_info = {
                    "pose_priors_used": use_priors,
                    "metric": True,
                    "scale_m_per_unit": 1.0,
                    "scale_source": f"capture poses ({capture.info.kind})",
                    "metric_alignment": {
                        "frames_with_pose": len(posed),
                        "inliers": int(inl.sum()),
                        "inlier_fraction": round(fraction, 3),
                        "rms_m": float(np.sqrt(np.mean(res[inl] ** 2))),
                        "median_m": float(np.median(res)),
                        "max_m": float(res.max()),
                        "threshold_m": opts.metric_ransac_threshold_m,
                        "dropped_far_from_recorded_pose": far,
                    },
                    "map_frame": "world frame of the capture poses (AR world of the mapping session: y up)"
                    if capture.info.kind != "tum"
                    else "world frame of the capture poses (motion-capture frame: z up)",
                }
                dropped_set = set(dropped)
                reg = sorted(
                    (im for im in rec.images.values() if im.has_pose and im.name not in dropped_set), key=lambda im: im.name
                )
            except ValueError as e:
                log.warning("metric alignment failed (%s); the map stays non-metric", e)
        return {"rec": rec, "num_models": len(recs), "reg": reg, "dropped": dropped, "metric_info": metric_info, "fraction": fraction}

    best: dict | None = None
    attempts = 0
    for attempt in range(max(1, opts.sfm_attempts)):
        attempts += 1
        got = reconstruct(attempt)
        if got is not None and (best is None or (got["fraction"] or 0.0) > (best["fraction"] or 0.0)):
            best = got
        if got is not None and (got["fraction"] is None or got["fraction"] >= opts.metric_min_inlier_fraction):
            break  # nothing to compare with, or good enough
        log.warning("SfM attempt %d: %s", attempt + 1, "no usable model" if got is None else
                    f"only {got['fraction'] * 100:.0f} % of the cameras agree with their recorded positions")
    timings["sfm_s"] = time.perf_counter() - t0
    if best is None:
        raise RuntimeError("SfM failed: no model could be initialised (too little overlap or texture)")
    rec, reg, dropped, metric_info = best["rec"], best["reg"], best["dropped"], best["metric_info"]
    recs = range(best["num_models"])
    build_warnings: list[str] = []
    if len(reg) < 0.6 * len(names):
        build_warnings.append(
            f"only {len(reg)} of {len(names)} selected frames ended up in the map (the others could not be reconstructed reliably): "
            "parts of the room are missing - scan again: slower, with more overlap between views")
    if "metric_alignment" in metric_info:
        ma = metric_info["metric_alignment"]
        ma["sfm_attempts"] = attempts
        if best["fraction"] < opts.metric_min_inlier_fraction:
            build_warnings.append(
                f"the reconstruction disagrees with the recorded AR poses: only {ma['inliers']} of {ma['frames_with_pose']} cameras are within "
                f"{ma['threshold_m'] * 100:.0f} cm of where the recording says they were (median {ma['median_m'] * 100:.0f} cm, {attempts} attempts). "
                "Localisation against this map can be wrong - scan again: slower, with more overlap between views")

    # 7. export --------------------------------------------------------------- #
    progress("sfm", 1.0, f"{len(reg)} of {len(names)} frames reconstructed")
    t0 = time.perf_counter()
    images: list[MapImage] = []
    for im in reg:
        f = feats[im.name]
        pid = np.array([p.point3D_id if p.has_point3D() else -1 for p in im.points2D], dtype=np.int64)
        if len(pid) != len(f.keypoints):
            raise RuntimeError(f"keypoint count mismatch for {im.name}")
        xyz = np.full((len(pid), 3), np.nan, dtype=np.float32)
        for k in np.flatnonzero(pid >= 0):
            xyz[k] = rec.points3D[int(pid[k])].xyz
        images.append(MapImage(im.name, _cam_from_world(im), f, xyz, pid))
    vlad = VLAD.fit(np.concatenate([im.features.descriptors for im in images]), opts.vlad_clusters)
    gdesc = np.stack([vlad.encode(im.features.descriptors) for im in images])

    rec.write(map_dir / "sfm")
    try:
        rec.export_PLY(map_dir / "points.ply")
    except Exception as e:  # cosmetic only
        log.warning("PLY export failed: %s", e)

    cam = rec.cameras[reg[0].camera_id]
    pts = np.array([p.xyz for p in rec.points3D.values()])
    centers = np.array([im.center for im in images])
    timings["export_s"] = time.perf_counter() - t0
    timings["total_s"] = time.perf_counter() - t_all
    meta = {
        "format_version": FORMAT_VERSION,
        "map_id": map_id,
        "created_utc": utc_now(),
        "source": {**asdict(capture.info), "path": str(input_path)},
        "frame_selection": sel_stats,
        "features": {
            "extractor": EXTRACTOR_NAME,
            "matcher": MATCHER_NAME,
            "max_keypoints": pipe.max_keypoints,
            "image_max_size": opts.max_size,
            "global_descriptor": f"vlad-{len(vlad.centers)}x{vlad.centers.shape[1]}",
        },
        "camera": {
            "model": cam.model.name,
            "width": int(cam.width),
            "height": int(cam.height),
            "params": [float(v) for v in cam.params],
            "fx": float(cam.focal_length_x),
            "fy": float(cam.focal_length_y),
            "cx": float(cam.principal_point_x),
            "cy": float(cam.principal_point_y),
            "source": intr_source,
            "shared_by_all_images": len(rec.cameras) == 1,
        },
        "num_images_selected": len(names),
        "num_images_registered": len(images),
        "dropped_outlier_images": dropped,
        "num_sfm_models": len(recs),
        "num_pairs_matched": len(pairs),
        "num_pairs_kept": len(kept_pairs),
        "num_points3D": int(rec.num_points3D()),
        "mean_reprojection_error_px": float(rec.compute_mean_reprojection_error()),
        "mean_track_length": float(rec.compute_mean_track_length()),
        **metric_info,
        "warnings": build_warnings,
        **({"up": [0.0, 1.0, 0.0]} if metric_info.get("metric") and capture.info.kind == "viro_recording" else {}),
        "bounds": {
            "points_p02": [float(v) for v in np.percentile(pts, 2, axis=0)],
            "points_p98": [float(v) for v in np.percentile(pts, 98, axis=0)],
            "camera_centers_min": [float(v) for v in centers.min(0)],
            "camera_centers_max": [float(v) for v in centers.max(0)],
        },
        "build": {
            "device": pipe.device_name,
            "timings_s": {k: round(v, 1) for k, v in timings.items()},
            "options": {k: v for k, v in asdict(opts).items() if k != "intrinsics"},
            "pycolmap": pycolmap.__version__,
        },
    }
    save_map(map_dir, meta, images, vlad, gdesc)
    if not opts.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    log.info(
        "map %s: %d/%d images, %d points, reproj %.2f px, metric=%s, %.0f s",
        map_id, len(images), len(names), meta["num_points3D"], meta["mean_reprojection_error_px"],
        meta["metric"], timings["total_s"],
    )
    return load_map(map_dir)
