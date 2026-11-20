"""From a built map to its room plan: dense depth of key frames, door boxes, optional mesh.

The geometry itself is in :mod:`locserver.roomplan`; this module produces its
inputs from what a map already stores (images, camera poses, sparse 3D points):

* depth: Depth Anything V2 gives inverse depth up to scale and shift per image;
  the two numbers are fitted (RANSAC) to the triangulated SfM points visible in
  that image, which makes the depth metric and consistent with the map;
* door boxes: Grounding DINO on the same key frames;
* mesh (optional): faces of an OBJ/PLY file become extra oriented points.

Runs in the build worker process (see :mod:`locserver.jobs`), never inside a
request handler.
"""

from __future__ import annotations

import json
import logging
import struct
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from . import geometry as g
from .mapstore import LocMap, utc_now
from .roomplan import DepthView, PlanOptions, compute_room_plan, empty_room, transform_room

log = logging.getLogger(__name__)

ROOM_FILE = "room.json"
Progress = Callable[[str, float, str], None]


def map_up(lmap: LocMap) -> np.ndarray | None:
    """Gravity "up" in map coordinates, if the map frame is gravity-aligned."""
    up = lmap.meta.get("up")
    if up is not None:
        return np.asarray(up, dtype=float)
    kind = (lmap.meta.get("source") or {}).get("kind")
    if lmap.metric and kind == "viro_recording":
        return np.array([0.0, 1.0, 0.0])  # ARCore world
    if lmap.metric and kind == "tum":
        return np.array([0.0, 0.0, 1.0])  # motion-capture world of the test data
    return None


def fit_inverse_depth(disp: np.ndarray, z: np.ndarray, rel_tol: float = 0.08, iterations: int = 300, seed: int = 0):
    """``1/z = a*disp + b`` robustly. Returns (a, b, inlier fraction, median relative depth error) or None."""
    disp, z = np.asarray(disp, float), np.asarray(z, float)
    ok = np.isfinite(disp) & np.isfinite(z) & (z > 0.15)
    disp, z = disp[ok], z[ok]
    if len(z) < 20 or np.ptp(disp) < 1e-9:
        return None
    inv = 1.0 / z
    rng = np.random.default_rng(seed)
    best, best_n = None, 0
    for _ in range(iterations):
        i, j = rng.choice(len(z), 2, replace=False)
        if abs(disp[i] - disp[j]) < 1e-9:
            continue
        a = (inv[i] - inv[j]) / (disp[i] - disp[j])
        b = inv[i] - a * disp[i]
        if a <= 0:
            continue
        pred = a * disp + b
        inl = (pred > 0) & (np.abs(1.0 / np.where(pred > 0, pred, 1.0) - z) < rel_tol * z)
        if inl.sum() > best_n:
            best, best_n = inl, int(inl.sum())
    if best is None or best_n < 15:
        return None
    A = np.stack([disp[best], np.ones(best_n)], 1)
    w = z[best]  # weight inverse-depth residuals by depth: approximates relative depth error
    a, b = np.linalg.lstsq(A * w[:, None], inv[best] * w, rcond=None)[0]
    if a <= 0:
        return None
    pred = a * disp + b
    err = np.abs(1.0 / np.where(pred > 0, pred, np.nan) - z) / z
    return float(a), float(b), best_n / len(z), float(np.nanmedian(err))


def depth_view_from_disparity(disp: np.ndarray, im, fx, fy, cx, cy, out_long_side: int = 192, max_depth_m: float = 15.0,
                              unit_m: float = 1.0) -> tuple[DepthView | None, dict]:
    """Metric :class:`DepthView` of map image ``im`` from its relative inverse depth."""
    h, w = disp.shape
    has = np.isfinite(im.xyz).all(1)
    kp = im.features.keypoints[has]
    Xc = im.xyz[has].astype(float) @ im.T_cvcam_from_map[:3, :3].T + im.T_cvcam_from_map[:3, 3]
    xi = np.clip(np.round(kp[:, 0]).astype(int), 0, w - 1)
    yi = np.clip(np.round(kp[:, 1]).astype(int), 0, h - 1)
    fit = fit_inverse_depth(disp[yi, xi], Xc[:, 2] * unit_m)
    info = {"image": im.name, "points": int(has.sum())}
    if fit is None:
        return None, dict(info, used=False, reason="too few 3D points to scale the depth")
    a, b, frac, err = fit
    info.update(inlier_fraction=round(frac, 3), median_rel_error=round(err, 4))
    if frac < 0.35 or err > 0.12:
        return None, dict(info, used=False, reason="depth does not agree with the map points")
    s = out_long_side / max(h, w)
    small = cv2.resize(disp, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    inv = a * small + b
    depth = np.where(inv > 1.0 / max_depth_m, 1.0 / np.maximum(inv, 1e-9), np.nan).astype(np.float32)
    T = g.invert_T(im.T_cvcam_from_map).copy()
    T[:3, 3] *= unit_m
    sx, sy = depth.shape[1] / w, depth.shape[0] / h
    return DepthView(T, fx * sx, fy * sy, cx * sx, cy * sy, depth, name=im.name), dict(info, used=True)


def depth_view_from_metric(depth_z: np.ndarray, im, fx, fy, cx, cy, out_long_side: int = 192, unit_m: float = 1.0) -> DepthView:
    """:class:`DepthView` from a measured depth image (metres, 0/nan = unknown) - used by the evaluation."""
    h, w = depth_z.shape
    s = out_long_side / max(h, w)
    d = np.where(np.isfinite(depth_z) & (depth_z > 0), depth_z, np.nan).astype(np.float32)
    small = cv2.resize(d, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_NEAREST)
    T = g.invert_T(im.T_cvcam_from_map).copy()
    T[:3, 3] *= unit_m
    sx, sy = small.shape[1] / w, small.shape[0] / h
    return DepthView(T, fx * sx, fy * sy, cx * sx, cy * sy, small, name=im.name)


def pick_key_images(lmap: LocMap, max_views: int) -> list:
    n = len(lmap.images)
    if n <= max_views:
        return list(lmap.images)
    return [lmap.images[i] for i in np.unique(np.linspace(0, n - 1, max_views).round().astype(int))]


# -------------------------------------------------------------------- mesh --- #
def _triangles(faces: list[list[int]]) -> np.ndarray:
    tri = [(f[0], f[k], f[k + 1]) for f in faces for k in range(1, len(f) - 1)]
    return np.array(tri, dtype=np.int64).reshape(-1, 3)


def read_obj(path: Path) -> tuple[np.ndarray, np.ndarray]:
    verts, faces = [], []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            if ln.startswith("v "):
                verts.append([float(x) for x in ln.split()[1:4]])
            elif ln.startswith("f "):
                idx = [int(tok.split("/")[0]) for tok in ln.split()[1:]]
                faces.append([i - 1 if i > 0 else len(verts) + i for i in idx])
    return np.array(verts, dtype=float).reshape(-1, 3), _triangles(faces)


_PLY_TYPES = {"char": "b", "int8": "b", "uchar": "B", "uint8": "B", "short": "h", "int16": "h", "ushort": "H", "uint16": "H",
              "int": "i", "int32": "i", "uint": "I", "uint32": "I", "float": "f", "float32": "f", "double": "d", "float64": "d"}


def read_ply(path: Path) -> tuple[np.ndarray, np.ndarray]:
    data = Path(path).read_bytes()
    end = data.find(b"end_header")
    if not data.startswith(b"ply") or end < 0:
        raise ValueError("not a PLY file")
    header = data[:end].decode("ascii", "replace").splitlines()
    body = data[data.index(b"\n", end) + 1 :]
    fmt = next(ln.split()[1] for ln in header if ln.startswith("format"))
    elements, cur = [], None
    for ln in header:
        t = ln.split()
        if t[:1] == ["element"]:
            cur = {"name": t[1], "count": int(t[2]), "props": []}
            elements.append(cur)
        elif t[:1] == ["property"] and cur is not None:
            cur["props"].append(tuple(t[1:]))
    verts, faces = np.zeros((0, 3)), []
    if fmt == "ascii":
        lines = iter(body.decode("ascii", "replace").splitlines())
        for el in elements:
            rows = [next(lines).split() for _ in range(el["count"])]
            names = [p[-1] for p in el["props"]]
            if el["name"] == "vertex":
                ix = [names.index(k) for k in "xyz"]
                verts = np.array([[float(r[i]) for i in ix] for r in rows], dtype=float).reshape(-1, 3)
            elif el["name"] == "face":
                faces = [[int(v) for v in r[1 : 1 + int(r[0])]] for r in rows]
    elif fmt == "binary_little_endian":
        off = 0
        for el in elements:
            if all(p[0] != "list" for p in el["props"]):
                dt = np.dtype([(p[-1], "<" + _PLY_TYPES[p[0]]) for p in el["props"]])
                arr = np.frombuffer(body, dt, el["count"], off)
                off += dt.itemsize * el["count"]
                if el["name"] == "vertex":
                    verts = np.stack([arr["x"], arr["y"], arr["z"]], 1).astype(float)
            else:
                for _ in range(el["count"]):
                    row = None
                    for p in el["props"]:
                        if p[0] == "list":
                            (n,) = struct.unpack_from("<" + _PLY_TYPES[p[1]], body, off)
                            off += struct.calcsize(_PLY_TYPES[p[1]])
                            vals = struct.unpack_from(f"<{n}{_PLY_TYPES[p[2]]}", body, off)
                            off += struct.calcsize(f"<{n}{_PLY_TYPES[p[2]]}")
                            if p[-1] in ("vertex_indices", "vertex_index"):
                                row = list(vals)
                        else:
                            off += struct.calcsize(_PLY_TYPES[p[0]])
                    if el["name"] == "face" and row:
                        faces.append(row)
    else:
        raise ValueError(f"unsupported PLY format {fmt!r}")
    return verts, _triangles(faces)


def mesh_points(path: str | Path, fmt: str | None, cam_centers: np.ndarray, max_points: int = 400_000):
    """Oriented points (face centres + normals turned towards the nearest camera) of an OBJ/PLY mesh."""
    path = Path(path)
    fmt = (fmt or path.suffix.lstrip(".")).lower()
    if fmt not in ("obj", "ply"):
        with open(path, "rb") as fh:
            fmt = "ply" if fh.read(3) == b"ply" else "obj"
    verts, tri = read_ply(path) if fmt == "ply" else read_obj(path)
    if len(tri) == 0:
        raise ValueError(f"the mesh has no faces ({len(verts)} vertices)")
    if tri.max() >= len(verts) or tri.min() < 0:
        raise ValueError("the mesh has faces that refer to missing vertices")
    if len(tri) > max_points:
        tri = tri[np.random.default_rng(0).choice(len(tri), max_points, replace=False)]
    a, b, c = verts[tri[:, 0]], verts[tri[:, 1]], verts[tri[:, 2]]
    n = np.cross(b - a, c - a)
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-10
    cen, n = ((a + b + c) / 3)[ok], n[ok] / ln[ok, None]
    cams = cam_centers[:: max(1, len(cam_centers) // 40)]
    nearest = cams[np.argmin(((cen[:, None, :] - cams[None]) ** 2).sum(-1), axis=1)] if len(cen) < 200_000 else cams.mean(0)
    flip = np.einsum("ij,ij->i", n, nearest - cen) < 0
    n[flip] *= -1
    return cen, n


def save_views(path: str | Path, views: list[DepthView]) -> None:
    """Everything the geometry needs, in one file (for experiments and bug reports)."""
    arrays = {}
    for k, v in enumerate(views):
        arrays[f"T{k}"] = v.T_map_from_cvcam
        arrays[f"K{k}"] = np.array([v.fx, v.fy, v.cx, v.cy])
        arrays[f"D{k}"] = v.depth.astype(np.float16)
        arrays[f"B{k}"] = np.array(v.boxes, dtype=float).reshape(-1, 5)
    np.savez_compressed(path, n=len(views), names=np.array([v.name for v in views]), **arrays)


def load_views(path: str | Path) -> list[DepthView]:
    with np.load(path) as z:
        return [DepthView(z[f"T{k}"], *z[f"K{k}"].tolist(), z[f"D{k}"].astype(np.float32),
                          [tuple(b) for b in z[f"B{k}"].tolist()], str(z["names"][k])) for k in range(int(z["n"]))]


# ------------------------------------------------------------------- stage --- #
def load_room(map_dir: Path) -> dict | None:
    f = Path(map_dir) / ROOM_FILE
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        log.error("cannot read %s: %s", f, e)
        return None


def save_room(map_dir: Path, room: dict) -> None:
    f = Path(map_dir) / ROOM_FILE
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(room, indent=1), encoding="utf-8")
    tmp.replace(f)


def compute_room_for_map(
    lmap: LocMap,
    device: str = "auto",
    mesh_path: str | Path | None = None,
    mesh_format: str | None = None,
    detect_openings: bool = True,
    progress: Progress | None = None,
    max_views: int = 40,
    opts: PlanOptions | None = None,
    depth_provider: Callable | None = None,
    box_provider: Callable | None = None,
    views_out: str | Path | None = None,
) -> tuple[dict, list[str]]:
    """Room plan of a map (frame ``map``) and a list of warnings. Does not write anything.

    ``depth_provider(image) -> metric z-depth image or None`` and
    ``box_provider(image, bgr) -> [(x0, y0, x1, y1, score)]`` replace the two
    networks (evaluation with measured depth, tests).
    """
    progress = progress or (lambda stage, frac, msg: None)
    warnings: list[str] = []
    up = map_up(lmap)
    unit = lmap.scale_m_per_unit
    if up is None or unit is None:
        why = "the map is not metric" if unit is None else "the map frame is not gravity-aligned (no recording poses)"
        return dict(empty_room(why), created_utc=utc_now()), warnings
    cam = lmap.camera
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    keys = pick_key_images(lmap, max_views)
    img_dir = lmap.path / "images"
    sources = []

    # ---- depth ---- #
    views: list[DepthView] = []
    used_images = []
    net = None
    try:
        if depth_provider is None:
            from .roomnets import DepthNet

            net = DepthNet(device)
        rejected = 0
        for k, im in enumerate(keys):
            progress("depth", k / len(keys), f"depth of key frame {k + 1} of {len(keys)}")
            bgr = cv2.imread(str(img_dir / im.name), cv2.IMREAD_COLOR)
            if bgr is None:
                continue
            if depth_provider is not None:
                d = depth_provider(im)
                v = depth_view_from_metric(d, im, fx, fy, cx, cy, unit_m=unit) if d is not None else None
            else:
                v, info = depth_view_from_disparity(net.disparity(bgr), im, fx, fy, cx, cy, unit_m=unit)
                rejected += v is None
            if v is not None:
                views.append(v)
                used_images.append((im, bgr))
        sources.append("measured_depth" if depth_provider is not None else "mono_depth")
        if rejected:
            warnings.append(f"depth of {rejected} of {len(keys)} key frames did not agree with the map points and was not used")
    finally:
        if net is not None:
            from .roomnets import release

            release(net)
    progress("depth", 1.0, f"{len(views)} depth views")

    # ---- door boxes ---- #
    if detect_openings and views:
        det = None
        try:
            if box_provider is None:
                from .roomnets import DoorNet

                det = DoorNet(device)
            for k, (v, (im, bgr)) in enumerate(zip(views, used_images)):
                progress("room_plan", 0.6 * k / len(views), f"looking for doors in key frame {k + 1} of {len(views)}")
                if box_provider is not None:
                    v.boxes = list(box_provider(im, bgr))
                else:
                    hh, ww = bgr.shape[:2]
                    v.boxes = [(b.x0 / ww, b.y0 / hh, b.x1 / ww, b.y1 / hh, b.score) for b in det.detect(bgr)]
            sources.append("door_detector")
        except Exception as e:  # the plan is still useful without the detector
            log.exception("door detector failed")
            warnings.append(f"door detector failed ({type(e).__name__}: {e}); openings come from geometry only")
        finally:
            if det is not None:
                from .roomnets import release

                release(det)

    # ---- mesh ---- #
    extra_p = extra_n = None
    if mesh_path is not None:
        try:
            centers = np.array([im.center for im in lmap.images]) * unit
            extra_p, extra_n = mesh_points(mesh_path, mesh_format, centers / unit)
            extra_p = extra_p * unit
            sources.append("mesh")
        except Exception as e:
            warnings.append(f"mesh ignored: {type(e).__name__}: {e}")

    # ---- geometry ---- #
    progress("room_plan", 0.7, "fitting floor, walls and openings")
    if views_out is not None:
        save_views(views_out, views)
    room = compute_room_plan(views, up, extra_p, extra_n, opts)
    if unit != 1.0:  # the plan was computed in metres; the map frame uses map units
        room = dict(transform_room(room, g.Sim3(1.0 / unit, np.eye(3), np.zeros(3)), frame="map"), stats=room.get("stats"))
    room["sources"] = sources
    room["created_utc"] = utc_now()
    room["key_frames"] = [v.name for v in views]
    progress("room_plan", 1.0, f"{len(room['walls'])} walls, {len(room['corners'])} corners, {len(room['openings'])} openings")
    return room, warnings
