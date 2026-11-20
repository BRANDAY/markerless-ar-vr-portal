"""Build the "Sponza atrium" environment for the AR portal app.

Input : Crytek Sponza (OBJ + textures) from the McGuire Computer Graphics Archive, CC BY 3.0.
Output: plain GLB files (no compression extensions) with lighting baked into vertex colours and
        KHR_materials_unlit materials, in the doorway's local frame:
            origin = on the floor, middle of the threshold; +Y up; the scene extends towards -Z;
            +Z is the real-world (AR) side; units are metres, scale 1:1.

Stages (each cached in --work as .npz, delete a file to redo that stage):
  geom  : load OBJ, scale, move into the doorway frame, drop geometry that cannot be seen from the
          walkable ground floor, split long edges so that vertex lighting has enough resolution
  bake  : sky + soft sun + two diffuse bounces per vertex (Embree ray casting)
  export: tone-map, weld vertices, write GLB files and stats.json

Usage:
  python build_sponza.py --src <dir with sponza.obj> --sky <equirect sky jpg> --work <dir> --out <dir>
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from embreex import rtcore_scene as rtcs
from embreex.mesh_construction import TriangleMesh
from PIL import Image

from glbio import GlbBuilder
from objio import load_obj

Image.MAX_IMAGE_PIXELS = None

SCALE = 0.01                      # source units are centimetres
WALL_GAP = 0.01                   # the end wall sits this far on the AR side of the doorway plane
NO_OCCLUDE = {"leaf", "chain", "Material__57"}          # alpha-tested foliage: must not cast blocky shadows
DOOR_END_DECOR = {"Material__25", "Material__298"}   # lion relief and its frame on the end walls
MIN_KEEP_AREA = 0.02              # never-seen triangles smaller than this are kept anyway (m2)

# Lighting (relative units, linear colour)
SUN_ELEVATION, SUN_AZIMUTH = 58.0, 14.0       # degrees; azimuth from +Z (behind the visitor) towards +X
SUN_COLOR = np.array([1.00, 0.93, 0.80]) * 3.2
SUN_RADIUS_DEG = 2.5
SKY_ZENITH = np.array([0.60, 0.76, 1.00]) * 2.4
SKY_HORIZON = np.array([0.88, 0.92, 1.00]) * 1.9
N_SKY, N_SUN, N_BOUNCE, BOUNCES = 192, 16, 64, 7


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------------------- ray casting
class Scene:
    def __init__(self, tris: np.ndarray):
        self.scene = rtcs.EmbreeScene()
        v = np.ascontiguousarray(tris.reshape(-1, 3), dtype=np.float32)
        f = np.arange(len(v), dtype=np.int32).reshape(-1, 3)
        TriangleMesh(self.scene, v, f)

    def cast(self, o: np.ndarray, d: np.ndarray):
        r = self.scene.run(np.ascontiguousarray(o, np.float32), np.ascontiguousarray(d, np.float32), output=1)
        return r["primID"], r["u"], r["v"], r["tfar"]


def fibonacci_sphere(n: int) -> np.ndarray:
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1)


def cosine_disk(n: int) -> np.ndarray:
    """n cosine-weighted directions around +Z (local frame), fixed low-discrepancy pattern."""
    i = np.arange(n) + 0.5
    r = np.sqrt(i / n)
    th = np.pi * (1 + 5 ** 0.5) * i
    x, y = r * np.cos(th), r * np.sin(th)
    return np.stack([x, y, np.sqrt(np.maximum(0.0, 1 - x * x - y * y))], 1)


def frames(n: np.ndarray):
    up = np.where(np.abs(n[:, 1:2]) > 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    t = np.cross(up, n)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    return t, np.cross(n, t)


def sun_dir() -> np.ndarray:
    el, az = np.radians(SUN_ELEVATION), np.radians(SUN_AZIMUTH)
    return np.array([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])


def sky_radiance(d: np.ndarray) -> np.ndarray:
    t = np.clip(d[:, 1:2], 0.0, 1.0) ** 0.6
    return SKY_HORIZON * (1 - t) + SKY_ZENITH * t


# --------------------------------------------------------------------------------------- geometry
def to_door_frame(p: np.ndarray, x_door: float, y_floor: float, z_c: float) -> np.ndarray:
    return np.stack([p[..., 2] - z_c, p[..., 1] - y_floor, -(p[..., 0] - x_door)], -1)


def rot_door(n: np.ndarray) -> np.ndarray:
    return np.stack([n[..., 2], n[..., 1], -n[..., 0]], -1)


def subdivide(A: np.ndarray, M: np.ndarray, max_edge: float):
    """Split every edge longer than max_edge at its midpoint. The decision depends on the edge only,
    so neighbouring triangles stay conforming (no T-junctions). A: (N,3,C) with xyz first."""
    for it in range(16):
        a, b, c = A[:, 0], A[:, 1], A[:, 2]
        s = np.stack([np.linalg.norm(b[:, :3] - a[:, :3], axis=1), np.linalg.norm(c[:, :3] - b[:, :3], axis=1),
                      np.linalg.norm(a[:, :3] - c[:, :3], axis=1)], 1) > max_edge
        code = s[:, 0] + 2 * s[:, 1] + 4 * s[:, 2]
        if not code.any():
            break
        ab, bc, ca = (a + b) / 2, (b + c) / 2, (c + a) / 2
        out, outm = [A[code == 0]], [M[code == 0]]

        def emit(mask, *tris):
            if mask.any():
                for t in tris:
                    out.append(np.stack([x[mask] for x in t], 1))
                    outm.append(M[mask])
        emit(code == 1, (a, ab, c), (ab, b, c))
        emit(code == 2, (a, b, bc), (a, bc, c))
        emit(code == 4, (a, b, ca), (ca, b, c))
        emit(code == 3, (ab, b, bc), (a, ab, bc), (a, bc, c))
        emit(code == 6, (ca, bc, c), (a, b, bc), (a, bc, ca))
        emit(code == 5, (a, ab, ca), (ab, b, c), (ab, c, ca))
        emit(code == 7, (a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca))
        A, M = np.concatenate(out), np.concatenate(outm)
        log(f"  subdivide pass {it + 1}: {len(A)} triangles")
    return A, M


def stage_geom(args, cache: str):
    groups, mats = load_obj(os.path.join(args.src, "sponza.obj"))
    names = sorted(groups)
    P = np.concatenate([groups[n][0] for n in names]) * SCALE
    UV = np.concatenate([groups[n][1] for n in names])
    NR = np.concatenate([groups[n][2] for n in names])
    M = np.concatenate([np.full(len(groups[n][0]), i, np.int32) for i, n in enumerate(names)])
    log(f"loaded {len(P)} triangles, {len(names)} materials")

    # Locate the inner face of the -X end wall, the floor and the court's centre line (model frame).
    sc = Scene(P)
    z_c = -0.4
    prim, _, _, t = sc.cast(np.array([[-11.0, 1.2, z_c + 1.6], [-11.0, 1.2, z_c - 1.6]]), np.array([[-1.0, 0, 0]] * 2))
    x_wall = -11.0 - float(t.min())
    _, _, _, t = sc.cast(np.array([[x_wall + 1.0, 1.5, z_c]]), np.array([[0, -1.0, 0]]))
    y_floor = 1.5 - float(t[0])
    x_door = x_wall + WALL_GAP
    log(f"end wall x={x_wall:.3f}  floor y={y_floor:.3f}  doorway plane x={x_door:.3f}  centre z={z_c}")

    P = to_door_frame(P, x_door, y_floor, z_c)
    NR = rot_door(NR)
    # Geometric normals; repair missing vertex normals and make the winding agree with them.
    g = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    area = 0.5 * np.linalg.norm(g, axis=1)
    ok = area > 1e-10
    P, UV, NR, M, g, area = P[ok], UV[ok], NR[ok], M[ok], g[ok], area[ok]
    gn = g / np.linalg.norm(g, axis=1, keepdims=True)
    ln = np.linalg.norm(NR, axis=2, keepdims=True)
    NR = np.where(ln > 1e-6, NR / np.maximum(ln, 1e-9), gn[:, None, :])
    flip = np.einsum("ij,ij->i", gn, NR.mean(1)) < 0
    for arr in (P, UV, NR):
        arr[flip] = arr[flip][:, [0, 2, 1]]
    log(f"flipped {int(flip.sum())} triangles to match their normals")

    occl = ~np.isin(M, [names.index(n) for n in NO_OCCLUDE if n in names])
    sc = Scene(P[occl])
    occl_ids = np.flatnonzero(occl)

    # Visibility from the walkable ground floor (whole floor, so a later "move" feature stays valid).
    xs = np.arange(-6.0, 6.01, 0.75)             # door frame: X across, Z from 0 down to about -27.3
    zs = np.arange(-0.4, -27.2, -0.75)
    ys = np.array([0.5, 1.2, 1.7, 2.1])
    vp = np.array([[x, y, z] for x in xs for z in zs for y in ys])
    # keep only viewpoints that have a floor right below and are not inside something
    prim, _, _, t = sc.cast(vp, np.tile([[0, -1.0, 0]], (len(vp), 1)))
    vp = vp[(prim >= 0) & (np.abs(t - vp[:, 1]) < 0.15)]
    dirs = fibonacci_sphere(8000)
    seen = np.zeros(len(P), bool)
    for i in range(0, len(vp), 400):
        o = np.repeat(vp[i:i + 400], len(dirs), 0)
        d = np.tile(dirs, (len(vp[i:i + 400]), 1))
        prim, _, _, _ = sc.cast(o, d)
        seen[occl_ids[prim[prim >= 0]]] = True
    log(f"{len(vp)} viewpoints; seen {int(seen.sum())} of {len(P)} triangles")

    keep = seen | (area < MIN_KEEP_AREA) | ~occl
    # Small never-seen triangles are kept only when something of their neighbourhood was seen is hard to
    # tell cheaply; instead drop never-seen geometry outside the atrium's inner volume.
    cen = P.mean(1)
    inside = (np.abs(cen[:, 0]) < 6.4) & (cen[:, 2] < 0.05) & (cen[:, 2] > -27.5) & (cen[:, 1] > -0.1) & (cen[:, 1] < 13.2)
    keep &= seen | inside
    # Nothing may remain on the AR side of the doorway plane except the end wall itself.
    coplanar = (np.abs(P[:, :, 2] - WALL_GAP) < 0.008).all(1)
    gz = gn[:, 2] * np.where(flip, -1.0, 1.0)                # normal after the winding fix
    endwall = coplanar & (gz < -0.5)
    keep &= ~(coplanar & ~endwall)                           # coplanar but facing the real side
    keep &= (P[:, :, 2] < 0.06).all(1)
    decor = np.zeros(len(P), bool)
    for name in DOOR_END_DECOR:                              # would stick out around the doorway
        if name in names:
            decor |= (M == names.index(name)) & (cen[:, 2] > -5.0)
    keep &= ~decor
    # Whatever still pokes past the end wall (ends of side walls, floor, vault) is cut back to it.
    P[:, :, 2] = np.where(endwall[:, None], P[:, :, 2], np.minimum(P[:, :, 2], WALL_GAP))
    keep &= 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1) > 1e-9
    log(f"kept {int(keep.sum())} triangles ({int(endwall.sum())} on the end wall); dropped {int((~keep).sum())}")

    A = np.concatenate([P, UV, NR], 2)                       # (N,3,8)
    wall_flag = endwall[keep].astype(np.int32)
    A2, tag = subdivide(A[keep], np.stack([M[keep], wall_flag], 1), args.edge)
    # Dropped geometry still blocks light, except the decoration removed from around the doorway.
    # A sheet just behind the end wall keeps light from leaking in from the real side.
    g_ = WALL_GAP + 0.002
    top = 12.5                                               # below the roof line: the sun comes over this wall
    sheet = np.array([[[-8.0, -5, g_], [8, -5, g_], [8, top, g_]], [[-8.0, -5, g_], [8, top, g_], [-8, top, g_]]])
    blockers = np.concatenate([P[~keep & occl & ~decor], sheet])
    np.savez(cache, A=A2.astype(np.float32), M=tag[:, 0], W=tag[:, 1], blockers=blockers.astype(np.float32),
             names=np.array(names), frame=np.array([x_door, y_floor, z_c]))
    with open(os.path.join(args.work, "materials.json"), "w", encoding="utf-8") as fh:
        json.dump(mats, fh, indent=1)
    log(f"geom stage done: {len(A2)} triangles")


# --------------------------------------------------------------------------------------- textures
def srgb_to_linear(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load_texture(src: str, mat: dict, max_size: int):
    """Returns (bytes, mime, has_alpha, mean linear albedo) or None when the material has no texture."""
    rel = mat.get("map_Kd")
    if not rel:
        return None
    path = os.path.join(src, rel.replace("\\", "/"))
    im = Image.open(path)
    has_alpha = False
    rgba = im.convert("RGBA")
    if "map_d" in mat:
        mask = Image.open(os.path.join(src, mat["map_d"].replace("\\", "/"))).convert("L").resize(rgba.size)
        rgba.putalpha(mask)
    a = np.asarray(rgba)[:, :, 3]
    has_alpha = bool((a < 250).mean() > 0.002)
    if max(rgba.size) > max_size:
        k = max_size / max(rgba.size)
        rgba = rgba.resize((max(1, round(rgba.size[0] * k)), max(1, round(rgba.size[1] * k))), Image.LANCZOS)
    arr = np.asarray(rgba).astype(np.float64)
    w = arr[:, :, 3:4] / 255.0 if has_alpha else np.ones_like(arr[:, :, 3:4])
    albedo = (srgb_to_linear(arr[:, :, :3]) * w).sum((0, 1)) / max(w.sum(), 1.0)
    buf = io.BytesIO()
    if has_alpha:
        rgba.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png", True, albedo, rgba.size
    rgba.convert("RGB").save(buf, "JPEG", quality=90, optimize=True)
    return buf.getvalue(), "image/jpeg", False, albedo, rgba.size


# --------------------------------------------------------------------------------------- bake
def stage_bake(args, geom_cache: str, cache: str):
    g = np.load(geom_cache, allow_pickle=False)
    A, M, names, blockers = g["A"].astype(np.float64), g["M"], [str(n) for n in g["names"]], g["blockers"]
    mats = json.load(open(os.path.join(args.work, "materials.json"), encoding="utf-8"))
    albedo = np.full((len(names), 3), 0.5)
    for i, n in enumerate(names):
        tex = load_texture(args.src, mats.get(n, {}), 256)
        if tex:
            albedo[i] = np.clip(tex[3], 0.02, 0.85)
    P, NR = A[:, :, 0:3], A[:, :, 5:8]
    NR = NR / np.maximum(np.linalg.norm(NR, axis=2, keepdims=True), 1e-9)
    # One lighting sample per unique (position, normal).
    key = np.concatenate([np.round(P.reshape(-1, 3) * 2000), np.round(NR.reshape(-1, 3) * 20)], 1).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    vp, vn = P.reshape(-1, 3)[first], NR.reshape(-1, 3)[first]
    nv = len(vp)
    log(f"bake: {len(A)} triangles, {nv} lighting samples")

    occl = ~np.isin(M, [names.index(n) for n in NO_OCCLUDE if n in names])
    scene_tris = np.concatenate([P[occl], blockers.astype(np.float64)])
    scene = Scene(scene_tris)
    tri_vid = np.full((len(scene_tris), 3), -1, np.int64)
    tri_vid[: int(occl.sum())] = inv.reshape(-1, 3)[occl]
    tri_alb = np.zeros((len(scene_tris), 3))
    tri_alb[: int(occl.sum())] = albedo[M[occl]]

    rng = np.random.default_rng(7)
    t, b = frames(vn)
    org = vp + vn * 0.003
    org[:, 2] = np.minimum(org[:, 2], -0.02)                 # samples on the end wall start just inside
    rot = rng.random(nv) * 2 * np.pi

    def hemi_dirs(sl, pattern):
        c, s = np.cos(rot[sl])[:, None], np.sin(rot[sl])[:, None]
        x = pattern[None, :, 0] * c - pattern[None, :, 1] * s
        y = pattern[None, :, 0] * s + pattern[None, :, 1] * c
        z = pattern[None, :, 2]
        return x[..., None] * t[sl][:, None, :] + y[..., None] * b[sl][:, None, :] + z[..., None] * vn[sl][:, None, :]

    def gather(pattern, emitted):
        """Mean incoming radiance over the cosine-weighted hemisphere. emitted=None: sky only."""
        out = np.zeros((nv, 3))
        k = len(pattern)
        step = max(1, 4_000_000 // k)
        for i in range(0, nv, step):
            sl = slice(i, min(nv, i + step))
            d = hemi_dirs(sl, pattern).reshape(-1, 3)
            o = np.repeat(org[sl], k, 0)
            prim, u, v, _ = scene.cast(o, d)
            rad = np.zeros((len(d), 3))
            if emitted is None:
                miss = prim < 0
                rad[miss] = sky_radiance(d[miss])
            else:
                hit = np.flatnonzero(prim >= 0)
                ids = tri_vid[prim[hit]]
                valid = ids[:, 0] >= 0
                hit, ids = hit[valid], ids[valid]
                uu, vv = u[hit][:, None], v[hit][:, None]
                e = (1 - uu - vv) * emitted[ids[:, 0]] + uu * emitted[ids[:, 1]] + vv * emitted[ids[:, 2]]
                rad[hit] = e * tri_alb[prim[hit]]
            out[sl] = rad.reshape(-1, k, 3).mean(1)
        return out

    e_sky = gather(cosine_disk(N_SKY), None)
    log("  sky done")
    # Soft sun: a small cone of shadow rays.
    s = sun_dir()
    st, sb = frames(s[None, :])
    disk = cosine_disk(N_SUN)[:, :2] * np.tan(np.radians(SUN_RADIUS_DEG))
    sdirs = s[None, :] + disk[:, :1] * st + disk[:, 1:2] * sb
    sdirs /= np.linalg.norm(sdirs, axis=1, keepdims=True)
    cosl = np.clip(vn @ s, 0.0, None)
    vis = np.zeros(nv)
    lit = np.flatnonzero(cosl > 0)
    for i in range(0, len(lit), 250_000):
        idx = lit[i:i + 250_000]
        o = np.repeat(org[idx], N_SUN, 0)
        d = np.tile(sdirs, (len(idx), 1))
        prim, _, _, _ = scene.cast(o, d)
        vis[idx] = (prim < 0).reshape(-1, N_SUN).mean(1)
    e_sun = (cosl * vis)[:, None] * SUN_COLOR[None, :]
    log("  sun done")
    direct = e_sky + e_sun
    indirect = np.zeros_like(direct)
    last = direct
    for n in range(BOUNCES):
        last = gather(cosine_disk(N_BOUNCE), last)
        indirect += last
        log(f"  bounce {n + 1} done, mean {last.mean():.4f}")
    np.savez(cache, inv=inv, e_sky=e_sky, e_sun=e_sun, indirect=indirect, last=last)


# --------------------------------------------------------------------------------------- export
def tone(e: np.ndarray, exposure: float, white: float) -> np.ndarray:
    """Extended Reinhard per channel; `white` is the exposed value that maps to 1."""
    x = e * exposure
    return np.clip(x * (1 + x / (white * white)) / (1 + x), 0.0, 1.0)


def weld(rows_f: np.ndarray, col: np.ndarray):
    """rows_f: (n, 8) float32 pos/nrm/uv; col: (n, 4) uint8. Returns unique vertices and indices."""
    packed = np.concatenate([np.round(rows_f[:, :3] * 5000), np.round(rows_f[:, 3:6] * 100),
                             np.round(rows_f[:, 6:8] * 8192), col.astype(np.float64)], 1).astype(np.int64)
    _, first, inv = np.unique(packed, axis=0, return_index=True, return_inverse=True)
    return first, inv.reshape(-1)


def sky_dome(sky_path: str, sun_azimuth_deg: float):
    im = Image.open(sky_path).convert("RGB")
    w, h = im.size
    top = im.crop((0, 0, w, h // 2)).resize((4096, 1024), Image.LANCZOS)
    small = np.asarray(top.resize((512, 128))).astype(np.float64).sum(2)
    u_sun = (np.unravel_index(np.argmax(small), small.shape)[1] + 0.5) / 512
    buf = io.BytesIO()
    top.save(buf, "JPEG", quality=88, optimize=True)
    seg, rings, radius = 64, 14, 400.0
    els = np.radians(np.concatenate([[-12.0], np.linspace(0, 90, rings)]))
    az = np.linspace(0, 2 * np.pi, seg + 1)
    pos, uv = [], []
    for el in els:
        for a in az:
            pos.append([np.sin(a) * np.cos(el) * radius, np.sin(el) * radius, np.cos(a) * np.cos(el) * radius])
            v = 1 - np.clip(np.degrees(el), 0, 90) / 90
            uv.append([u_sun + (a - np.radians(sun_azimuth_deg)) / (2 * np.pi), float(np.clip(v, 0.004, 0.994))])
    idx = []
    n = seg + 1
    for r in range(len(els) - 1):
        for s in range(seg):
            a0, a1, b0, b1 = r * n + s, r * n + s + 1, (r + 1) * n + s, (r + 1) * n + s + 1
            idx += [[a0, a1, b1], [a0, b1, b0]]
    return buf.getvalue(), np.array(pos), np.array(uv), np.array(idx)


def stage_export(args, geom_cache: str, bake_cache: str):
    g = np.load(geom_cache, allow_pickle=False)
    bk = np.load(bake_cache)
    A, M, W, names = g["A"].astype(np.float64), g["M"], g["W"].astype(bool), [str(n) for n in g["names"]]
    mats = json.load(open(os.path.join(args.work, "materials.json"), encoding="utf-8"))
    e = bk["e_sky"] + bk["e_sun"] + args.bounce * bk["indirect"] + args.ambient
    lum = e @ np.array([0.2126, 0.7152, 0.0722])
    log("irradiance percentiles 5/25/50/75/95/99:", np.percentile(lum, [5, 25, 50, 75, 95, 99]).round(3))
    c = tone(e, args.exposure, args.white)
    lumc = c @ np.array([0.2126, 0.7152, 0.0722])
    log("vertex colour percentiles 5/25/50/75/95/99:", np.percentile(lumc, [5, 25, 50, 75, 95, 99]).round(3))
    col = np.concatenate([np.round(c * 255), np.full((len(c), 1), 255.0)], 1).astype(np.uint8)[bk["inv"]]  # per corner

    P = A[:, :, 0:3].reshape(-1, 3)
    UV = A[:, :, 3:5].reshape(-1, 2).copy()
    UV[:, 1] = 1.0 - UV[:, 1]                                 # OBJ -> glTF texture origin
    NR = A[:, :, 5:8].reshape(-1, 3)
    NR = NR / np.maximum(np.linalg.norm(NR, axis=1, keepdims=True), 1e-9)
    rows = np.concatenate([P, NR, UV], 1).astype(np.float32)
    corner_mat = np.repeat(M, 3)
    corner_wall = np.repeat(W, 3)

    credit = ("Crytek Sponza (c) 2010 Frank Meinl, Crytek; original Sponza model by Marko Dabrovic; "
              "McGuire Computer Graphics Archive; CC BY 3.0. Converted, relit and optimised for the AR portal app.")
    stats = {"materials": [], "textures": []}

    def build(path: str, select: np.ndarray, with_sky: bool, single_sided: bool):
        gb = GlbBuilder("VR-FESB environment builder", credit)
        tris = verts = 0
        for mi, name in enumerate(names):
            sel = select & (corner_mat == mi)
            if not sel.any():
                continue
            mat = mats.get(name, {})
            tex = load_texture(args.src, mat, args.texture_size)
            tex_index, alpha_mode = None, "OPAQUE"
            base = (1.0, 1.0, 1.0, 1.0)
            if tex:
                data, mime, has_alpha, _, size = tex
                tex_index = gb.add_image(data, mime, name)
                alpha_mode = "MASK" if has_alpha else "OPAQUE"
                stats["textures"].append({"file": os.path.basename(path), "material": name, "size": list(size),
                                          "bytes": len(data), "mime": mime})
            else:
                kd = [float(x) for x in mat.get("Kd", "0.6 0.6 0.6").split()[:3]]
                base = (*kd, 1.0)
            m = gb.add_material(name, tex_index, base_color=base, unlit=True, double_sided=not single_sided,
                                alpha_mode=alpha_mode)
            r, cc = rows[sel], col[sel]
            first, inv = weld(r, cc)
            gb.add_mesh_node(name, m, r[first, 0:3], inv.reshape(-1, 3), nrm=r[first, 3:6], uv=r[first, 6:8], col=cc[first])
            tris += len(inv) // 3
            verts += len(first)
            stats["materials"].append({"file": os.path.basename(path), "material": name, "triangles": len(inv) // 3,
                                       "vertices": int(len(first)), "alpha": alpha_mode})
        if with_sky:
            data, pos, uv, idx = sky_dome(args.sky, SUN_AZIMUTH)
            t = gb.add_image(data, "image/jpeg", "sky")
            m = gb.add_material("sky", t, unlit=True, double_sided=True)
            gb.add_mesh_node("sky_dome", m, pos, idx, uv=uv)
            tris += len(idx)
            verts += len(pos)
            stats["textures"].append({"file": os.path.basename(path), "material": "sky", "size": [4096, 1024],
                                      "bytes": len(data), "mime": "image/jpeg"})
        size = gb.write(path)
        log(f"wrote {path}: {size} bytes, {tris} triangles, {verts} vertices, {len(gb.j['meshes'])} meshes")
        return {"file": os.path.basename(path), "bytes": size, "triangles": tris, "vertices": verts,
                "meshes": len(gb.j["meshes"])}

    os.makedirs(args.out, exist_ok=True)
    files = [build(os.path.join(args.out, "sponza_atrium.glb"), ~corner_wall, True, False)]
    if corner_wall.any():
        files.append(build(os.path.join(args.out, "sponza_atrium_backwall.glb"), corner_wall, False, True))
    bb = P.reshape(-1, 3)
    stats.update({"files": files, "bbox_min": bb.min(0).round(3).tolist(), "bbox_max": bb.max(0).round(3).tolist(),
                  "frame": {"x_door_model_m": float(g["frame"][0]), "y_floor_model_m": float(g["frame"][1]),
                            "z_centre_model_m": float(g["frame"][2]), "wall_gap_m": WALL_GAP},
                  "lighting": {"sun_elevation_deg": SUN_ELEVATION, "sun_azimuth_deg": SUN_AZIMUTH,
                               "exposure": args.exposure, "white": args.white, "bounce": args.bounce,
                               "ambient": args.ambient, "max_edge_m": args.edge}})
    with open(os.path.join(args.work, "stats.json"), "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--sky", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--edge", type=float, default=0.45, help="longest allowed triangle edge, metres")
    ap.add_argument("--texture-size", type=int, default=1024)
    ap.add_argument("--exposure", type=float, default=4.6)
    ap.add_argument("--white", type=float, default=8.0)
    ap.add_argument("--bounce", type=float, default=1.0)
    ap.add_argument("--ambient", type=float, default=0.01)
    args = ap.parse_args()
    os.makedirs(args.work, exist_ok=True)
    geom, bake = os.path.join(args.work, "geom.npz"), os.path.join(args.work, "bake.npz")
    if not os.path.exists(geom):
        stage_geom(args, geom)
        if os.path.exists(bake):
            os.remove(bake)
    if not os.path.exists(bake):
        stage_bake(args, geom, bake)
    stage_export(args, geom, bake)


if __name__ == "__main__":
    main()
