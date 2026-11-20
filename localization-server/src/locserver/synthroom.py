"""A synthetic box room with a doorway, rendered to depth images.

Ground truth for the room-plan code (tests and ``scripts/demo_room_plan.py``):
the room is a set of rectangles, a tiny ray caster turns it into the depth
images a phone would have produced, and the known door position is returned
next to them. AR conventions: +Y up, metres.
"""

from __future__ import annotations

import numpy as np

from .roomplan import DepthView


def _rect(o, a, b):
    return (np.asarray(o, float), np.asarray(a, float), np.asarray(b, float))


def _wall_with_hole(o, a, b, hole):
    """Rectangle ``o + s*a + t*b`` minus the hole ``(s0, s1, t0, t1)`` (fractions of a and b)."""
    o, a, b = (np.asarray(x, float) for x in (o, a, b))
    if hole is None:
        return [_rect(o, a, b)]
    s0, s1, t0, t1 = hole
    out = [_rect(o, a * s0, b), _rect(o + a * s1, a * (1 - s1), b)]
    if t1 < 1:
        out.append(_rect(o + a * s0 + b * t1, a * (s1 - s0), b * (1 - t1)))
    if t0 > 0:
        out.append(_rect(o + a * s0, a * (s1 - s0), b * t0))
    return out


def make_room(lx=4.0, lz=3.2, height=2.6, floor_y=-1.3, door=(1.5, 2.4, 2.0), door_closed=False, window=False,
              cupboard=False, yaw_deg=0.0, offset=(0.0, 0.0, 0.0)) -> dict:
    """Interior ``x in [0, lx]``, ``z in [0, lz]``; the door ``(x0, x1, height)`` is in the wall ``z = 0``.

    Behind the door lies a corridor (its back wall is 2 m further). ``window``
    cuts a hole that does not reach the floor into the wall ``x = lx``;
    ``cupboard`` puts a tall box in front of the wall ``z = lz``. The whole
    scene is then rotated by ``yaw_deg`` about +Y and shifted by ``offset``.
    """
    y0, H = floor_y, height
    X, Y, Z = np.eye(3)
    rects = []
    big = 2.5
    rects.append(_rect([-big, y0, -big], X * (lx + 2 * big), Z * (lz + big)))  # floor (room + corridor)
    rects.append(_rect([-big, y0 + H, -big], X * (lx + 2 * big), Z * (lz + big)))  # ceiling
    dx0, dx1, dh = door
    rects += _wall_with_hole([0, y0, 0], X * lx, Y * H, (dx0 / lx, dx1 / lx, 0.0, dh / H))
    door_rect = _rect([dx0, y0, 0], X * (dx1 - dx0), Y * dh)
    if door_closed:
        rects.append(door_rect)
    rects.append(_rect([0, y0, lz], X * lx, Y * H))
    rects.append(_rect([0, y0, 0], Z * lz, Y * H))
    rects += _wall_with_hole([lx, y0, 0], Z * lz, Y * H, (0.3, 0.6, 0.9 / H, 2.0 / H) if window else None)
    rects.append(_rect([-big, y0, -2.0], X * (lx + 2 * big), Y * H))  # corridor back wall
    rects.append(_rect([-big, y0, -2.0], Z * 2.0, Y * H))  # corridor ends
    rects.append(_rect([lx + big, y0, -2.0], Z * 2.0, Y * H))
    if cupboard:
        cx0, cx1, cd, ch = 0.8, 2.0, 0.6, 2.0
        rects.append(_rect([cx0, y0, lz - cd], X * (cx1 - cx0), Y * ch))
        rects.append(_rect([cx0, y0, lz - cd], Z * cd, Y * ch))
        rects.append(_rect([cx1, y0, lz - cd], Z * cd, Y * ch))
        rects.append(_rect([cx0, y0 + ch, lz - cd], X * (cx1 - cx0), Z * cd))
    a = np.radians(yaw_deg)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    t = np.asarray(offset, float)
    tr = lambda p: R @ np.asarray(p, float) + t  # noqa: E731
    rects = [(tr(o), R @ a_, R @ b_) for o, a_, b_ in rects]
    o, a_, b_ = door_rect
    door_corners = np.array([tr(o), tr(o + a_), tr(o + a_ + b_), tr(o + b_)])
    return {
        "rects": rects,
        "R": R, "t": t, "size": (lx, lz, height), "floor_y": floor_y + t[1],
        "door": {"center_bottom": tr([(dx0 + dx1) / 2, y0, 0]), "width": dx1 - dx0, "height": dh, "normal": R @ Z,
                 "corners": door_corners},
        "corners": np.array([tr(p) for p in ([0, y0, 0], [lx, y0, 0], [lx, y0, lz], [0, y0, lz])]),
        "to_world": tr,
    }


def render_depth(rects, T_map_from_cvcam, fx, fy, cx, cy, w, h) -> np.ndarray:
    """z-depth image of the rectangles (nan where a ray hits nothing)."""
    ys, xs = np.mgrid[0:h, 0:w]
    d = np.stack([(xs + 0.5 - cx) / fx, (ys + 0.5 - cy) / fy, np.ones((h, w))], -1).reshape(-1, 3)
    D = d @ T_map_from_cvcam[:3, :3].T
    c = T_map_from_cvcam[:3, 3]
    best = np.full(len(D), np.inf)
    for o, a, b in rects:
        n = np.cross(a, b)
        den = D @ n
        with np.errstate(divide="ignore", invalid="ignore"):
            t = ((o - c) @ n) / den
        Xh = c + t[:, None] * D - o
        s, u = Xh @ a / (a @ a), Xh @ b / (b @ b)
        ok = (np.abs(den) > 1e-9) & (t > 1e-3) & (s >= 0) & (s <= 1) & (u >= 0) & (u <= 1)
        best = np.where(ok & (t < best), t, best)
    best[~np.isfinite(best)] = np.nan
    return best.reshape(h, w).astype(np.float32)  # t is along d with d_z = 1, i.e. already z


def camera_pose(position, yaw_deg: float, pitch_deg: float = 0.0) -> np.ndarray:
    """``T_map_from_cvcam`` of a camera looking along yaw (0 = -Z, positive = to the left), pitched up by ``pitch_deg``."""
    a, p = np.radians(yaw_deg), np.radians(pitch_deg)
    f = np.array([-np.sin(a) * np.cos(p), np.sin(p), -np.cos(a) * np.cos(p)])
    right = np.cross(f, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(f, right)
    T = np.eye(4)
    T[:3, :3] = np.stack([right, down, f], 1)
    T[:3, 3] = position
    return T


def project_box(view: DepthView, corners: np.ndarray):
    """Normalised image box of 3D ``corners`` or None if they are not all in front of the camera / mostly outside."""
    T = np.linalg.inv(view.T_map_from_cvcam)
    Xc = corners @ T[:3, :3].T + T[:3, 3]
    if (Xc[:, 2] < 0.3).any():
        return None
    h, w = view.depth.shape
    x = (Xc[:, 0] / Xc[:, 2] * view.fx + view.cx) / w
    y = (Xc[:, 1] / Xc[:, 2] * view.fy + view.cy) / h
    x0, x1, y0, y1 = np.clip([x.min(), x.max(), y.min(), y.max()], 0, 1)
    full = (x.max() - x.min()) * (y.max() - y.min())
    if full <= 0 or (x1 - x0) * (y1 - y0) < 0.6 * full:
        return None
    return float(x0), float(y0), float(x1), float(y1)


def make_views(room: dict, width=160, height=120, hfov_deg=75.0, eye_height=1.45, noise=0.0, door_boxes=False,
               box_score=0.6, seed=0) -> list[DepthView]:
    """Depth images from a slow turn at three places in the room."""
    rng = np.random.default_rng(seed)
    lx, lz, _ = room["size"]
    fx = width / 2 / np.tan(np.radians(hfov_deg) / 2)
    views = []
    for px, pz in ((0.5 * lx, 0.55 * lz), (0.3 * lx, 0.7 * lz), (0.72 * lx, 0.4 * lz)):
        for yaw in range(0, 360, 30):
            for pitch in (-28.0, 8.0):
                T_local = camera_pose([px, room["floor_y"] - room["t"][1] + eye_height, pz], yaw, pitch)
                T = np.eye(4)
                T[:3, :3] = room["R"] @ T_local[:3, :3]
                T[:3, 3] = room["to_world"](T_local[:3, 3])
                depth = render_depth(room["rects"], T, fx, fx, width / 2, height / 2, width, height)
                if noise:
                    depth = depth * (1 + noise * rng.standard_normal(depth.shape)).astype(np.float32)
                v = DepthView(T, fx, fx, width / 2, height / 2, depth, name=f"{px:.1f}_{pz:.1f}_{yaw}_{pitch:.0f}")
                if door_boxes:
                    b = project_box(v, room["door"]["corners"])
                    if b:
                        v.boxes.append((*b, box_score))
                views.append(v)
    return views
