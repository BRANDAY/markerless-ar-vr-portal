"""Minimal Wavefront OBJ/MTL reader used by the environment build scripts.

Returns un-indexed triangles grouped by material: for each material three float32 arrays
(positions Nx3x3, uvs Nx3x2, normals Nx3x3). Polygons are fan-triangulated.
"""
from __future__ import annotations

import os

import numpy as np


def load_mtl(path: str) -> dict[str, dict[str, str]]:
    mats: dict[str, dict[str, str]] = {}
    cur = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.strip().split(None, 1)
            if len(parts) < 2 or parts[0].startswith("#"):
                continue
            key, val = parts[0], parts[1].strip()
            if key == "newmtl":
                cur = mats.setdefault(val, {})
            elif cur is not None:
                cur[key] = val
    return mats


def load_obj(path: str):
    v: list[tuple[float, float, float]] = []
    vt: list[tuple[float, float]] = []
    vn: list[tuple[float, float, float]] = []
    tris: dict[str, list[tuple[int, int, int]]] = {}
    cur = tris.setdefault("__default__", [])
    mtllib = None
    corner_cache: dict[str, tuple[int, int, int]] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line or line[0] == "#":
                continue
            if line.startswith("v "):
                p = line.split()
                v.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("vt "):
                p = line.split()
                vt.append((float(p[1]), float(p[2])))
            elif line.startswith("vn "):
                p = line.split()
                vn.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                corners = []
                for tok in line.split()[1:]:
                    c = corner_cache.get(tok)
                    if c is None or True:
                        parts = tok.split("/")
                        vi = int(parts[0])
                        ti = int(parts[1]) if len(parts) > 1 and parts[1] else 0
                        ni = int(parts[2]) if len(parts) > 2 and parts[2] else 0
                        vi = vi - 1 if vi > 0 else len(v) + vi
                        ti = ti - 1 if ti > 0 else (len(vt) + ti if ti < 0 else -1)
                        ni = ni - 1 if ni > 0 else (len(vn) + ni if ni < 0 else -1)
                        c = (vi, ti, ni)
                    corners.append(c)
                for k in range(1, len(corners) - 1):
                    cur.append((corners[0], corners[k], corners[k + 1]))
            elif line.startswith("usemtl "):
                cur = tris.setdefault(line.split(None, 1)[1].strip(), [])
            elif line.startswith("mtllib "):
                mtllib = line.split(None, 1)[1].strip()
    va = np.asarray(v, dtype=np.float64)
    vta = np.asarray(vt, dtype=np.float64) if vt else np.zeros((1, 2))
    vna = np.asarray(vn, dtype=np.float64) if vn else np.zeros((1, 3))
    out = {}
    for name, lst in tris.items():
        if not lst:
            continue
        idx = np.asarray(lst, dtype=np.int64)  # N x 3 corners x (v, vt, vn)
        pos = va[idx[:, :, 0]]
        uv = vta[np.maximum(idx[:, :, 1], 0)]
        uv[idx[:, :, 1] < 0] = 0.0
        nrm = vna[np.maximum(idx[:, :, 2], 0)]
        out[name] = (pos, uv, nrm)
    mats = load_mtl(os.path.join(os.path.dirname(path), mtllib)) if mtllib else {}
    return out, mats
