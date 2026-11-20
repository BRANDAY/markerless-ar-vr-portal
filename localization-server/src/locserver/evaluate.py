"""Offline evaluation of localisation accuracy, robustness and speed.

Two protocols:

A. Held-out split of a map (works for any map, no ground truth needed)::

       uv run locserver-evaluate --map-id room

   Some of the map's images are removed from the map in memory (together with
   the 3D points that only they supported), localised against the rest, and the
   result is compared with the pose SfM gave them.

B. Unseen frames against independent ground truth (captures with metric poses,
   e.g. the TUM test sequence or a ViroReact recording)::

       uv run locserver-evaluate --map-id tum_room --gt-capture <sequence folder>

   Frames of the capture that were never used for the map are localised against
   the full map and compared with the capture's own poses.

``--perturb`` degrades the query images (lighting, blur, resolution) as a first
proxy for testing under changed conditions.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

from . import config
from . import geometry as g
from .capture import open_capture
from .features import FeaturePipeline
from .localize import LocalizeOptions, Localizer
from .mapstore import LocMap, load_map, utc_now


# --------------------------------------------------------------------------- #
def _gamma(img: np.ndarray, gamma: float) -> np.ndarray:
    lut = (np.linspace(0, 1, 256) ** gamma * 255).astype(np.uint8)
    return cv2.LUT(img, lut)


def _gain(img: np.ndarray, a: float, b: float = 0.0) -> np.ndarray:
    return np.clip(img.astype(np.float32) * a + b, 0, 255).astype(np.uint8)


def _noise(img: np.ndarray, sigma: float) -> np.ndarray:
    rng = np.random.default_rng(0)
    return np.clip(img.astype(np.float32) + rng.normal(0, sigma, img.shape), 0, 255).astype(np.uint8)


PERTURBATIONS = {
    "none": lambda im: im,
    "dark": lambda im: _gain(_gamma(im, 2.0), 0.6),  # evening / lights off
    "bright": lambda im: _gain(im, 1.6, 20),  # over-exposure, clipped highlights
    "low_contrast": lambda im: _gain(im, 0.4, 0.6 * 128),  # haze / flat light
    "gamma_bright": lambda im: _gamma(im, 0.5),
    "warm_tint": lambda im: np.clip(im.astype(np.float32) * [0.75, 1.0, 1.2], 0, 255).astype(np.uint8),  # lamp light (BGR)
    "blur": lambda im: cv2.GaussianBlur(im, (0, 0), 2.5),  # defocus / motion
    "downscale": lambda im: cv2.resize(im, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA),
    "noise": lambda im: _noise(im, 12.0),  # high ISO
    "dark_noise": lambda im: _noise(_gain(_gamma(im, 2.0), 0.6), 10.0),
}


def split_indices(n: int, mode: str, every: int, block: int) -> tuple[list[int], list[int]]:
    """(mapping, held-out) image indices, images being in capture order."""
    if mode == "interleaved":
        held = [i for i in range(n) if i % every == every // 2]
    elif mode == "blocks":
        period = block * every
        held = [i for i in range(n) if (i % period) >= period - block]
    else:
        raise ValueError(mode)
    hs = set(held)
    return [i for i in range(n) if i not in hs], held


def summarize(rows: list[dict], unit_m: float | None, extent: float) -> dict:
    """Aggregate per-query rows. ``unit_m`` = metres per map unit (None if unknown)."""
    n = len(rows)
    ok = [r for r in rows if r["success"]]
    good = [r for r in ok if r["quality"] == "good"]
    te = np.array([r["t_err"] for r in ok])
    re = np.array([r["r_err_deg"] for r in ok])
    tms = np.array([r["ms"] for r in rows])
    out = {
        "queries": n,
        "success_rate": len(ok) / n if n else 0.0,
        "good_rate": len(good) / n if n else 0.0,
        "median_inliers": float(np.median([r["inliers"] for r in ok])) if ok else None,
        "time_ms_median": float(np.median(tms)) if n else None,
        "time_ms_p90": float(np.percentile(tms, 90)) if n else None,
    }
    if ok:
        s = unit_m or 1.0
        out.update(
            t_err_median=float(np.median(te) * s),
            t_err_p90=float(np.percentile(te, 90) * s),
            t_err_max=float(te.max() * s),
            t_err_unit="m" if unit_m else "map units",
            t_err_median_pct_of_extent=float(np.median(te) / extent * 100) if extent > 0 else None,
            r_err_median_deg=float(np.median(re)),
            r_err_p90_deg=float(np.percentile(re, 90)),
            r_err_max_deg=float(re.max()),
        )
        if unit_m:
            for cm, deg in ((5, 5), (10, 10), (25, 10)):
                hit = sum(1 for r in ok if r["t_err"] * s <= cm / 100 and r["r_err_deg"] <= deg)
                out[f"recall_{cm}cm_{deg}deg"] = hit / n
            # the dangerous case: the server says "good" but the pose is wrong
            out["false_good"] = sum(1 for r in good if r["t_err"] * s > 0.25 or r["r_err_deg"] > 10)
        else:
            out["false_good"] = sum(1 for r in good if r["t_err"] > 0.05 * extent or r["r_err_deg"] > 10)
    return out


def run_queries(loc: Localizer, lmap: LocMap, queries: list[dict], perturb: str, intr_mode: str) -> list[dict]:
    fn = PERTURBATIONS[perturb]
    rows = []
    for q in queries:
        img = fn(q["image"])
        r = loc.localize(lmap, img, assume_map_camera=intr_mode == "map")
        row = {"name": q["name"], "success": r.success, "quality": r.quality, "inliers": r.num_inliers,
               "matches": r.num_matches, "ms": r.timings_ms["total"], "reason": r.reason,
               "focal": r.intrinsics["fx"] if r.intrinsics else None}
        if r.success:
            row["t_err"], row["r_err_deg"] = g.pose_error(g.invert_T(r.T_cvcam_from_map), q["T_map_from_cvcam"])
        rows.append(row)
    return rows


def format_table(results: list[dict]) -> str:
    unit = next((r["summary"].get("t_err_unit") for r in results if r["summary"].get("t_err_unit")), "m")
    cm = unit == "m"
    k = 100.0 if cm else 1.0
    u = "cm" if cm else "units"
    head = ["device", "intrinsics", "perturbation", "n", "success", "good", f"t med [{u}]", f"t p90 [{u}]",
            f"t max [{u}]", "R med [deg]", "R max [deg]", "false good", "ms med", "ms p90"]
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    for r in results:
        s = r["summary"]

        def f(key, mul=1.0, nd=2):
            v = s.get(key)
            return "-" if v is None else f"{v * mul:.{nd}f}"

        lines.append("| " + " | ".join([
            r["device"], r["intrinsics"], r["perturbation"], str(s["queries"]),
            f"{s['success_rate'] * 100:.0f} %", f"{s['good_rate'] * 100:.0f} %",
            f("t_err_median", k, 1 if cm else 4), f("t_err_p90", k, 1 if cm else 4), f("t_err_max", k, 1 if cm else 4),
            f("r_err_median_deg"), f("r_err_max_deg"), str(s.get("false_good", "-")),
            f("time_ms_median", 1, 0), f("time_ms_p90", 1, 0),
        ]) + " |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map-id", required=True)
    ap.add_argument("--maps-dir", default=None)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu", "both"])
    ap.add_argument("--intrinsics", default="both", choices=["map", "estimate", "both"],
                    help="map = query camera known (same as mapping); estimate = focal length unknown")
    ap.add_argument("--perturb", default="none", help="comma list or 'all': " + ", ".join(PERTURBATIONS))
    ap.add_argument("--split", default="blocks", choices=["blocks", "interleaved"])
    ap.add_argument("--holdout-every", type=int, default=5, help="hold out 1/N of the map images")
    ap.add_argument("--block", type=int, default=4, help="consecutive images per held-out block (--split blocks)")
    ap.add_argument("--gt-capture", default=None, help="protocol B: capture with metric poses the map was built from")
    ap.add_argument("--gt-frames", type=int, default=60, help="protocol B: number of unseen frames to test")
    ap.add_argument("--max-queries", type=int, default=0, help="limit the number of queries (0 = all)")
    ap.add_argument("--cpu-max-queries", type=int, default=12, help="queries used for the CPU timing run")
    ap.add_argument("--out", default=None, help="JSON report path")
    a = ap.parse_args(argv)
    config.setup_logging("WARNING")

    map_dir = Path(a.maps_dir or config.maps_dir()) / a.map_id
    full = load_map(map_dir)
    unit_m = full.scale_m_per_unit
    centers = np.array([im.center for im in full.images])
    extent = float(np.linalg.norm(centers.max(0) - centers.min(0)))

    if a.gt_capture:
        if not full.metric:
            raise SystemExit("--gt-capture needs a metric map built from that capture")
        protocol = "B: unseen frames vs. capture ground truth"
        cap = open_capture(a.gt_capture)
        used = {int(Path(im.name).stem) for im in full.images}
        total = cap.info.num_frames or 0
        cand = [i for i in np.linspace(0, total - 1, a.gt_frames * 3).round().astype(int) if i not in used]
        want = set(cand[:: max(1, len(cand) // a.gt_frames)][: a.gt_frames])
        queries, map_gt = [], {}
        to_cv = g.make_T(g.GL_FROM_CV, np.zeros(3))
        for fr in cap.frames(step=1):
            if fr.T_world_from_arcam is None:
                continue
            if fr.index in want:
                queries.append({"name": f"{fr.index:06d}", "image": fr.image, "T_map_from_cvcam": fr.T_world_from_arcam @ to_cv})
            elif fr.index in used:
                map_gt[fr.index] = fr.T_world_from_arcam @ to_cv
        # The pose source (motion-capture markers, ARCore) and the camera's optical frame can
        # differ by a small fixed rotation. Estimate it on the *map* images and remove it from
        # the query ground truth, so that it is not counted as a localisation error.
        offs = []
        for im in full.images:
            gt = map_gt.get(int(Path(im.name).stem))
            if gt is not None and np.linalg.norm(gt[:3, 3] - im.center) < 0.05:
                offs.append(gt[:3, :3].T @ im.T_cvcam_from_map[:3, :3].T)
        R_off = g.mean_rotation(offs) if len(offs) >= 10 else np.eye(3)
        gt_offset_deg = g.rotation_angle_deg(R_off)
        for q in queries:
            q["T_map_from_cvcam"] = g.make_T(q["T_map_from_cvcam"][:3, :3] @ R_off, q["T_map_from_cvcam"][:3, 3])
        protocol += f" (constant GT rotation offset of {gt_offset_deg:.2f} deg removed, from {len(offs)} map images)"
        test_map, n_map = full, len(full.images)
    else:
        protocol = f"A: held-out map images ({a.split}) vs. SfM poses"
        keep, held = split_indices(len(full.images), a.split, a.holdout_every, a.block)
        test_map, n_map = full.subset(keep), len(keep)
        queries = []
        for i in held:
            im = full.images[i]
            img = cv2.imread(str(map_dir / "images" / im.name), cv2.IMREAD_COLOR)
            if img is not None:
                queries.append({"name": im.name, "image": img, "T_map_from_cvcam": g.invert_T(im.T_cvcam_from_map)})
    if a.max_queries:
        queries = queries[: a.max_queries]
    if not queries:
        raise SystemExit("no query frames")

    perturbs = list(PERTURBATIONS) if a.perturb == "all" else [p.strip() for p in a.perturb.split(",")]
    for p in perturbs:
        if p not in PERTURBATIONS:
            raise SystemExit(f"unknown perturbation {p!r}")
    intr_modes = ["map", "estimate"] if a.intrinsics == "both" else [a.intrinsics]
    devices = ["cuda", "cpu"] if a.device == "both" else [a.device]

    print(f"map {a.map_id}: {len(full.images)} images, metric={full.metric}, protocol {protocol}")
    print(f"mapping images used: {n_map}, queries: {len(queries)}, camera-path extent: {extent:.2f} {'m' if unit_m else 'map units'}")
    results = []
    opts = LocalizeOptions()
    t0 = time.perf_counter()
    for dev in devices:
        pipe = FeaturePipeline(dev)
        loc = Localizer(pipe, None, opts)
        loc.localize(test_map, queries[0]["image"], assume_map_camera=True)  # warm-up
        qs = queries if pipe.device == "cuda" or len(devices) == 1 else queries[: a.cpu_max_queries]
        for im_mode in intr_modes:
            for p in perturbs if (pipe.device == "cuda" or len(devices) == 1) else ["none"]:
                rows = run_queries(loc, test_map, qs, p, im_mode)
                s = summarize(rows, unit_m, extent)
                results.append({"device": pipe.device, "intrinsics": im_mode, "perturbation": p, "summary": s, "rows": rows})
                print(f"  {pipe.device:4s} {im_mode:8s} {p:13s} success {s['success_rate'] * 100:5.1f} %  "
                      f"median {s.get('t_err_median', float('nan')):.4f} {s.get('t_err_unit', '')}  {s['time_ms_median']:.0f} ms")
        del loc, pipe

    report = {
        "created_utc": utc_now(), "map_id": a.map_id, "protocol": protocol, "metric": full.metric,
        "scale_m_per_unit": unit_m, "num_map_images": n_map, "num_queries": len(queries),
        "camera_path_extent": extent, "thresholds": opts.thresholds(),
        "elapsed_s": round(time.perf_counter() - t0, 1), "results": results,
    }
    out = Path(a.out) if a.out else config.work_dir() / f"eval_{a.map_id}_{time.strftime('%Y%m%d_%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print()
    print(format_table(results))
    print(f"\nreport: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
