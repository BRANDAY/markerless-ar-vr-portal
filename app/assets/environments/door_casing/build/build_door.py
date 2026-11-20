"""Builds the scalable door casing, the portal "window" and the door leaf for the AR portal.

Output (OBJ models + textures, read by ViroReact through `Viro3DObject type="OBJ"` and ViroMaterials):

  casing_post_left.obj / casing_post_right.obj      straight part of a side casing, 1 m long (scaled in Y)
  casing_corner_left.obj / casing_corner_right.obj  mitred top corner, never scaled
  casing_head.obj                                   straight part of the head casing, 1 m long (scaled in X)
  casing_threshold.obj                              low threshold bar, 1 m long (scaled in X)
  portal_window.obj                                 transparent 1 x 1 m "tunnel" the inner world is seen through
  door_leaf.obj                                     plank door with strap hinges, modelled for 0.83 x 2.01 m
  door_casing.jpg, door_leaf.jpg, portal_window.png textures

Usage:
  python build_door.py --wood-casing <european_walnut_veneer_04_diff_2k.jpg> --wood-leaf <oak_veneer_01_diff_2k.jpg>
                       --out <folder> [--preview <file.glb> --width 0.8 --height 2.0 --leaf right --leaf-angle 105]

The two wood photographs are "European Walnut Veneer 04" and "Oak Veneer 01" from Poly Haven (CC0).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# --------------------------------------------------------------------------------------------
# Dimensions (metres). `app/src/environments/DoorCasing.tsx` repeats the ones it needs.
# --------------------------------------------------------------------------------------------
CASING_W = 0.085      # width of the casing face, outwards from the edge of the opening
FRONT = 0.018         # how far the casing stands out of the wall on the real side (+Z)
LINING_T = 0.022      # thickness of the jamb lining
LINING_D = 0.060      # how far the lining reaches into the inner world (-Z)
THRESHOLD_H = 0.012
TUNNEL_D = 0.055      # depth of the transparent tunnel (inside the lining)

# Cross-section of the casing: (d, z), d = distance outwards from the edge of the opening.
PROFILE = [
    (0.0000, 0.0100), (0.0040, 0.0140), (0.0120, 0.0140), (0.0140, 0.0105), (0.0180, 0.0105),
    (0.0210, 0.0125), (0.0520, 0.0125), (0.0550, 0.0150), (0.0580, 0.0180), (0.0800, 0.0180),
    (0.0850, 0.0130),
    (0.0850, 0.0000), (LINING_T, 0.0000), (LINING_T, -(LINING_D - 0.003)), (LINING_T - 0.003, -LINING_D),
    (0.0030, -LINING_D), (0.0000, -(LINING_D - 0.003)),
]
# Cross-section of the threshold bar: (z, y), open at the bottom.
THRESHOLD_PROFILE = [(-LINING_D, 0.0), (-LINING_D + 0.008, THRESHOLD_H), (0.0030, THRESHOLD_H), (0.0100, 0.0)]

# Texture atlas of the casing: four 256 px columns, 2048 px = ATLAS_LEN_M along the grain.
ATLAS_W, ATLAS_H = 1024, 2048
COL_W, COL_PAD = 256, 8
ATLAS_LEN_M = 2.2
NOMINAL_H, NOMINAL_W = 2.0, 0.8
COL_POST, COL_HEAD, COL_THRESHOLD, COL_FLAT = 0, 1, 2, 3

# Door leaf (model size; the component scales it to the doorway).
LEAF_W, LEAF_H, LEAF_T = 0.83, 2.01, 0.042
LEAF_PLANKS = 5
GROOVE_W, GROOVE_D = 0.003, 0.003
STRAP_Y = (0.26, 1.005, 1.75)
STRAP_HALF, STRAP_LEN, STRAP_RAISE = 0.024, 0.50, 0.004
STUD_X = (-0.07, -0.19, -0.31, -0.43, -0.555)
STUD_R, STUD_H = 0.011, 0.006
RING_X, RING_Y, RING_R, RING_TUBE = -LEAF_W + 0.095, 1.03, 0.040, 0.0055
PLATE_R, PLATE_RAISE = 0.046, 0.003
LEAF_PX_PER_M = 1000.0
FACE_X0, FACE_Y0 = 4, 4
EDGE_X0, EDGE_W = 850, 48
MATCAP_CX, MATCAP_CY, MATCAP_R = 964, 62, 54

IRON = np.array([0.17, 0.165, 0.16])


# --------------------------------------------------------------------------------------------
# Mesh helper
# --------------------------------------------------------------------------------------------
class Mesh:
    def __init__(self, name: str):
        self.name = name
        self.v: list[tuple[float, float, float]] = []
        self.vt: list[tuple[float, float]] = []
        self.tris: list[tuple[int, int, int]] = []

    def tri(self, pts, uvs, hint=None):
        p = np.asarray(pts, dtype=float)
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if np.linalg.norm(n) < 1e-12:
            return
        order = [0, 1, 2]
        if hint is not None and float(np.dot(n, hint)) < 0:
            order = [0, 2, 1]
        base = len(self.v)
        for i in order:
            self.v.append(tuple(float(x) for x in p[i]))
            self.vt.append((float(uvs[i][0]), float(uvs[i][1])))
        self.tris.append((base, base + 1, base + 2))

    def quad(self, pts, uvs, hint=None):
        self.tri([pts[0], pts[1], pts[2]], [uvs[0], uvs[1], uvs[2]], hint)
        self.tri([pts[0], pts[2], pts[3]], [uvs[0], uvs[2], uvs[3]], hint)

    def arrays(self):
        return np.asarray(self.v, dtype=np.float64), np.asarray(self.vt, dtype=np.float64), np.asarray(self.tris)

    def write_obj(self, path: str, header: list[str]) -> None:
        v, vt, tris = self.arrays()
        lines = [f"# {h}" for h in header]
        lines.append(f"o {self.name}")
        fmt = lambda x: ("%.5f" % x).rstrip("0").rstrip(".") if abs(x) > 5e-6 else "0"
        lines += ["v " + " ".join(fmt(c) for c in p) for p in v]
        lines += ["vt " + " ".join(fmt(c) for c in t) for t in vt]
        normals = []
        for a, b, c in tris:
            n = np.cross(v[b] - v[a], v[c] - v[a])
            normals.append(n / np.linalg.norm(n))
        lines += ["vn " + " ".join(fmt(c) for c in n) for n in normals]
        for i, (a, b, c) in enumerate(tris):
            lines.append("f " + " ".join(f"{k + 1}/{k + 1}/{i + 1}" for k in (a, b, c)))
        with open(path, "w", encoding="ascii", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------------------------
# Casing profile: perimeter coordinate and baked shading
# --------------------------------------------------------------------------------------------
def polygon_edges(points, closed=True):
    n = len(points)
    last = n if closed else n - 1
    edges = []
    for i in range(last):
        a = np.array(points[i], dtype=float)
        b = np.array(points[(i + 1) % n], dtype=float)
        edges.append((a, b))
    return edges


def outward_normals(points, closed=True):
    """Unit normals of the polygon edges, pointing away from the solid."""
    pts = np.array(points, dtype=float)
    area = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        area += x0 * y1 - x1 * y0
    sign = 1.0 if area > 0 else -1.0  # counter-clockwise -> outward is (ey, -ex)
    out = []
    for a, b in polygon_edges(points, closed):
        e = b - a
        n = np.array([e[1], -e[0]]) * sign
        out.append(n / np.linalg.norm(n))
    return out


def perimeter_coords(points, closed=True):
    lengths = [float(np.linalg.norm(b - a)) for a, b in polygon_edges(points, closed)]
    total = sum(lengths)
    s = [0.0]
    for length in lengths:
        s.append(s[-1] + length / total)
    return s, total  # s has one more entry than there are edges


def ray_hits(origin, direction, segments, max_dist):
    """Occlusion in [0, 1] of a 2D ray: 1 for a hit at distance 0, fading to 0 at max_dist."""
    best = None
    for a, b in segments:
        e = b - a
        den = direction[0] * e[1] - direction[1] * e[0]
        if abs(den) < 1e-12:
            continue
        w = a - origin
        t = (w[0] * e[1] - w[1] * e[0]) / den
        u = (w[0] * direction[1] - w[1] * direction[0]) / den
        if t > 1e-6 and -1e-9 <= u <= 1 + 1e-9 and (best is None or t < best):
            best = t
    if best is None or best >= max_dist:
        return 0.0
    return 1.0 - best / max_dist


def profile_shading(points, samples, light_of_normal, closed=True, wall=None):
    """Shade (0..1.2) along the perimeter: ambient occlusion in the profile plane times a soft key light."""
    edges = polygon_edges(points, closed)
    normals = outward_normals(points, closed)
    s, _ = perimeter_coords(points, closed)
    segments = list(edges) + ([wall] if wall is not None else [])
    rays = 90
    out = np.zeros(samples)
    for k in range(samples):
        pos = (k + 0.5) / samples
        idx = max(i for i in range(len(edges)) if s[i] <= pos + 1e-12)
        a, b = edges[idx]
        t = (pos - s[idx]) / max(s[idx + 1] - s[idx], 1e-12)
        n = normals[idx]
        p = a + (b - a) * t + n * 1e-5
        occ = 0.0
        for r in range(rays):
            ang = (r + 0.5) / rays * math.pi - math.pi / 2
            c, sn = math.cos(ang), math.sin(ang)
            d = np.array([n[0] * c - n[1] * sn, n[0] * sn + n[1] * c])
            occ += ray_hits(p, d, segments, 0.10) * c
        occ *= (math.pi / rays) / 2.0
        ao = 1.0 - occ
        out[k] = (0.30 + 0.70 * ao) * light_of_normal(n)
    # A slightly lighter line on the convex arrises, as on any used piece of joinery.
    pts = np.array(points, dtype=float)
    n_pts = len(pts)
    _, total = perimeter_coords(points, closed)
    for i in range(n_pts):
        if not closed and i in (0, n_pts - 1):
            continue
        prev_n = normals[(i - 1) % len(normals)]
        next_n = normals[i % len(normals)]
        cross = prev_n[0] * next_n[1] - prev_n[1] * next_n[0]
        area_sign = 1.0  # convex when the turn follows the polygon orientation
        e_sum = 0.0
        for j in range(n_pts):
            x0, y0 = pts[j]
            x1, y1 = pts[(j + 1) % n_pts]
            e_sum += x0 * y1 - x1 * y0
        area_sign = 1.0 if e_sum > 0 else -1.0
        if cross * area_sign <= 0.05:
            continue
        centre = s[i] if i < len(s) else 0.0
        width = 0.0012 / total
        for k in range(samples):
            pos = (k + 0.5) / samples
            dist = min(abs(pos - centre), 1 - abs(pos - centre)) if closed else abs(pos - centre)
            if dist < width * 2:
                out[k] *= 1.0 + 0.16 * max(0.0, 1.0 - dist / (width * 2))
    return out


# --------------------------------------------------------------------------------------------
# Wood photograph helpers
# --------------------------------------------------------------------------------------------
class Wood:
    """A tiling wood photograph with the grain along Y, its real size and the stain applied to it."""

    def __init__(self, path: str, size_m: float, rotate: bool, desaturate: float, gamma: float, stain):
        img = Image.open(path).convert("RGB")
        if rotate:
            img = img.transpose(Image.ROTATE_90)
        self.arr = np.asarray(img, dtype=np.float32) / 255.0
        self.size_m = size_m
        self.desaturate, self.gamma, self.stain = desaturate, gamma, np.array(stain, dtype=np.float32)

    def patch(self, x0_m: float, y0_m: float, w_m: float, h_m: float, w_px: int, h_px: int, gain=1.0) -> np.ndarray:
        """A stained (h_px, w_px, 3) patch of the tiled photograph."""
        ppm = self.arr.shape[0] / self.size_m
        xs = (int(x0_m * ppm) + np.arange(max(2, int(round(w_m * ppm))))) % self.arr.shape[1]
        ys = (int(y0_m * ppm) + np.arange(max(2, int(round(h_m * ppm))))) % self.arr.shape[0]
        patch = self.arr[np.ix_(ys, xs)]
        img = Image.fromarray((patch * 255).astype(np.uint8)).resize((w_px, h_px), Image.LANCZOS)
        return self.grade(np.asarray(img, dtype=np.float32) / 255.0, gain)

    def grade(self, wood: np.ndarray, gain=1.0) -> np.ndarray:
        lum = wood @ np.array([0.30, 0.59, 0.11], dtype=np.float32)
        wood = wood * (1 - self.desaturate) + lum[..., None] * self.desaturate
        return np.clip(np.power(wood, self.gamma) * self.stain * gain, 0.0, 1.0)


def smooth_noise(shape, cell: int, rng) -> np.ndarray:
    h, w = shape
    small = rng.random((h // cell + 2, w // cell + 2)).astype(np.float32)
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


# --------------------------------------------------------------------------------------------
# Casing: texture atlas and models
# --------------------------------------------------------------------------------------------
def column_u(col: int, s: float) -> float:
    return (col * COL_W + COL_PAD + s * (COL_W - 2 * COL_PAD)) / ATLAS_W


def v_post(y_m: float) -> float:
    return 0.02 + y_m / ATLAS_LEN_M


def v_head(x_m: float) -> float:
    return 0.5 + x_m / ATLAS_LEN_M


def build_casing_texture(src: Wood, out_path: str) -> None:
    samples = COL_W - 2 * COL_PAD
    wall = (np.array([CASING_W, 0.0]), np.array([1.5, 0.0]))
    # Posts: the profile lies in the horizontal plane, light comes mostly from the room in front.
    post = profile_shading(PROFILE, samples, lambda n: 0.70 + 0.30 * (0.35 * n[0] + 0.85 * abs(n[1])), wall=wall)
    # Head: profile d = up, so the top edge catches light and the underside (the reveal) is in shade.
    head = profile_shading(PROFILE, samples, lambda n: 0.70 + 0.30 * (0.55 * n[0] + 0.80 * abs(n[1])), wall=wall)
    # Threshold: (z, y) profile, the top face is lit from above and worn.
    thr = profile_shading(THRESHOLD_PROFILE, samples, lambda n: 0.70 + 0.25 * max(0.0, n[1]), closed=False)
    flat = np.full(samples, 0.90)

    _, perimeter = perimeter_coords(PROFILE)
    atlas = np.zeros((ATLAS_H, ATLAS_W, 3), dtype=np.float32)
    rng = np.random.default_rng(7)
    for col, (shade, width_m, x0) in enumerate([(post, perimeter, 0.05), (head, perimeter, 0.62),
                                                 (thr, 0.09, 1.10), (flat, 0.25, 1.40)]):
        wood = src.patch(x0 % src.size_m, 0.3 * col, width_m, ATLAS_LEN_M, samples, ATLAS_H)
        wood *= (0.94 + 0.12 * smooth_noise((ATLAS_H, samples), 96, rng))[:, :, None]
        strip = wood * shade[None, :, None]
        x = col * COL_W
        atlas[:, x + COL_PAD:x + COL_W - COL_PAD] = strip
        atlas[:, x:x + COL_PAD] = strip[:, :1]
        atlas[:, x + COL_W - COL_PAD:x + COL_W] = strip[:, -1:]
    Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8)).save(out_path, quality=90, subsampling=0)


def profile_uvs(col: int, points, closed=True):
    s, _ = perimeter_coords(points, closed)
    return [column_u(col, x) for x in s]


def build_post(side: int) -> Mesh:
    """Straight side casing, y = 0..1 (scaled to the height of the opening). side = +1 right, -1 left."""
    m = Mesh("casing_post_right" if side > 0 else "casing_post_left")
    us = profile_uvs(COL_POST, PROFILE)
    normals = outward_normals(PROFILE)
    n = len(PROFILE)
    for i in range(n):
        (d0, z0), (d1, z1) = PROFILE[i], PROFILE[(i + 1) % n]
        hint = (side * normals[i][0], 0.0, normals[i][1])
        m.quad([(side * d0, 0, z0), (side * d1, 0, z1), (side * d1, 1, z1), (side * d0, 1, z0)],
               [(us[i], v_post(0)), (us[i + 1], v_post(0)), (us[i + 1], v_post(NOMINAL_H)), (us[i], v_post(NOMINAL_H))],
               hint)
    return m


def build_head() -> Mesh:
    """Straight head casing, x = -0.5..0.5 (scaled to the width of the opening), y = 0 at the top of the opening."""
    m = Mesh("casing_head")
    us = profile_uvs(COL_HEAD, PROFILE)
    normals = outward_normals(PROFILE)
    n = len(PROFILE)
    half = NOMINAL_W / 2
    for i in range(n):
        (d0, z0), (d1, z1) = PROFILE[i], PROFILE[(i + 1) % n]
        hint = (0.0, normals[i][0], normals[i][1])
        m.quad([(-0.5, d0, z0), (0.5, d0, z0), (0.5, d1, z1), (-0.5, d1, z1)],
               [(us[i], v_head(-half)), (us[i], v_head(half)), (us[i + 1], v_head(half)), (us[i + 1], v_head(-half))],
               hint)
    return m


def build_corner(side: int) -> Mesh:
    """Mitred top corner; origin = the inner corner of the opening. Never scaled."""
    m = Mesh("casing_corner_right" if side > 0 else "casing_corner_left")
    up = profile_uvs(COL_POST, PROFILE)
    uh = profile_uvs(COL_HEAD, PROFILE)
    normals = outward_normals(PROFILE)
    n = len(PROFILE)
    half = NOMINAL_W / 2
    for i in range(n):
        j = (i + 1) % n
        (d0, z0), (d1, z1) = PROFILE[i], PROFILE[j]
        # Vertical half: continues the post up to the mitre line y = d.
        m.quad([(side * d0, 0, z0), (side * d1, 0, z1), (side * d1, d1, z1), (side * d0, d0, z0)],
               [(up[i], v_post(NOMINAL_H)), (up[i + 1], v_post(NOMINAL_H)),
                (up[i + 1], v_post(NOMINAL_H + d1)), (up[i], v_post(NOMINAL_H + d0))],
               (side * normals[i][0], 0.0, normals[i][1]))
        # Horizontal half: continues the head out to the mitre line x = d.
        m.quad([(0, d0, z0), (0, d1, z1), (side * d1, d1, z1), (side * d0, d0, z0)],
               [(uh[i], v_head(side * half)), (uh[i + 1], v_head(side * half)),
                (uh[i + 1], v_head(side * (half + d1))), (uh[i], v_head(side * (half + d0)))],
               (0.0, normals[i][0], normals[i][1]))
    return m


def build_threshold() -> Mesh:
    m = Mesh("casing_threshold")
    us = profile_uvs(COL_THRESHOLD, THRESHOLD_PROFILE, closed=False)
    half = NOMINAL_W / 2
    for i in range(len(THRESHOLD_PROFILE) - 1):
        (z0, y0), (z1, y1) = THRESHOLD_PROFILE[i], THRESHOLD_PROFILE[i + 1]
        m.quad([(-0.5, y0, z0), (0.5, y0, z0), (0.5, y1, z1), (-0.5, y1, z1)],
               [(us[i], v_head(-half)), (us[i], v_head(half)), (us[i + 1], v_head(half)), (us[i + 1], v_head(-half))],
               (0.0, 1.0, 0.0) if abs(y1 - y0) < 1e-9 else (0.0, 0.5, z0 + z1 - (THRESHOLD_PROFILE[0][0] + THRESHOLD_PROFILE[-1][0])))
    return m


def build_window() -> Mesh:
    """Transparent tunnel, 1 x 1 m, centred on the origin, z = 0 .. -TUNNEL_D.

    Every face is wound towards the real side (+Z) or towards the tunnel axis: once the visitor is
    inside, the portal renderer writes only back faces into the stencil, and a face seen from within
    the tunnel must not count as the way out. Do not "fix" the winding.
    """
    m = Mesh("portal_window")
    a = b = 0.5
    zb = -TUNNEL_D
    uv = [(0.5, 0.5)] * 4

    def quad(pts):
        base = len(m.v)
        for p in pts:
            m.v.append(tuple(float(c) for c in p))
            m.vt.append(uv[0])
        m.tris.append((base, base + 1, base + 2))
        m.tris.append((base, base + 2, base + 3))

    for z in (0.0, zb):
        quad([(-a, -b, z), (a, -b, z), (a, b, z), (-a, b, z)])       # windows, facing +Z
    quad([(-a, -b, 0), (-a, -b, zb), (-a, b, zb), (-a, b, 0)])       # left wall, normal +X
    quad([(a, -b, zb), (a, -b, 0), (a, b, 0), (a, b, zb)])           # right wall, normal -X
    quad([(-a, b, zb), (a, b, zb), (a, b, 0), (-a, b, 0)])           # top wall, normal -Y
    quad([(-a, -b, 0), (a, -b, 0), (a, -b, zb), (-a, -b, zb)])       # bottom wall, normal +Y
    return m


# --------------------------------------------------------------------------------------------
# Door leaf
# --------------------------------------------------------------------------------------------
def face_uv(x: float, y: float):
    px = FACE_X0 + (x + LEAF_W) * LEAF_PX_PER_M
    py = FACE_Y0 + (LEAF_H - y) * LEAF_PX_PER_M
    return (px / ATLAS_W, 1.0 - py / ATLAS_H)


def edge_uv(t: float, along_m: float):
    px = EDGE_X0 + 4 + t * (EDGE_W - 8)
    py = FACE_Y0 + (LEAF_H - min(max(along_m, 0.0), LEAF_H)) * LEAF_PX_PER_M
    return (px / ATLAS_W, 1.0 - py / ATLAS_H)


def matcap_uv(normal):
    n = np.asarray(normal, dtype=float)
    n = n / max(np.linalg.norm(n), 1e-9)
    k = 0.94
    return ((MATCAP_CX + MATCAP_R * k * n[0]) / ATLAS_W, 1.0 - (MATCAP_CY - MATCAP_R * k * n[1]) / ATLAS_H)


def strap_outline(yc: float):
    """Outline of a strap hinge (x, y), counter-clockwise, from the hinge edge to the spear point."""
    h, length = STRAP_HALF, STRAP_LEN
    return [(0.0, yc - h), (0.0, yc + h), (-length, yc + h * 0.82), (-length - 0.028, yc + h * 1.75),
            (-length - 0.115, yc), (-length - 0.028, yc - h * 1.75), (-length, yc - h * 0.82)]


def octagon(cx: float, cy: float, r: float, n: int = 8, phase: float = 0.5):
    return [(cx + r * math.cos((k + phase) / n * 2 * math.pi), cy + r * math.sin((k + phase) / n * 2 * math.pi))
            for k in range(n)]


def build_leaf() -> Mesh:
    """Plank door. Hinge axis = the Y axis; the leaf extends to -X; faces at z = +-LEAF_T / 2."""
    m = Mesh("door_leaf")
    half_t = LEAF_T / 2
    plank = LEAF_W / LEAF_PLANKS

    # Cross-section of one face along X: flats with V grooves between the planks.
    xs = [(-LEAF_W, half_t)]
    for k in range(1, LEAF_PLANKS):
        xb = -LEAF_W + k * plank
        xs += [(xb - GROOVE_W, half_t), (xb, half_t - GROOVE_D), (xb + GROOVE_W, half_t)]
    xs.append((0.0, half_t))

    for sign in (1, -1):  # front (+Z) and back (-Z) face
        for (x0, z0), (x1, z1) in zip(xs[:-1], xs[1:]):
            m.quad([(x0, 0, sign * z0), (x1, 0, sign * z1), (x1, LEAF_H, sign * z1), (x0, LEAF_H, sign * z0)],
                   [face_uv(x0, 0), face_uv(x1, 0), face_uv(x1, LEAF_H), face_uv(x0, LEAF_H)],
                   (0.0, 0.0, float(sign)))

        # Strap hinges: raised plates with studs.
        zt = sign * (half_t + STRAP_RAISE)
        zf = sign * half_t
        for yc in STRAP_Y:
            outline = strap_outline(yc)
            centre = (-STRAP_LEN * 0.5, yc)
            for i in range(len(outline)):
                p, q = outline[i], outline[(i + 1) % len(outline)]
                m.tri([(centre[0], centre[1], zt), (p[0], p[1], zt), (q[0], q[1], zt)],
                      [face_uv(*centre), face_uv(*p), face_uv(*q)], (0.0, 0.0, float(sign)))
                e = np.array([q[0] - p[0], q[1] - p[1]])
                n2 = np.array([-e[1], e[0]])  # outline is counter-clockwise -> flip below to point outwards
                n2 = -n2 / max(np.linalg.norm(n2), 1e-9)
                hint = (n2[0], n2[1], 0.0)
                uvn = matcap_uv((n2[0], n2[1], 0.35 * sign))
                m.quad([(p[0], p[1], zf), (q[0], q[1], zf), (q[0], q[1], zt), (p[0], p[1], zt)], [uvn] * 4, hint)
            for sx in STUD_X:
                ring = octagon(sx, yc, STUD_R)
                top = (sx, yc, zt + sign * STUD_H)
                for i in range(8):
                    p, q = ring[i], ring[(i + 1) % 8]
                    m.tri([top, (p[0], p[1], zt), (q[0], q[1], zt)], [face_uv(sx, yc), face_uv(*p), face_uv(*q)],
                          (0.0, 0.0, float(sign)))

        # Ring handle: back plate, boss and a hanging ring.
        zp = sign * (half_t + PLATE_RAISE)
        plate = octagon(RING_X, RING_Y, PLATE_R)
        for i in range(8):
            p, q = plate[i], plate[(i + 1) % 8]
            m.tri([(RING_X, RING_Y, zp), (p[0], p[1], zp), (q[0], q[1], zp)],
                  [face_uv(RING_X, RING_Y), face_uv(*p), face_uv(*q)], (0.0, 0.0, float(sign)))
            mid = np.array([(p[0] + q[0]) / 2 - RING_X, (p[1] + q[1]) / 2 - RING_Y])
            mid = mid / np.linalg.norm(mid)
            m.quad([(p[0], p[1], zf), (q[0], q[1], zf), (q[0], q[1], zp), (p[0], p[1], zp)],
                   [matcap_uv((mid[0], mid[1], 0.35 * sign))] * 4, (mid[0], mid[1], 0.0))
        boss_y = RING_Y + 0.012
        boss = octagon(RING_X, boss_y, 0.013)
        boss_top = (RING_X, boss_y, zp + sign * 0.014)
        for i in range(8):
            p, q = boss[i], boss[(i + 1) % 8]
            nrm = ((p[0] + q[0]) / 2 - RING_X, (p[1] + q[1]) / 2 - boss_y, 0.010 * sign)
            m.tri([boss_top, (p[0], p[1], zp), (q[0], q[1], zp)], [matcap_uv(nrm)] * 3, nrm)
        ring_c = (RING_X, boss_y - RING_R + 0.004, zp + sign * (RING_TUBE + 0.002))
        seg_major, seg_minor = 20, 8
        for a in range(seg_major):
            for b in range(seg_minor):
                corners, uvs = [], []
                for da, db in ((0, 0), (1, 0), (1, 1), (0, 1)):
                    th = (a + da) / seg_major * 2 * math.pi
                    ph = (b + db) / seg_minor * 2 * math.pi
                    radial = np.array([math.cos(th), math.sin(th), 0.0])
                    nrm = radial * math.cos(ph) + np.array([0.0, 0.0, 1.0]) * math.sin(ph)
                    pos = np.array(ring_c) + radial * RING_R + nrm * RING_TUBE
                    corners.append(tuple(pos))
                    uvs.append(matcap_uv((nrm[0], nrm[1], abs(nrm[2]))))
                th = (a + 0.5) / seg_major * 2 * math.pi
                ph = (b + 0.5) / seg_minor * 2 * math.pi
                hint = (math.cos(th) * math.cos(ph), math.sin(th) * math.cos(ph), math.sin(ph))
                m.quad(corners, uvs, hint)

    # Edges of the slab.
    m.quad([(0, 0, -half_t), (0, 0, half_t), (0, LEAF_H, half_t), (0, LEAF_H, -half_t)],
           [edge_uv(0, 0), edge_uv(1, 0), edge_uv(1, LEAF_H), edge_uv(0, LEAF_H)], (1.0, 0.0, 0.0))
    m.quad([(-LEAF_W, 0, -half_t), (-LEAF_W, 0, half_t), (-LEAF_W, LEAF_H, half_t), (-LEAF_W, LEAF_H, -half_t)],
           [edge_uv(0, 0), edge_uv(1, 0), edge_uv(1, LEAF_H), edge_uv(0, LEAF_H)], (-1.0, 0.0, 0.0))
    for y, ny in ((0.0, -1.0), (LEAF_H, 1.0)):
        m.quad([(-LEAF_W, y, -half_t), (0, y, -half_t), (0, y, half_t), (-LEAF_W, y, half_t)],
               [edge_uv(0, 0.2), edge_uv(0, 0.2 + LEAF_W), edge_uv(1, 0.2 + LEAF_W), edge_uv(1, 0.2)], (0.0, ny, 0.0))

    # Hinge knuckles on the hinge edge.
    for yc in STRAP_Y:
        cx, r, hh = 0.007, 0.0115, 0.036
        for i in range(8):
            a0, a1 = i / 8 * 2 * math.pi, (i + 1) / 8 * 2 * math.pi
            p0 = (cx + r * math.cos(a0), r * math.sin(a0))
            p1 = (cx + r * math.cos(a1), r * math.sin(a1))
            am = (a0 + a1) / 2
            nrm = (math.cos(am), 0.0, math.sin(am))
            m.quad([(p0[0], yc - hh, p0[1]), (p1[0], yc - hh, p1[1]), (p1[0], yc + hh, p1[1]), (p0[0], yc + hh, p0[1])],
                   [matcap_uv((0.5 * math.cos(am), 0.2, 1.0))] * 4, nrm)
            for yy, ny in ((yc - hh, -1.0), (yc + hh, 1.0)):
                m.tri([(cx, yy, 0.0), (p0[0], yy, p0[1]), (p1[0], yy, p1[1])], [matcap_uv((0.0, ny, 0.3))] * 3,
                      (0.0, ny, 0.0))
    return m


def build_leaf_texture(src: Wood, out_path: str) -> None:
    rng = np.random.default_rng(11)
    ppm = LEAF_PX_PER_M
    fw, fh = int(round(LEAF_W * ppm)), int(round(LEAF_H * ppm))
    plank_px = fw / LEAF_PLANKS

    # 1. Planks: each one is another piece of the wood photograph.
    face = np.zeros((fh, fw, 3), dtype=np.float32)
    for k in range(LEAF_PLANKS):
        x0, x1 = int(round(k * plank_px)), int(round((k + 1) * plank_px))
        patch = src.patch(rng.uniform(0, 1.6), rng.uniform(0, 1.8), (x1 - x0) / ppm, LEAF_H, x1 - x0, fh)
        tone = rng.uniform(0.88, 1.10) * np.array([1.0, rng.uniform(0.97, 1.03), rng.uniform(0.94, 1.04)])
        face[:, x0:x1] = patch * tone
    face *= (0.90 + 0.20 * smooth_noise((fh, fw), 180, rng))[:, :, None]

    # 2. Grooves between the planks and darker, dirtier wood towards the edges and the floor.
    xs = np.arange(fw, dtype=np.float32)
    shade = np.ones(fw, dtype=np.float32)
    for k in range(1, LEAF_PLANKS):
        dist = np.abs(xs - k * plank_px)
        shade *= np.clip(0.30 + 0.70 * np.clip((dist - 1.5) / 9.0, 0, 1) ** 0.7, 0, 1)
    face *= shade[None, :, None]
    ys = np.arange(fh, dtype=np.float32)
    edge_x = np.clip(np.minimum(xs, fw - 1 - xs) / 18.0, 0, 1)
    edge_y = np.clip(np.minimum(ys, fh - 1 - ys) / 18.0, 0, 1)
    face *= (0.82 + 0.18 * edge_x)[None, :, None] * (0.82 + 0.18 * edge_y)[:, None, None]
    floor = np.clip((fh - ys) / 420.0, 0, 1)  # the bottom 40 cm are a little darker
    face *= (0.86 + 0.14 * floor)[:, None, None]

    # 3. Ironwork masks, drawn at double size and reduced.
    ss = 2
    to_px = lambda x, y: ((x + LEAF_W) * ppm * ss, (LEAF_H - y) * ppm * ss)
    iron_mask = Image.new("L", (fw * ss, fh * ss), 0)
    draw = ImageDraw.Draw(iron_mask)
    for yc in STRAP_Y:
        draw.polygon([to_px(x, y) for x, y in strap_outline(yc)], fill=255)
    draw.polygon([to_px(x, y) for x, y in octagon(RING_X, RING_Y, PLATE_R)], fill=255)
    iron = np.asarray(iron_mask.resize((fw, fh), Image.LANCZOS), dtype=np.float32) / 255.0

    ring_mask = Image.new("L", (fw * ss, fh * ss), 0)
    draw = ImageDraw.Draw(ring_mask)
    cx, cy = to_px(RING_X, RING_Y + 0.012 - RING_R + 0.004)
    ro, ri = (RING_R + RING_TUBE) * ppm * ss, (RING_R - RING_TUBE) * ppm * ss
    draw.ellipse([cx - ro, cy - ro, cx + ro, cy + ro], fill=255)
    draw.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=0)
    ring = np.asarray(ring_mask.resize((fw, fh), Image.LANCZOS), dtype=np.float32) / 255.0

    def blur(arr, radius):
        img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
        return np.asarray(img, dtype=np.float32) / 255.0

    def shift_down(arr, px):
        out = np.zeros_like(arr)
        out[px:] = arr[:-px]
        return out

    # 4. Shadows of the ironwork on the wood (light from above).
    shadow = np.maximum(blur(shift_down(iron, 5), 5.0) * 0.62, blur(shift_down(ring, 9), 5.0) * 0.45)
    shadow = np.maximum(shadow, blur(iron, 2.5) * 0.35)
    face *= (1.0 - shadow)[:, :, None]

    # 5. Iron: hammered dark metal with a light upper bevel and a dark lower one.
    grain = 0.78 + 0.44 * smooth_noise((fh, fw), 7, rng) * (0.6 + 0.4 * smooth_noise((fh, fw), 40, rng))
    rust = smooth_noise((fh, fw), 60, rng)
    metal = IRON[None, None, :] * grain[:, :, None]
    metal = metal * (1.0 + 0.55 * np.clip(rust - 0.55, 0, 1)[:, :, None] * np.array([1.6, 0.6, 0.1]))
    height = blur(iron, 1.6)
    gy = np.zeros_like(height)
    gx = np.zeros_like(height)
    gy[1:-1] = height[2:] - height[:-2]
    gx[:, 1:-1] = height[:, 2:] - height[:, :-2]
    metal = metal * (1.0 + 3.2 * (0.85 * gy + 0.30 * gx))[:, :, None]
    face = face * (1 - iron[:, :, None]) + np.clip(metal, 0, 1) * iron[:, :, None]

    # 6. Studs: small domes with a highlight.
    light = np.array([-0.35, 0.75, 0.56])
    light /= np.linalg.norm(light)
    r_px = STUD_R * ppm
    for yc in STRAP_Y:
        for sx in STUD_X:
            cxp, cyp = (sx + LEAF_W) * ppm, (LEAF_H - yc) * ppm
            x0, x1 = int(cxp - r_px - 4), int(cxp + r_px + 5)
            y0, y1 = int(cyp - r_px - 4), int(cyp + r_px + 9)
            yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
            dx, dy = (xx + 0.5 - cxp) / r_px, (yy + 0.5 - cyp) / r_px
            rr = np.sqrt(dx * dx + dy * dy)
            inside = np.clip((1.0 - rr) * r_px, 0, 1)
            nz = np.sqrt(np.clip(1 - np.minimum(rr, 1) ** 2, 0, 1)) * 0.8 + 0.2
            lam = np.clip(dx * light[0] - dy * light[1] + nz * light[2], 0, 1)
            col = IRON[None, None, :] * (0.60 + 1.3 * lam[:, :, None]) + 0.16 * (lam[:, :, None] ** 10)
            # contact shadow below the stud
            sh = np.clip(1.0 - np.sqrt(dx * dx + (dy - 0.35) ** 2) / 1.35, 0, 1) * 0.5 * (1 - inside)
            region = face[y0:y1, x0:x1]
            region *= (1 - sh)[:, :, None]
            face[y0:y1, x0:x1] = region * (1 - inside[:, :, None]) + np.clip(col, 0, 1) * inside[:, :, None]

    atlas = np.zeros((ATLAS_H, ATLAS_W, 3), dtype=np.float32)
    atlas[:, :] = face.reshape(-1, 3).mean(axis=0) * 0.8
    padded = np.pad(face, ((FACE_Y0, FACE_Y0), (FACE_X0, FACE_X0), (0, 0)), mode="edge")
    atlas[0:padded.shape[0], 0:padded.shape[1]] = padded

    # Edge strip: plain end-grain-ish wood, a little darker.
    strip = src.patch(0.9, 0.2, EDGE_W / ppm, LEAF_H + 0.03, EDGE_W, ATLAS_H, 0.75)
    atlas[:, EDGE_X0:EDGE_X0 + EDGE_W] = strip

    # Matcap patch for the ring, the knuckles and the sides of the ironwork.
    size = MATCAP_R + 6
    yy, xx = np.mgrid[-size:size, -size:size].astype(np.float32)
    mx, my = xx / MATCAP_R, -yy / MATCAP_R
    rr = np.sqrt(mx * mx + my * my)
    scale = np.where(rr > 1, 1 / np.maximum(rr, 1e-6), 1.0)
    mx, my = mx * scale, my * scale
    mz = np.sqrt(np.clip(1 - mx * mx - my * my, 0, 1))
    lam = np.clip(mx * light[0] + my * light[1] + mz * light[2], 0, 1)
    cap = IRON[None, None, :] * (0.60 + 0.95 * lam[:, :, None]) + 0.12 * (lam[:, :, None] ** 12)
    atlas[MATCAP_CY - size:MATCAP_CY + size, MATCAP_CX - size:MATCAP_CX + size] = np.clip(cap, 0, 1)

    Image.fromarray((np.clip(atlas, 0, 1) * 255).astype(np.uint8)).save(out_path, quality=88, subsampling=0)


# --------------------------------------------------------------------------------------------
# Assembly (the same placement rules as DoorCasing.tsx), used for the preview and the checks
# --------------------------------------------------------------------------------------------
def placed(mesh: Mesh, scale=(1, 1, 1), rot_y_deg=0.0, pos=(0, 0, 0)):
    v, vt, tris = mesh.arrays()
    v = v * np.array(scale, dtype=float)
    a = math.radians(rot_y_deg)
    c, s = math.cos(a), math.sin(a)
    x = v[:, 0] * c + v[:, 2] * s
    z = -v[:, 0] * s + v[:, 2] * c
    v = np.stack([x, v[:, 1], z], axis=1) + np.array(pos, dtype=float)
    return v, vt, tris


def assemble(meshes: dict, width: float, height: float, leaf: str | None, leaf_angle: float):
    """Returns two lists of (positions, uvs, triangles) in the doorway frame (origin on the floor)."""
    hw = width / 2
    casing = [
        placed(meshes["casing_post_left"], (1, height, 1), 0, (-hw, 0, 0)),
        placed(meshes["casing_post_right"], (1, height, 1), 0, (hw, 0, 0)),
        placed(meshes["casing_corner_left"], (1, 1, 1), 0, (-hw, height, 0)),
        placed(meshes["casing_corner_right"], (1, 1, 1), 0, (hw, height, 0)),
        placed(meshes["casing_head"], (width, 1, 1), 0, (0, height, 0)),
        placed(meshes["casing_threshold"], (width, 1, 1), 0, (0, 0, 0)),
    ]
    leaf_parts = []
    if leaf:
        lap, gap = 0.015, 0.006
        sx = (width + 2 * lap) / LEAF_W
        sy = (height + lap - gap) / LEAF_H
        hinge_z = -(LINING_D + 0.004 + LEAF_T / 2)
        if leaf == "right":
            leaf_parts.append(placed(meshes["door_leaf"], (sx, sy, 1), -leaf_angle, (hw + lap, gap, hinge_z)))
        else:
            leaf_parts.append(placed(meshes["door_leaf"], (sx, sy, 1), 180 + leaf_angle, (-hw - lap, gap, hinge_z)))
    return casing, leaf_parts


def write_preview(path: str, out_dir: str, meshes: dict, width: float, height: float, leaf, leaf_angle: float) -> None:
    from glbio import GlbBuilder

    casing, leaf_parts = assemble(meshes, width, height, leaf, leaf_angle)
    glb = GlbBuilder("build_door.py (preview only)", "preview of the door casing; textures: Poly Haven, CC0")
    for name, parts, tex in (("casing", casing, "door_casing.jpg"), ("leaf", leaf_parts, "door_leaf.jpg")):
        if not parts:
            continue
        with open(os.path.join(out_dir, tex), "rb") as fh:
            t = glb.add_image(fh.read(), "image/jpeg", tex)
        mat = glb.add_material(name, t, unlit=True, double_sided=True)
        pos, uv, idx, base = [], [], [], 0
        for v, vt, tris in parts:
            pos.append(v)
            uv.append(np.stack([vt[:, 0], 1.0 - vt[:, 1]], axis=1))
            idx.append(tris + base)
            base += len(v)
        glb.add_mesh_node(name, mat, np.concatenate(pos), np.concatenate(idx), uv=np.concatenate(uv))
    glb.write(path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wood-casing", required=True, help="european_walnut_veneer_04_diff_2k.jpg from Poly Haven")
    ap.add_argument("--wood-leaf", required=True, help="oak_veneer_01_diff_2k.jpg from Poly Haven")
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview", help="also write an assembled GLB for viewing (not used by the app)")
    ap.add_argument("--width", type=float, default=NOMINAL_W)
    ap.add_argument("--height", type=float, default=NOMINAL_H)
    ap.add_argument("--leaf", choices=["left", "right", "none"], default="right")
    ap.add_argument("--leaf-angle", type=float, default=105.0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    # European Walnut Veneer 04: 1 x 1 m, grain along X in the file. Oak Veneer 01: 1.83 x 1.83 m, grain along Y.
    walnut = Wood(args.wood_casing, 1.0, True, 0.15, 1.55, (0.82, 0.69, 0.58))
    oak = Wood(args.wood_leaf, 1.83, False, 0.30, 1.50, (0.66, 0.56, 0.47))
    build_casing_texture(walnut, os.path.join(args.out, "door_casing.jpg"))
    build_leaf_texture(oak, os.path.join(args.out, "door_leaf.jpg"))
    Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(os.path.join(args.out, "portal_window.png"))

    meshes = {m.name: m for m in (build_post(-1), build_post(1), build_corner(-1), build_corner(1), build_head(),
                                  build_threshold(), build_window(), build_leaf())}
    header = ["Generated by build/build_door.py - do not edit.",
              "Units: metres. See app/src/environments/DoorCasing.tsx for where each part goes."]
    stats = {"dimensions": {"casingWidth": CASING_W, "front": FRONT, "liningThickness": LINING_T,
                            "liningDepth": LINING_D, "thresholdHeight": THRESHOLD_H, "tunnelDepth": TUNNEL_D,
                            "leafModel": [LEAF_W, LEAF_H, LEAF_T]}, "files": {}}
    for name, mesh in meshes.items():
        path = os.path.join(args.out, name + ".obj")
        mesh.write_obj(path, header)
        v, _, tris = mesh.arrays()
        stats["files"][name + ".obj"] = {"triangles": int(len(tris)), "bytes": os.path.getsize(path),
                                         "min": [round(float(x), 4) for x in v.min(axis=0)],
                                         "max": [round(float(x), 4) for x in v.max(axis=0)]}
    for tex in ("door_casing.jpg", "door_leaf.jpg", "portal_window.png"):
        p = os.path.join(args.out, tex)
        stats["files"][tex] = {"bytes": os.path.getsize(p), "size": list(Image.open(p).size)}
    with open(os.path.join(args.out, "stats.json"), "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=1)
    if args.preview:
        write_preview(args.preview, args.out, meshes, args.width, args.height,
                      None if args.leaf == "none" else args.leaf, args.leaf_angle)
    print(json.dumps(stats["files"], indent=1))


if __name__ == "__main__":
    main()
