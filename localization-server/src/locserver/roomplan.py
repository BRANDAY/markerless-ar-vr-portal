"""Room plan from posed metric depth: floor, ceiling, walls, corners, door openings.

Pure geometry on numpy arrays - no models, no I/O - so it runs in the tests on
synthetic rooms. Inputs are :class:`DepthView` s (a camera pose, intrinsics, a
metric depth image and optionally door boxes of an image detector), the gravity
direction (``up``) and optionally extra oriented points (a room mesh).

Method, in the order of :func:`compute_room_plan`:

1. Every depth image becomes oriented points; all of them are voxel-averaged.
2. Floor / ceiling: strongest levels of the up- / down-facing points below /
   above the cameras.
3. Walls: vertical planes, found by 1-point RANSAC on the points with a
   horizontal normal (a point and its normal define a wall hypothesis). A plane
   is a wall if it is long, tall and not standing in front of a parallel one
   (that would be a cupboard).
4. Corners: intersections of neighbouring walls; wall ends are snapped to them.
5. Openings, geometry: every depth ray that crosses a wall plane says "solid
   here" (the surface was measured on the plane) or "open here" (the
   measurement lies well behind the plane). A door is a floor-standing,
   door-sized run of open columns.
6. Openings, detector: door boxes are projected onto the wall they look at,
   checked against the depth (a door leaf standing open in the room is not in
   the wall plane) and clustered over the views.
7. Both kinds of evidence are merged into one confidence per opening.

Internally everything lives in a *plan frame* ``(a, b, h)`` with ``h`` along
``up``; a wall is the 2D line ``n . (a, b) = d`` with its normal ``n`` pointing
into the room and the in-wall coordinate ``u`` growing to the right for someone
inside the room who faces the wall.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

from . import geometry as g

ROOM_VERSION = 1


@dataclass
class PlanOptions:
    voxel_m: float = 0.05
    max_range_m: float = 6.0
    pixel_stride: int = 2  # depth pixels skipped when making points / casting rays
    horizontal_cos: float = 0.8  # |n.up| above this: floor / ceiling point
    vertical_cos: float = 0.35  # |n.up| below this: wall point
    level_bin_m: float = 0.02
    level_min_points: int = 20  # voxels (5 cm) that must support the floor / the ceiling
    floor_min_below_camera_m: float = 0.9  # the floor is at least this far below the median camera height
    wall_dist_m: float = 0.08
    wall_normal_deg: float = 25.0
    wall_min_length_m: float = 0.8
    wall_min_height_m: float = 1.2
    wall_min_cells: int = 50  # occupied 10 cm cells
    wall_split_gap_m: float = 2.0
    wall_iterations: int = 300
    max_walls: int = 10
    furniture_depth_m: float = 1.2  # a parallel plane this close behind makes the front one furniture
    corner_snap_m: float = 0.8
    cell_m: float = 0.05  # opening grid on a wall
    through_margin_m: float = 0.30
    door_width_m: tuple = (0.55, 1.6)
    door_height_m: tuple = (1.7, 2.5)
    door_default_height_m: float = 2.0
    column_open_fraction: float = 0.7
    column_solid_fraction: float = 0.15
    detector_min_score: float = 0.42  # below this the open-vocabulary detector also fires on monitors, posters, windows
    refine_max_shift_m: float = 0.35  # how far the triangulated map points may move a wall
    refine_min_points: int = 12
    auto_portal_min_confidence: float = 0.5
    seed: int = 0


@dataclass
class DepthView:
    """One posed depth image. ``depth`` is z along the optical axis in metres (nan = unknown)."""

    T_map_from_cvcam: np.ndarray
    fx: float
    fy: float
    cx: float
    cy: float
    depth: np.ndarray
    boxes: list = field(default_factory=list)  # (x0, y0, x1, y1, score), normalised to 0..1 of the image
    name: str = ""

    @property
    def center(self) -> np.ndarray:
        return self.T_map_from_cvcam[:3, 3]

    def rays(self, stride: int):
        """(pixel rows, pixel cols, unit directions in the map, distance along the ray) of the sampled pixels."""
        h, w = self.depth.shape
        ys, xs = np.mgrid[stride // 2 : h : stride, stride // 2 : w : stride]
        z = self.depth[ys, xs]
        d = np.stack([(xs + 0.5 - self.cx) / self.fx, (ys + 0.5 - self.cy) / self.fy, np.ones_like(z, dtype=float)], -1)
        norm = np.linalg.norm(d, axis=-1)
        dirs = (d / norm[..., None]) @ self.T_map_from_cvcam[:3, :3].T
        return ys, xs, dirs, z * norm

    def ray(self, xn: float, yn: float) -> np.ndarray:
        """Unit direction in the map of the normalised image point ``(xn, yn)``."""
        h, w = self.depth.shape
        d = np.array([(xn * w - self.cx) / self.fx, (yn * h - self.cy) / self.fy, 1.0])
        return self.T_map_from_cvcam[:3, :3] @ (d / np.linalg.norm(d))


@dataclass
class Wall:
    n: np.ndarray  # 2D unit normal in the plan frame, into the room
    d: float
    u0: float
    u1: float
    h0: float
    h1: float
    confidence: float = 0.0
    coverage: float = 0.0
    id: str = ""
    support: int = 0  # occupied 10 cm cells that voted for the plane

    @property
    def t(self) -> np.ndarray:
        return np.array([-self.n[1], self.n[0]])

    def point(self, u: float, h: float) -> np.ndarray:
        q = u * self.t + self.d * self.n
        return np.array([q[0], q[1], h])


# --------------------------------------------------------------------------- #
def plan_basis(up) -> np.ndarray:
    """Rows ``e1, e2, up`` of the rotation map -> plan frame."""
    up = np.asarray(up, dtype=float)
    up = up / np.linalg.norm(up)
    a = np.cross(up, [1.0, 0.0, 0.0])
    if np.linalg.norm(a) < 0.5:
        a = np.cross(up, [0.0, 0.0, 1.0])
    e1 = a / np.linalg.norm(a)
    return np.stack([e1, np.cross(up, e1), up])


def voxel_average(points: np.ndarray, normals: np.ndarray, voxel: float):
    if len(points) == 0:
        return points, normals
    key = np.floor(points / voxel).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    n = inv.max() + 1
    cnt = np.bincount(inv, minlength=n)[:, None]
    p = np.stack([np.bincount(inv, points[:, k], n) for k in range(3)], 1) / cnt
    m = np.stack([np.bincount(inv, normals[:, k], n) for k in range(3)], 1)
    ln = np.linalg.norm(m, axis=1)
    ok = ln > 1e-6
    return p[ok], m[ok] / ln[ok, None]


def cloud_from_views(views: list[DepthView], opts: PlanOptions):
    """Oriented points (in the map) of all depth images, voxel-averaged."""
    P, N = [], []
    s = max(1, opts.pixel_stride)
    for v in views:
        z = v.depth[::s, ::s].astype(float)
        h, w = z.shape
        ys, xs = np.mgrid[0:h, 0:w]
        X = np.stack([(xs * s + 0.5 - v.cx) / v.fx * z, (ys * s + 0.5 - v.cy) / v.fy * z, z], -1)
        dx = X[1:-1, 2:] - X[1:-1, :-2]
        dy = X[2:, 1:-1] - X[:-2, 1:-1]
        n = np.cross(dx, dy)
        ln = np.linalg.norm(n, axis=-1)
        c = X[1:-1, 1:-1]
        zc = c[..., 2]
        with np.errstate(invalid="ignore", divide="ignore"):
            n = n / ln[..., None]
            smooth = (np.abs(dx[..., 2]) < 0.12 * zc) & (np.abs(dy[..., 2]) < 0.12 * zc)
            ray = c / np.linalg.norm(c, axis=-1, keepdims=True)
            facing = np.einsum("ijk,ijk->ij", n, ray)
        ok = np.isfinite(zc) & (zc > 0.2) & (zc < opts.max_range_m) & (ln > 0) & smooth & (np.abs(facing) > 0.2)
        n = np.where(facing[..., None] > 0, -n, n)
        R, t = v.T_map_from_cvcam[:3, :3], v.T_map_from_cvcam[:3, 3]
        P.append(c[ok] @ R.T + t)
        N.append(n[ok] @ R.T)
    if not P:
        return np.zeros((0, 3)), np.zeros((0, 3))
    return voxel_average(np.concatenate(P), np.concatenate(N), opts.voxel_m)


def _level(h: np.ndarray, lo: float, hi: float, opts: PlanOptions, prefer: str):
    """Strongest level of ``h`` in ``[lo, hi]`` -> (level, support) or None. ``prefer``: 'low' | 'high'."""
    h = h[(h >= lo) & (h <= hi)]
    if len(h) < opts.level_min_points:
        return None
    b = opts.level_bin_m
    edges = np.arange(h.min() - 5 * b, h.max() + 6 * b, b)
    hist, _ = np.histogram(h, edges)
    sm = np.convolve(hist, np.ones(5), "same")
    peaks = np.flatnonzero((sm >= np.roll(sm, 1)) & (sm >= np.roll(sm, -1)) & (sm >= 0.35 * sm.max()))
    if len(peaks) == 0:
        return None
    k = peaks[0] if prefer == "low" else peaks[-1]
    c = edges[k] + b / 2
    near = h[np.abs(h - c) < 0.08]
    return float(np.median(near)), int(len(near))


# ------------------------------------------------------------------- walls --- #
def _cells(u: np.ndarray, h: np.ndarray, size: float = 0.1) -> np.ndarray:
    return np.unique(np.stack([np.floor(u / size), np.floor(h / size)], 1).astype(np.int64), axis=0)


def fit_walls(q: np.ndarray, n2: np.ndarray, floor: float, top: float, opts: PlanOptions,
              too_low: list[dict] | None = None) -> list[Wall]:
    """Vertical planes among wall points ``q`` (plan frame, Nx3) with 2D unit normals ``n2``.

    ``too_low`` collects the surfaces that are long enough for a wall but were seen
    over too little of their height (a wall behind furniture, or a scan that never
    looked up and down): the caller tells the user about them.
    """
    rng = np.random.default_rng(opts.seed)
    cos_n = np.cos(np.radians(opts.wall_normal_deg))
    alive = np.ones(len(q), bool)
    found: list[Wall] = []
    for _ in range(opts.max_walls * 3):
        idx = np.flatnonzero(alive)
        if len(idx) < opts.wall_min_cells or len(found) >= opts.max_walls:
            break
        best, best_score = None, 0
        for i in rng.choice(idx, size=min(opts.wall_iterations, len(idx)), replace=False):
            dist = (q[idx, :2] - q[i, :2]) @ n2[i]
            inl = idx[(np.abs(dist) < opts.wall_dist_m) & (n2[idx] @ n2[i] > cos_n)]
            if len(inl) <= best_score:
                continue
            t = np.array([-n2[i, 1], n2[i, 0]])
            score = len(_cells(q[inl, :2] @ t, q[inl, 2]))
            if score > best_score:
                best, best_score = (i, inl), score
        if best is None or best_score < opts.wall_min_cells:
            break
        i, inl = best
        # refine: direction by PCA of the inliers, oriented like their normals
        c = q[inl, :2].mean(0)
        _, _, vt = np.linalg.svd(q[inl, :2] - c, full_matrices=False)
        n = np.array([-vt[0, 1], vt[0, 0]])
        if n @ n2[inl].mean(0) < 0:
            n = -n
        if n @ n2[i] < cos_n:  # degenerate PCA (short, thick blob): keep the hypothesis
            n = n2[i]
        d = float(np.median(q[inl, :2] @ n))
        near = np.abs(q[idx, :2] @ n - d) < opts.wall_dist_m
        inl = idx[near & (n2[idx] @ n > cos_n)]
        alive[idx[np.abs(q[idx, :2] @ n - d) < 1.5 * opts.wall_dist_m]] = False
        t = np.array([-n[1], n[0]])
        u, h = q[inl, :2] @ t, q[inl, 2]
        if len(u) == 0:
            continue
        # split along u where nothing was observed for a long stretch
        order = np.argsort(u)
        cuts = np.flatnonzero(np.diff(u[order]) > opts.wall_split_gap_m) + 1
        for part in np.split(order, cuts):
            if len(part) < opts.wall_min_cells:
                continue
            up_, hp = u[part], h[part]
            u0, u1 = np.percentile(up_, [1, 99])
            hspan = np.percentile(hp, 97) - np.percentile(hp, 3)
            ncell = len(_cells(up_, hp))
            if u1 - u0 < opts.wall_min_length_m or hspan < opts.wall_min_height_m or ncell < opts.wall_min_cells:
                if too_low is not None and u1 - u0 >= 2 * opts.wall_min_length_m and ncell >= opts.wall_min_cells:
                    too_low.append({"length_m": round(float(u1 - u0), 2), "seen_height_m": round(float(hspan), 2),
                                    "seen_from_m": round(float(np.percentile(hp, 3) - floor), 2), "_n": n, "_d": d})
                continue
            h1 = top if np.isfinite(top) else float(np.percentile(hp, 98))
            area = max((u1 - u0) * (h1 - floor), 1e-6)
            cov = float(min(1.0, ncell * 0.01 / area))
            found.append(Wall(n, d, float(u0), float(u1), floor, h1, coverage=cov, support=ncell))
    return found


def _ray_hits(wall: Wall, o: np.ndarray, D: np.ndarray, margin: float = 0.0):
    """Where rays ``o + t*D`` (plan frame) cross the wall rectangle from the room side: (t, valid)."""
    n3 = np.array([wall.n[0], wall.n[1], 0.0])
    den = D @ n3
    with np.errstate(divide="ignore", invalid="ignore"):
        tw = (wall.d - o @ n3) / den
        X = o + tw[:, None] * D
    u = X[:, :2] @ wall.t
    ok = (den < -0.05) & (tw > 0.05) & (u >= wall.u0 - margin) & (u <= wall.u1 + margin) & (X[:, 2] >= wall.h0) & (X[:, 2] <= wall.h1)
    return tw, ok


def drop_outside_walls(walls: list[Wall], views: list[DepthView], B: np.ndarray, opts: PlanOptions) -> list[Wall]:
    """Remove planes that were only seen *through* another wall (the far wall of the corridor
    behind an open door is not a wall of this room)."""
    if len(walls) < 2:
        return walls
    on = np.zeros(len(walls))
    behind = np.zeros(len(walls))
    for v in views:
        _, _, dirs, dist = v.rays(max(1, opts.pixel_stride))
        D = dirs.reshape(-1, 3) @ B.T
        dist = dist.reshape(-1)
        o = B @ v.center
        hits = [_ray_hits(w, o, D) for w in walls]
        for k, (tw, ok) in enumerate(hits):
            mine = ok & np.isfinite(dist) & (np.abs(dist - tw) <= np.maximum(0.10, 0.05 * tw))
            if not mine.any():
                continue
            crossed = np.zeros(len(D), bool)
            for j, (tj, okj) in enumerate(hits):
                if j != k:
                    crossed |= okj & (tj < tw - 0.3)
            on[k] += mine.sum()
            behind[k] += (mine & crossed).sum()
    return [w for k, w in enumerate(walls) if not (on[k] > 0 and behind[k] / on[k] > 0.7)]


def _overlap_along(a: Wall, b: Wall) -> float:
    """Length of a's extent that lies within b's extent, measured along b."""
    ua = sorted((a.point(a.u0, 0)[:2] @ b.t, a.point(a.u1, 0)[:2] @ b.t))
    return min(ua[1], b.u1) - max(ua[0], b.u0)


def _drop_duplicates(walls: list[Wall], opts: PlanOptions) -> list[Wall]:
    """Two fits of the same wall (slightly different direction, crossing each other): keep the better supported."""
    keep = []
    for a in sorted(walls, key=lambda w: -w.support):
        dup = False
        for b in keep:
            if a.n @ b.n < np.cos(np.radians(20)):
                continue
            mid = a.point((a.u0 + a.u1) / 2, 0)[:2]
            if abs(mid @ b.n - b.d) < 0.5 and _overlap_along(a, b) > 0.5 * min(a.u1 - a.u0, b.u1 - b.u0):
                dup = True
                break
        if not dup:
            keep.append(a)
    return keep


def _drop_furniture(walls: list[Wall], opts: PlanOptions) -> list[Wall]:
    """A plane with a parallel plane close behind it (over most of its length) is a cupboard, not a wall."""
    keep = []
    for a in walls:
        furniture = False
        for b in walls:
            if b is a or a.n @ b.n < np.cos(np.radians(15)):
                continue
            mid = a.point((a.u0 + a.u1) / 2, 0)[:2]
            behind = b.d - mid @ b.n  # > 0: b's plane is further from the room than a
            # overlap of a's extent with b's, measured along b
            ua = sorted((a.point(a.u0, 0)[:2] @ b.t, a.point(a.u1, 0)[:2] @ b.t))
            ov = min(ua[1], b.u1) - max(ua[0], b.u0)
            if 0.15 < -behind < opts.furniture_depth_m and ov > 0.5 * (a.u1 - a.u0):
                furniture = True
        if not furniture:
            keep.append(a)
    return keep


def refine_walls(walls: list[Wall], sparse: np.ndarray, opts: PlanOptions) -> int:
    """Move every wall onto the triangulated map points that lie on it. Returns how many were moved.

    Dense depth from a network is smooth but can be several per cent off at the
    distance of a wall; the sparse structure-from-motion points are few but
    accurate to centimetres. ``sparse`` is Nx3 in the plan frame.
    """
    moved = 0
    for w in walls:
        u, h = sparse[:, :2] @ w.t, sparse[:, 2]
        sd = sparse[:, :2] @ w.n - w.d
        sel = (u >= w.u0) & (u <= w.u1) & (h > w.h0 + 0.2) & (h < w.h1 - 0.1) & (np.abs(sd) <= opts.refine_max_shift_m)
        if sel.sum() < opts.refine_min_points:
            continue
        b = 0.02
        edges = np.arange(-opts.refine_max_shift_m, opts.refine_max_shift_m + b, b)
        hist = np.convolve(np.histogram(sd[sel], edges)[0], np.ones(3), "same")
        if hist.max() < opts.refine_min_points:
            continue
        # Several layers are common (the wall, a shelf in front of it, things seen through a window).
        # Which of them is the wall cannot be told from sparse points, so only a single clear layer is used.
        peaks = np.flatnonzero((hist >= max(opts.refine_min_points, 0.3 * hist.max())) & (hist > np.roll(hist, 1)) & (hist >= np.roll(hist, -1)))
        if len(peaks) > 1 and np.ptp(edges[peaks]) > 0.08:
            continue
        k = int(np.argmax(hist))
        shift = float(np.median(sd[sel][np.abs(sd[sel] - (edges[k] + b / 2)) <= 0.04]))
        w.d += shift
        moved += 1
        on = (u >= w.u0) & (u <= w.u1) & (h > w.h0 + 0.2) & (h < w.h1 - 0.1) & (np.abs(sparse[:, :2] @ w.n - w.d) <= 0.06)
        if on.sum() >= 30 and np.ptp(u[on]) >= 1.5:  # enough points along the wall to also correct its direction
            P = sparse[on, :2]
            c = P.mean(0)
            _, _, vt = np.linalg.svd(P - c, full_matrices=False)
            n = np.array([-vt[0, 1], vt[0, 0]])
            n = n if n @ w.n > 0 else -n
            if n @ w.n > np.cos(np.radians(8)):
                ends = [w.point(w.u0, 0)[:2], w.point(w.u1, 0)[:2]]
                w.n, w.d = n, float(c @ n)
                w.u0, w.u1 = sorted(float(e @ w.t) for e in ends)
    return moved


def snap_walls(walls: list[Wall], opts: PlanOptions) -> tuple[list[Wall], list[dict]]:
    """:func:`snap_corners`, repeated without the walls that snapping made too short to be walls."""
    walls = list(walls)
    while True:
        saved = [(w.u0, w.u1) for w in walls]
        corners = snap_corners(walls, opts)
        short = [k for k, w in enumerate(walls) if w.u1 - w.u0 < opts.wall_min_length_m]
        if not short:
            return walls, corners
        for w, (u0, u1) in zip(walls, saved):
            w.u0, w.u1 = u0, u1
        walls = [w for k, w in enumerate(walls) if k not in short]


def snap_corners(walls: list[Wall], opts: PlanOptions) -> list[dict]:
    """Snap wall ends to the intersections with neighbouring walls. Returns the corners."""
    cands = []  # (cost, i, end_i, j, end_j, X)
    for i, a in enumerate(walls):
        for j in range(i + 1, len(walls)):
            b = walls[j]
            if abs(a.n @ b.n) > np.cos(np.radians(30)):
                continue
            X = np.linalg.solve(np.stack([a.n, b.n]), np.array([a.d, b.d]))
            ua, ub = X @ a.t, X @ b.t
            ea = min((abs(ua - a.u0), 0), (abs(ua - a.u1), 1))
            eb = min((abs(ub - b.u0), 0), (abs(ub - b.u1), 1))
            if ea[0] <= opts.corner_snap_m and eb[0] <= opts.corner_snap_m:
                cands.append((ea[0] + eb[0], i, ea[1], j, eb[1], X))
    used, corners = set(), []
    for _, i, ei, j, ej, X in sorted(cands, key=lambda c: c[0]):
        if (i, ei) in used or (j, ej) in used:
            continue
        used |= {(i, ei), (j, ej)}
        a, b = walls[i], walls[j]
        for w, e in ((a, ei), (b, ej)):
            if e == 0:
                w.u0 = float(X @ w.t)
            else:
                w.u1 = float(X @ w.t)
        corners.append({"walls": (i, j), "X": X, "ends": (ei, ej)})
    for c in corners:
        a, b = walls[c["walls"][0]], walls[c["walls"][1]]
        ang = float(np.degrees(np.arccos(np.clip(a.n @ b.n, -1, 1))))
        ca = a.point((a.u0 + a.u1) / 2, 0)[:2]
        convex = (ca @ b.n - b.d) > 0  # the room side of b contains a
        c["angle_deg"] = 180.0 - ang if convex else 180.0 + ang
    return corners


def floor_outline(walls: list[Wall], corners: list[dict]):
    """Corner points in order if the walls form one closed loop, else None."""
    if len(walls) < 3 or len(corners) != len(walls):
        return None
    ends = {}  # (wall, end) -> corner index
    for k, c in enumerate(corners):
        for w, e in zip(c["walls"], c["ends"]):
            ends[(w, e)] = k
    if len(ends) != 2 * len(walls):
        return None
    loop, w, e = [], 0, 1
    for _ in range(len(walls)):
        k = ends[(w, e)]
        loop.append(corners[k]["X"])
        cw, ce = corners[k]["walls"], corners[k]["ends"]
        nw, ne = (cw[1], ce[1]) if cw[0] == w else (cw[0], ce[0])
        w, e = nw, 1 - ne
    if w != 0 or e != 1:
        return None
    P = np.array(loop)
    area2 = np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    return P if area2 > 0 else P[::-1]  # counter-clockwise seen from above


# ---------------------------------------------------------------- openings --- #
def wall_evidence(wall: Wall, views: list[DepthView], B: np.ndarray, opts: PlanOptions):
    """Grids over the wall (rows = height, cols = u): rays measured ON the wall, rays that
    went THROUGH it, and the number of views with a through-ray per cell."""
    c = opts.cell_m
    nu = max(1, int(np.ceil((wall.u1 - wall.u0) / c)))
    nh = max(1, int(np.ceil((wall.h1 - wall.h0) / c)))
    solid = np.zeros((nh, nu))
    through = np.zeros((nh, nu))
    nviews = np.zeros((nh, nu))
    n3 = np.array([wall.n[0], wall.n[1], 0.0])
    for v in views:
        _, _, dirs, dist = v.rays(max(1, opts.pixel_stride))
        D = dirs.reshape(-1, 3) @ B.T  # plan frame
        dist = dist.reshape(-1)
        o = B @ v.center
        denom = D @ n3
        with np.errstate(divide="ignore", invalid="ignore"):
            tw = (wall.d - o @ n3) / denom
        ok = np.isfinite(dist) & (denom < -0.2) & (tw > 0.3) & (tw < opts.max_range_m + 2)
        if not ok.any():
            continue
        X = o + tw[ok, None] * D[ok]
        iu = np.floor((X[:, :2] @ wall.t - wall.u0) / c).astype(int)
        ih = np.floor((X[:, 2] - wall.h0) / c).astype(int)
        inside = (iu >= 0) & (iu < nu) & (ih >= 0) & (ih < nh)
        tw_, dp = tw[ok][inside], dist[ok][inside]
        iu, ih = iu[inside], ih[inside]
        tol = np.maximum(0.10, 0.05 * tw_)
        is_solid = np.abs(dp - tw_) <= tol
        is_through = dp > tw_ + np.maximum(opts.through_margin_m, 0.10 * tw_)
        np.add.at(solid, (ih[is_solid], iu[is_solid]), 1)
        np.add.at(through, (ih[is_through], iu[is_through]), 1)
        seen = np.zeros((nh, nu), bool)
        seen[ih[is_through], iu[is_through]] = True
        nviews += seen
    return solid, through, nviews


def openings_from_geometry(wall: Wall, solid, through, nviews, opts: PlanOptions) -> list[dict]:
    c = opts.cell_m
    nh, nu = solid.shape
    tot = solid + through
    r0, r1 = int(round(0.3 / c)), min(nh, int(round(1.7 / c)))
    if r1 - r0 < 5:
        return []
    band_t, band_s, band_n = through[r0:r1], solid[r0:r1], tot[r0:r1]
    known = (band_n > 0).sum(0)
    with np.errstate(divide="ignore", invalid="ignore"):
        cell_open = np.where(band_n > 0, band_t / np.maximum(band_n, 1) > 0.5, False)
        cell_solid = np.where(band_n > 0, band_s / np.maximum(band_n, 1) > 0.5, False)
    rows = r1 - r0
    open_frac = cell_open.sum(0) / rows
    solid_frac = cell_solid.sum(0) / rows
    col_open = (open_frac >= opts.column_open_fraction) & (solid_frac <= opts.column_solid_fraction) & (known >= 0.7 * rows)
    # bridge one- or two-cell gaps
    for k in range(1, nu - 1):
        if not col_open[k] and col_open[k - 1] and col_open[min(nu - 1, k + 2)]:
            col_open[k] = True
    out, k = [], 0
    while k < nu:
        if not col_open[k]:
            k += 1
            continue
        j = k
        while j < nu and col_open[j]:
            j += 1
        width = (j - k) * c
        if opts.door_width_m[0] <= width <= opts.door_width_m[1]:
            # lintel: first row above 1.5 m that is mostly solid across the run
            top, lintel = wall.h1 - wall.h0, False
            for r in range(int(round(1.5 / c)), nh):
                n_r = tot[r, k:j]
                if (n_r > 0).sum() >= 0.5 * (j - k) and solid[r, k:j].sum() > through[r, k:j].sum():
                    top, lintel = r * c, True
                    break
            jamb_l = k == 0 or solid_frac[max(0, k - 4) : k].max(initial=0) > 0.5
            jamb_r = j == nu or solid_frac[j : j + 4].max(initial=0) > 0.5
            views = float(np.median(nviews[r0:r1, k:j].max(0)))
            score = float(open_frac[k:j].mean()) * min(1.0, views / 2.0) * (1.0 if lintel else 0.75)
            score *= 1.0 if (jamb_l and jamb_r) else 0.8
            if top > opts.door_height_m[1] + 0.3 and not lintel:
                score *= 0.8  # a passage without a lintel: less door-like
            if top >= opts.door_height_m[0] - 0.1:
                out.append({"u0": wall.u0 + k * c, "u1": wall.u0 + j * c, "top": float(top), "top_known": lintel,
                            "geometry": round(score, 3), "views": int(round(views)), "state": "open"})
        k = j
    return out


def openings_from_detector(walls: list[Wall], views: list[DepthView], B: np.ndarray, opts: PlanOptions) -> list[dict]:
    """Door boxes projected onto the wall they look at. One entry per accepted box."""
    obs = []
    for vi, v in enumerate(views):
        o = B @ v.center
        for x0, y0, x1, y1, score in v.boxes:
            if score < opts.detector_min_score:
                continue
            dc = B @ v.ray((x0 + x1) / 2, (y0 + y1) / 2)
            best = None
            for wi, w in enumerate(walls):
                n3 = np.array([w.n[0], w.n[1], 0.0])
                den = dc @ n3
                if den > -0.3:  # from behind or grazing
                    continue
                tw = (w.d - o @ n3) / den
                X = o + tw * dc
                u = X[:2] @ w.t
                if tw > 0.5 and w.u0 - 0.3 <= u <= w.u1 + 0.3 and w.h0 - 0.2 <= X[2] <= w.h1 + 0.2:
                    if best is None or tw < best[1]:
                        best = (wi, tw, n3)
            if best is None:
                continue
            wi, tw, n3 = best
            w = walls[wi]

            # The box is the image bounding box of a vertical rectangle standing on the floor.
            # Its left side x0 is touched by the bottom-left or the top-left corner (perspective
            # tilts the jambs), so u0 is the larger of the two solutions; likewise for the others.
            Tc = np.linalg.inv(v.T_map_from_cvcam)
            Rcp, tcp = Tc[:3, :3] @ B.T, Tc[:3, 3]
            base = Rcp @ (w.d * n3) + tcp
            cu, ch = Rcp @ np.array([w.t[0], w.t[1], 0.0]), Rcp[:, 2]
            hh, ww = v.depth.shape

            def u_at(xn, h):
                xk = (xn * ww - v.cx) / v.fx
                p0 = base + h * ch
                return (xk * p0[2] - p0[0]) / (cu[0] - xk * cu[2])

            def h_at(yn, u):
                yk = (yn * hh - v.cy) / v.fy
                p0 = base + u * cu
                return (yk * p0[2] - p0[1]) / (ch[1] - yk * ch[2])

            cut = {"l": x0 < 0.02, "r": x1 > 0.98, "t": y0 < 0.02, "b": y1 > 0.98}
            if (cut["t"] and cut["b"]) or sum(cut.values()) > 2:
                continue  # neither the lintel nor the threshold is in the picture: size and position are unknown
            uc = float((o + tw * dc)[:2] @ w.t)
            top_abs = h_at(y0, uc)
            with np.errstate(divide="ignore", invalid="ignore"):
                for _ in range(2):
                    ul = max(u_at(x0, w.h0), u_at(x0, top_abs))
                    ur = min(u_at(x1, w.h0), u_at(x1, top_abs))
                    top_abs = min(h_at(y0, ul), h_at(y0, ur))
                bottom_abs = max(h_at(y1, ul), h_at(y1, ur))
            if not np.all(np.isfinite([ul, ur, top_abs, bottom_abs])) or ur <= ul:
                continue
            top, bottom = top_abs - w.h0, bottom_abs - w.h0
            width = ur - ul
            if not (opts.door_width_m[0] - 0.1 <= width <= opts.door_width_m[1] + 0.2) and not (cut["l"] or cut["r"]):
                continue
            if not cut["t"] and not (opts.door_height_m[0] - 0.15 <= top <= opts.door_height_m[1] + 0.15):
                continue
            if not cut["b"] and abs(bottom) > 0.35:
                continue
            # depth inside the box: on the plane (closed), behind it (open), in front (not this wall)
            xa, xb = int((x0 + 0.3 * (x1 - x0)) * ww), int((x0 + 0.7 * (x1 - x0)) * ww) + 1
            ya, yb = int((y0 + 0.3 * (y1 - y0)) * hh), int((y0 + 0.7 * (y1 - y0)) * hh) + 1
            patch = v.depth[max(0, ya) : yb, max(0, xa) : xb]
            state = "unknown"
            if np.isfinite(patch).mean() > 0.3 if patch.size else False:
                cz = float(np.cos(np.arccos(np.clip(v.T_map_from_cvcam[:3, 2] @ (B.T @ dc), -1, 1))))
                dp = float(np.nanmedian(patch)) / max(cz, 0.2)  # z -> distance along the centre ray
                if dp < tw - max(0.35, 0.12 * tw):
                    continue
                state = "open" if dp > tw + max(opts.through_margin_m, 0.10 * tw) else "closed"
            obs.append({"wall": wi, "view": vi, "u0": ul, "u1": ur, "top": top, "score": float(score), "cut": cut, "state": state})
    # cluster per wall by interval overlap
    clusters: list[list[dict]] = []
    for ob in sorted(obs, key=lambda o_: -o_["score"]):
        for cl in clusters:
            a = cl[0]
            if a["wall"] != ob["wall"]:
                continue
            inter = min(a["u1"], ob["u1"]) - max(a["u0"], ob["u0"])
            if inter > 0.5 * min(a["u1"] - a["u0"], ob["u1"] - ob["u0"]):
                cl.append(ob)
                break
        else:
            clusters.append([ob])
    out = []
    for cl in clusters:
        lefts = [o_["u0"] for o_ in cl if not o_["cut"]["l"]]
        rights = [o_["u1"] for o_ in cl if not o_["cut"]["r"]]
        tops = [o_["top"] for o_ in cl if not o_["cut"]["t"]]
        if not lefts or not rights:
            continue
        u0, u1 = float(np.median(lefts)), float(np.median(rights))
        if not (opts.door_width_m[0] <= u1 - u0 <= opts.door_width_m[1]):
            continue
        nv = len({o_["view"] for o_ in cl})
        states = [o_["state"] for o_ in cl if o_["state"] != "unknown"]
        state = max(set(states), key=states.count) if states else "unknown"
        score = float(np.mean(sorted((o_["score"] for o_ in cl), reverse=True)[:5]))
        out.append({"wall": cl[0]["wall"], "u0": u0, "u1": u1, "top": float(np.median(tops)) if tops else None,
                    "top_known": bool(tops), "detector": round(score, 3), "views": nv, "state": state})
    return out


def merge_openings(geo: list[dict], det: list[dict], opts: PlanOptions) -> list[dict]:
    """``geo`` entries carry 'wall' too. Noisy-OR of the two kinds of evidence."""
    out, used = [], set()
    for a in geo:
        m = None
        for k, b in enumerate(det):
            if k in used or b["wall"] != a["wall"]:
                continue
            inter = min(a["u1"], b["u1"]) - max(a["u0"], b["u0"])
            if inter > 0.4 * max(a["u1"] - a["u0"], b["u1"] - b["u0"]):
                m = k
                break
        o = dict(a, detector=None)
        if m is not None:
            used.add(m)
            b = det[m]
            o["detector"] = b["detector"]
            o["views"] = max(a["views"], b["views"])
            if not a["top_known"] and b["top_known"]:
                o["top"], o["top_known"] = b["top"], True
        out.append(o)
    out += [dict(b, geometry=None) for k, b in enumerate(det) if k not in used]
    for o in out:
        pg = 0.7 * o["geometry"] if o["geometry"] is not None else 0.0
        # 0.30 is the detector's noise level, 0.60 a clear door; one view alone is never enough for "auto"
        pd = 0.0
        if o["detector"] is not None:
            pd = 0.85 * float(np.clip((o["detector"] - 0.30) / 0.30, 0.0, 1.0)) * min(1.0, 0.4 + 0.2 * o["views"])
        o["confidence"] = round(float(1 - (1 - pg) * (1 - pd)), 3)
        if not o["top_known"] or o["top"] is None or not (opts.door_height_m[0] - 0.15 <= o["top"] <= opts.door_height_m[1] + 0.15):
            o["top"], o["top_known"] = opts.door_default_height_m, False
            o["confidence"] = round(o["confidence"] * 0.9, 3)
    return sorted(out, key=lambda o_: -o_["confidence"])


# -------------------------------------------------------------------- JSON --- #
def _v(x) -> list[float]:
    return [round(float(a), 4) for a in np.asarray(x).ravel()]


def _pose(position, right, up, normal) -> dict:
    R = np.stack([right, up, normal], 1)
    return {"position": _v(position), "rotation_euler_deg": _v(g.rotmat_to_viro_euler(R)),
            "quaternion_xyzw": [round(float(a), 6) for a in g.rotmat_to_quat(R)]}


def _rect(wall: Wall, u0: float, u1: float, h0: float, h1: float, B: np.ndarray) -> dict:
    to_map = B.T
    right = to_map @ np.array([wall.t[0], wall.t[1], 0.0])
    normal = to_map @ np.array([wall.n[0], wall.n[1], 0.0])
    up = B[2]
    P = lambda u, h: to_map @ wall.point(u, h)  # noqa: E731
    center = P((u0 + u1) / 2, (h0 + h1) / 2)
    return {"center": _v(center), "width": round(float(u1 - u0), 4), "height": round(float(h1 - h0), 4), "normal": _v(normal),
            "corners": [_v(P(u0, h0)), _v(P(u1, h0)), _v(P(u1, h1)), _v(P(u0, h1))],
            "pose": _pose(center, right, up, normal)}


def empty_room(reason: str, status: str = "unavailable", up=(0.0, 1.0, 0.0)) -> dict:
    return {"version": ROOM_VERSION, "status": status, "reason": reason, "frame": "map", "up": _v(up), "sources": [],
            "created_utc": None, "floor": None, "ceiling": None, "height": None, "walls": [], "corners": [],
            "openings": [], "best_opening_id": None,
            "thresholds": {"auto_portal_min_confidence": PlanOptions().auto_portal_min_confidence}}


def compute_room_plan(views: list[DepthView], up, extra_points: np.ndarray | None = None,
                      extra_normals: np.ndarray | None = None, opts: PlanOptions | None = None,
                      sparse_points: np.ndarray | None = None) -> dict:
    """The room plan (API JSON, frame ``map``) from posed metric depth images.

    ``extra_points`` / ``extra_normals``: oriented points of a room mesh.
    ``sparse_points``: accurate but sparse 3D points (the map's triangulated
    keypoints), used to correct the position of the walls.
    """
    opts = opts or PlanOptions()
    B = plan_basis(up)
    room = empty_room("too few points", up=B[2])
    if not views:
        room["reason"] = "no usable depth views"
        return room
    pts, nrm = cloud_from_views(views, opts)
    if extra_points is not None and len(extra_points):
        ep, en = voxel_average(np.asarray(extra_points, float), np.asarray(extra_normals, float), opts.voxel_m)
        pts, nrm = np.concatenate([pts, ep]), np.concatenate([nrm, en])
    if len(pts) < 500:
        return room
    q, qn = pts @ B.T, nrm @ B.T
    cams = np.array([B @ v.center for v in views])
    cam_lo, cam_hi = float(cams[:, 2].min()), float(cams[:, 2].max())

    # floor and ceiling
    # The floor lies well below the hand-held camera (a table top 0.7 m under it does not qualify)
    # and below its lowest position.
    floor_max = min(cam_lo - 0.15, float(np.median(cams[:, 2])) - opts.floor_min_below_camera_m)
    fl = _level(q[qn[:, 2] > opts.horizontal_cos, 2], -np.inf, floor_max, opts, "low")
    if fl is None:
        room["reason"] = "the floor was not found (it has to be visible in the recording)"
        return room
    floor = fl[0]
    ce = _level(q[qn[:, 2] < -opts.horizontal_cos, 2], max(cam_hi + 0.2, floor + 1.9), floor + 4.5, opts, "high")
    ceiling = ce[0] if ce else None
    top = ceiling if ceiling is not None else np.nan

    # walls
    wall_pts = (np.abs(qn[:, 2]) < opts.vertical_cos) & (q[:, 2] > floor + 0.25) & (q[:, 2] < (top if ceiling else floor + 2.6) - 0.05)
    n2 = qn[wall_pts, :2]
    n2 = n2 / np.linalg.norm(n2, axis=1, keepdims=True)
    seen_low: list[dict] = []
    walls = fit_walls(q[wall_pts], n2, floor, top, opts, seen_low)
    too_low: list[dict] = []  # one entry per surface: depth images that disagree show the same wall as several layers
    for c in sorted(seen_low, key=lambda c: -c["length_m"]):
        same = lambda o: o["_n"] @ c["_n"] > 0.9 and abs(o["_d"] - c["_d"]) < 0.6  # noqa: E731
        if not any(same(o) for o in too_low) and not any(w.n @ c["_n"] > 0.9 and abs(w.d - c["_d"]) < 0.6 for w in walls):
            too_low.append(c)
    walls = _drop_furniture(_drop_duplicates(drop_outside_walls(walls, views, B, opts), opts), opts)
    refined = refine_walls(walls, np.asarray(sparse_points, float) @ B.T, opts) if sparse_points is not None and len(sparse_points) else 0
    walls, corners = snap_walls(walls, opts)
    for k, w in enumerate(walls):
        w.id = f"w{k}"
        w.confidence = round(float(np.clip(0.3 + 0.7 * min(1.0, w.coverage / 0.4), 0, 1)), 3)

    # openings
    geo = []
    for wi, w in enumerate(walls):
        solid, through, nviews = wall_evidence(w, views, B, opts)
        for o in openings_from_geometry(w, solid, through, nviews, opts):
            geo.append(dict(o, wall=wi))
        seen = (solid + through) > 0
        if seen.any():
            w.coverage = round(float((solid > through)[seen].sum() / seen.size), 3)
    det = openings_from_detector(walls, views, B, opts)
    openings = merge_openings(geo, det, opts)

    # ---- JSON ---- #
    to_map = B.T
    up3 = B[2]
    centre = np.array([np.median(cams[:, 0]), np.median(cams[:, 1])])
    P3 = lambda a, b, h: to_map @ np.array([a, b, h])  # noqa: E731
    outline = floor_outline(walls, corners)
    conf_f = round(float(np.clip(fl[1] / 400.0, 0.2, 1.0)), 3)
    room.update(
        status="ok" if len(walls) >= 2 else "partial",
        reason=None if len(walls) >= 2 else "fewer than two walls were found" + (
            f": {len(too_low)} more wall-like {'surface was' if len(too_low) == 1 else 'surfaces were'} seen over less than "
            f"{opts.wall_min_height_m:.1f} m of height (the longest: {max(t['length_m'] for t in too_low):.1f} m long, "
            f"{max(too_low, key=lambda t: t['length_m'])['seen_height_m']:.1f} m of it seen) - scan again and tilt the phone up and down "
            "so that the walls are seen from the floor to the ceiling" if too_low else ""),
        floor={"level": round(floor, 4), "point": _v(P3(centre[0], centre[1], floor)), "normal": _v(up3),
               "outline": [_v(P3(p[0], p[1], floor)) for p in outline] if outline is not None else None, "confidence": conf_f},
        ceiling=None if ceiling is None else {"level": round(ceiling, 4), "point": _v(P3(centre[0], centre[1], ceiling)),
                                              "normal": _v(-up3), "confidence": round(float(np.clip(ce[1] / 400.0, 0.2, 1.0)), 3)},
        height=None if ceiling is None else round(ceiling - floor, 4),
    )
    for w in walls:
        room["walls"].append({"id": w.id, **_rect(w, w.u0, w.u1, w.h0, w.h1, B), "confidence": w.confidence, "coverage": w.coverage})
    for k, c in enumerate(corners):
        a, b = walls[c["walls"][0]], walls[c["walls"][1]]
        room["corners"].append({"id": f"c{k}", "walls": [a.id, b.id], "bottom": _v(P3(c["X"][0], c["X"][1], floor)),
                                "top": _v(P3(c["X"][0], c["X"][1], min(a.h1, b.h1))), "angle_deg": round(c["angle_deg"], 2),
                                "confidence": round(min(a.confidence, b.confidence), 3)})
    for k, o in enumerate(openings):
        w = walls[o["wall"]]
        rect = _rect(w, o["u0"], o["u1"], w.h0, w.h0 + o["top"], B)
        cb = to_map @ w.point((o["u0"] + o["u1"]) / 2, w.h0)
        right = to_map @ np.array([w.t[0], w.t[1], 0.0])
        room["openings"].append({
            "id": f"o{k}", "kind": "door", "wall_id": w.id, "state": o["state"], "center_bottom": _v(cb), **rect,
            "portal_pose": _pose(cb, right, up3, np.asarray(rect["normal"])), "height_measured": bool(o["top_known"]),
            "confidence": o["confidence"],
            "evidence": {"geometry": o["geometry"], "detector": o["detector"], "views": int(o["views"])},
        })
    if openings and openings[0]["confidence"] >= opts.auto_portal_min_confidence:
        room["best_opening_id"] = "o0"
    room["thresholds"] = {"auto_portal_min_confidence": opts.auto_portal_min_confidence}
    room["stats"] = {"views": len(views), "points": int(len(pts)), "walls_refined_with_map_points": int(refined),
                     "wall_candidates_seen_too_low": [{k: v for k, v in t.items() if not k.startswith("_")} for t in too_low], "options": {k: v for k, v in asdict(opts).items() if k != "seed"}}
    return room


# -------------------------------------------------------- frame conversion --- #
_POINT_KEYS = ("point", "center", "center_bottom", "bottom", "top")
_DIR_KEYS = ("normal",)
_LEN_KEYS = ("width", "height")


def transform_room(room: dict, sim: g.Sim3, frame: str = "arworld") -> dict:
    """The same plan in another frame (``X_new = sim.apply(X_map)``)."""
    R, s = sim.R, sim.scale

    def conv(obj):
        if isinstance(obj, list):
            return [conv(x) for x in obj]
        if not isinstance(obj, dict):
            return obj
        out = {}
        for k, v in obj.items():
            if v is None:
                out[k] = None
            elif k in _POINT_KEYS and isinstance(v, list):
                out[k] = _v(sim.apply(np.asarray(v, float)[None])[0])
            elif k in ("corners", "outline") and v and isinstance(v[0], list):
                out[k] = [_v(p) for p in sim.apply(np.asarray(v, float))]
            elif k in _DIR_KEYS:
                out[k] = _v(R @ np.asarray(v, float))
            elif k in _LEN_KEYS and isinstance(v, (int, float)) and not isinstance(v, bool):
                out[k] = round(float(v) * s, 4)
            elif k in ("pose", "portal_pose"):
                Rn = R @ g.quat_to_rotmat(v["quaternion_xyzw"])
                out[k] = {"position": _v(sim.apply(np.asarray(v["position"], float)[None])[0]),
                          "rotation_euler_deg": _v(g.rotmat_to_viro_euler(Rn)),
                          "quaternion_xyzw": [round(float(a), 6) for a in g.rotmat_to_quat(Rn)]}
            elif k == "stats":
                continue
            else:
                out[k] = conv(v)
        return out

    new = conv(room)
    new["frame"] = frame
    new["up"] = _v(R @ np.asarray(room["up"], float))
    up = np.asarray(new["up"])
    for key in ("floor", "ceiling"):
        if new.get(key):
            new[key]["level"] = round(float(np.asarray(new[key]["point"]) @ up), 4)
    return new


def opening_by_id(room: dict | None, opening_id: str | None) -> dict | None:
    if not room or not opening_id:
        return None
    return next((o for o in room.get("openings", []) if o["id"] == opening_id), None)
