"""Pose and coordinate-frame maths. Pure numpy, no model or COLMAP imports.

Naming rule used everywhere in this project
-------------------------------------------
``T_a_from_b`` is a 4x4 matrix that maps homogeneous column vectors expressed in
frame ``b`` to frame ``a``:  ``X_a = T_a_from_b @ X_b``.  Its translation column is
therefore the origin of ``b`` expressed in ``a``; its rotation columns are the axes
of ``b`` expressed in ``a``.  Matrices are serialised row-major as nested lists.

Frames
------
map       the SfM map (COLMAP "world"). Right-handed, arbitrary orientation.
          Units are metres only if the map is metric, otherwise "map units".
cvcam     camera in the COLMAP/OpenCV convention: x right, y down, z forward.
arcam     camera in the ViroReact/ARCore/OpenGL convention: x right, y up,
          the camera looks along -z.
arworld   the AR session world of the phone: right-handed, y up (gravity),
          metres, origin where tracking started.
anchor    a named rigid frame fixed in the map (e.g. the portal). Its local axes
          follow the ViroReact object convention (x right, y up, +z out of the
          front face towards the viewer).

Quaternions are ``[x, y, z, w]`` (Hamilton, unit), the order used by ViroReact,
three.js and pycolmap. JSON keys that carry one are always named ``*_xyzw``.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Iterable, Sequence

import numpy as np

# cvcam <-> arcam: flip y and z. The matrix is its own inverse.
CV_FROM_GL = np.diag([1.0, -1.0, -1.0])
GL_FROM_CV = CV_FROM_GL


# --------------------------------------------------------------------------- #
# basic rotations
# --------------------------------------------------------------------------- #
def rot_x(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=float)


def rot_y(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=float)


def rot_z(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=float)


def is_rotation(R: np.ndarray, tol: float = 1e-6) -> bool:
    R = np.asarray(R, dtype=float)
    return (
        R.shape == (3, 3)
        and np.allclose(R @ R.T, np.eye(3), atol=tol)
        and abs(np.linalg.det(R) - 1.0) < tol
    )


def project_to_rotation(M: np.ndarray) -> np.ndarray:
    """Closest rotation matrix (Frobenius norm) to an arbitrary 3x3 matrix."""
    U, _, Vt = np.linalg.svd(np.asarray(M, dtype=float))
    D = np.diag([1.0, 1.0, np.sign(np.linalg.det(U @ Vt)) or 1.0])
    return U @ D @ Vt


def rotation_angle_deg(Ra: np.ndarray, Rb: np.ndarray | None = None) -> float:
    """Angle of the relative rotation between two rotation matrices, in degrees."""
    R = Ra if Rb is None else Ra.T @ Rb
    c = (np.trace(R) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def mean_rotation(Rs: Sequence[np.ndarray], weights: Sequence[float] | None = None) -> np.ndarray:
    """Chordal L2 mean of rotations (projection of the weighted sum onto SO(3))."""
    Rs = np.asarray(Rs, dtype=float)
    w = np.ones(len(Rs)) if weights is None else np.asarray(weights, dtype=float)
    return project_to_rotation(np.einsum("i,ijk->jk", w, Rs))


# --------------------------------------------------------------------------- #
# quaternions [x, y, z, w]
# --------------------------------------------------------------------------- #
def quat_to_rotmat(q_xyzw: Iterable[float]) -> np.ndarray:
    x, y, z, w = np.asarray(list(q_xyzw), dtype=float)
    n = np.sqrt(x * x + y * y + z * z + w * w)
    if n < 1e-12:
        raise ValueError("zero-norm quaternion")
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def rotmat_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> unit quaternion [x, y, z, w] with w >= 0."""
    R = np.asarray(R, dtype=float)
    tr = np.trace(R)
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        q = [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, 0.25 * s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q = [0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s, (R[2, 1] - R[1, 2]) / s]
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q = [(R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s, (R[0, 2] - R[2, 0]) / s]
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q = [(R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s, (R[1, 0] - R[0, 1]) / s]
    q = np.asarray(q, dtype=float)
    q /= np.linalg.norm(q)
    return -q if q[3] < 0 else q


# --------------------------------------------------------------------------- #
# rigid transforms
# --------------------------------------------------------------------------- #
def make_T(R: np.ndarray, t: Iterable[float]) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = np.asarray(R, dtype=float)
    T[:3, 3] = np.asarray(list(t), dtype=float)
    return T


def invert_T(T: np.ndarray) -> np.ndarray:
    """Inverse of a rigid 4x4 transform."""
    R, t = T[:3, :3], T[:3, 3]
    return make_T(R.T, -R.T @ t)


def pose_error(T_est: np.ndarray, T_ref: np.ndarray) -> tuple[float, float]:
    """(position distance, rotation angle in degrees) between two rigid poses."""
    dt = float(np.linalg.norm(T_est[:3, 3] - T_ref[:3, 3]))
    return dt, rotation_angle_deg(T_est[:3, :3], T_ref[:3, :3])


# --------------------------------------------------------------------------- #
# ViroReact conventions
# --------------------------------------------------------------------------- #
# ViroReact `rotation={[x, y, z]}` is in degrees and is applied as
#     R = Rz(z) @ Ry(y) @ Rx(x)
# i.e. rotate about the fixed X axis first, then fixed Y, then fixed Z
# (VROQuaternion::VROQuaternion(x, y, z) in virocore; see README "Conventions").
def viro_euler_to_rotmat(euler_deg: Iterable[float]) -> np.ndarray:
    x, y, z = np.radians(np.asarray(list(euler_deg), dtype=float))
    return rot_z(z) @ rot_y(y) @ rot_x(x)


def rotmat_to_viro_euler(R: np.ndarray) -> np.ndarray:
    """Inverse of :func:`viro_euler_to_rotmat`. Returns degrees, y in [-90, 90]."""
    R = np.asarray(R, dtype=float)
    sy = -R[2, 0]
    if abs(sy) < 1.0 - 1e-9:
        y = np.arcsin(sy)
        x = np.arctan2(R[2, 1], R[2, 2])
        z = np.arctan2(R[1, 0], R[0, 0])
    else:  # gimbal lock: only x -/+ z is defined, put everything into x
        y = np.copysign(np.pi / 2, sy)
        x = np.arctan2(-R[1, 2], R[1, 1])
        z = 0.0
    return np.degrees(np.array([x, y, z]))


def rotmat_from_forward_up(forward: Iterable[float], up: Iterable[float]) -> np.ndarray:
    """Rotation of a GL-style frame from its `forward` (-z) and `up` (+y) vectors."""
    f = np.asarray(list(forward), dtype=float)
    u = np.asarray(list(up), dtype=float)
    if np.linalg.norm(f) < 1e-9 or np.linalg.norm(u) < 1e-9:
        raise ValueError("forward/up must be non-zero")
    z = -f / np.linalg.norm(f)
    y = u - (u @ z) * z
    if np.linalg.norm(y) < 1e-6:
        raise ValueError("forward and up are parallel")
    y /= np.linalg.norm(y)
    x = np.cross(y, z)
    return np.stack([x, y, z], axis=1)


def viro_camera_pose(
    position: Iterable[float],
    rotation_euler_deg: Iterable[float] | None = None,
    forward: Iterable[float] | None = None,
    up: Iterable[float] | None = None,
    quaternion_xyzw: Iterable[float] | None = None,
) -> np.ndarray:
    """``T_arworld_from_arcam`` from what ViroReact's camera callbacks report.

    Orientation precedence: quaternion, then forward+up (unambiguous), then Euler.
    """
    if quaternion_xyzw is not None:
        R = quat_to_rotmat(quaternion_xyzw)
    elif forward is not None and up is not None:
        R = rotmat_from_forward_up(forward, up)
    elif rotation_euler_deg is not None:
        R = viro_euler_to_rotmat(rotation_euler_deg)
    else:
        raise ValueError("camera orientation missing: give forward+up, Euler or quaternion")
    return make_T(R, position)


# --------------------------------------------------------------------------- #
# similarity transforms
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Sim3:
    """``X_dst = scale * R @ X_src + t``."""

    scale: float
    R: np.ndarray
    t: np.ndarray

    @staticmethod
    def identity() -> "Sim3":
        return Sim3(1.0, np.eye(3), np.zeros(3))

    def apply(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, dtype=float)
        return self.scale * pts @ self.R.T + self.t

    def matrix(self) -> np.ndarray:
        M = np.eye(4)
        M[:3, :3] = self.scale * self.R
        M[:3, 3] = self.t
        return M

    def inverse(self) -> "Sim3":
        Rinv = self.R.T
        return Sim3(1.0 / self.scale, Rinv, -(Rinv @ self.t) / self.scale)

    def transform_pose(self, T_src_from_frame: np.ndarray) -> np.ndarray:
        """Rigid pose of a frame known in ``src``, expressed in ``dst`` (no scale in R)."""
        return make_T(self.R @ T_src_from_frame[:3, :3], self.apply(T_src_from_frame[:3, 3]))


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool = True) -> Sim3:
    """Least-squares similarity ``dst ~ s R src + t`` (Umeyama 1991)."""
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    if src.shape != dst.shape or src.ndim != 2 or src.shape[1] != 3 or len(src) < 3:
        raise ValueError("umeyama needs two (N>=3, 3) arrays")
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1.0
    R = U @ D @ Vt
    var_s = (xs**2).sum() / len(src)
    if var_s < 1e-18:
        raise ValueError("degenerate source points")
    s = float(np.trace(np.diag(S) @ D) / var_s) if with_scale else 1.0
    return Sim3(s, R, mu_d - s * R @ mu_s)


def umeyama_ransac(
    src: np.ndarray,
    dst: np.ndarray,
    threshold: float,
    iterations: int = 500,
    with_scale: bool = True,
    seed: int = 0,
) -> tuple[Sim3, np.ndarray]:
    """Umeyama inside RANSAC (3-point minimal sets). ``threshold`` is in dst units."""
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    n = len(src)
    if n < 3:
        raise ValueError("need at least 3 correspondences")
    rng = np.random.default_rng(seed)
    best_inl = np.zeros(n, dtype=bool)
    best_err = np.inf
    for _ in range(iterations):
        idx = rng.choice(n, 3, replace=False)
        try:
            model = umeyama(src[idx], dst[idx], with_scale)
        except (ValueError, np.linalg.LinAlgError):
            continue
        if not np.isfinite(model.scale) or model.scale <= 0:
            continue
        err = np.linalg.norm(model.apply(src) - dst, axis=1)
        inl = err < threshold
        score = (inl.sum(), -err[inl].sum() if inl.any() else -np.inf)
        if score > (best_inl.sum(), -best_err):
            best_inl, best_err = inl, err[inl].sum()
    if best_inl.sum() < 3:
        raise ValueError("umeyama_ransac found no consensus")
    for _ in range(3):  # local optimisation
        model = umeyama(src[best_inl], dst[best_inl], with_scale)
        inl = np.linalg.norm(model.apply(src) - dst, axis=1) < threshold
        if inl.sum() < 3 or (inl == best_inl).all():
            break
        best_inl = inl
    return umeyama(src[best_inl], dst[best_inl], with_scale), best_inl


# --------------------------------------------------------------------------- #
# map <-> AR session alignment
# --------------------------------------------------------------------------- #
def alignment_from_observation(
    T_cvcam_from_map: np.ndarray, T_arworld_from_arcam: np.ndarray, scale: float = 1.0
) -> Sim3:
    """``arworld <- map`` similarity from one localised frame with a known AR pose.

    ``T_cvcam_from_map`` is the COLMAP pose (translation in map units), ``scale`` is
    metres per map unit (1.0 for a metric map). Derivation:

        X_cvcam[m]  = scale * (R_c X_map + t_c)
        X_arworld   = R_a @ GL_FROM_CV @ X_cvcam[m] + p_a
    """
    R_c, t_c = T_cvcam_from_map[:3, :3], T_cvcam_from_map[:3, 3]
    R_a, p_a = T_arworld_from_arcam[:3, :3], T_arworld_from_arcam[:3, 3]
    R = R_a @ GL_FROM_CV @ R_c
    return Sim3(float(scale), R, scale * (R_a @ GL_FROM_CV @ t_c) + p_a)


@dataclass
class AlignmentResult:
    sim3: Sim3
    inliers: np.ndarray  # bool mask over the observations
    position_rms_m: float  # residual of camera centres, inliers only
    rotation_max_deg: float  # max deviation of per-frame rotations from the model
    baseline_m: float  # largest distance between inlier camera centres (AR)
    scale_rel_std: float | None  # rough 1-sigma relative scale uncertainty
    scale_source: str  # "fixed" | "estimated" | "unknown"


def align_observations(
    T_cvcam_from_map: Sequence[np.ndarray],
    T_arworld_from_arcam: Sequence[np.ndarray],
    fixed_scale: float | None = None,
    pos_threshold_m: float = 0.10,
    rot_threshold_deg: float = 5.0,
    min_baseline_m: float = 0.15,
    pos_noise_floor_m: float = 0.02,
    weights: Sequence[float] | None = None,
) -> AlignmentResult:
    """Robust ``arworld <- map`` similarity from N (localised frame, AR pose) pairs.

    Why not plain Umeyama on camera centres: a user typically walks more or less
    straight, and a rotation recovered from collinear points is undefined about
    the walking direction. Each single observation, however, already carries an
    accurate rotation. So the model is estimated as

        R  = chordal mean of the per-observation rotations  R_a,i GL_FROM_CV R_c,i
        s  = least squares on the camera centres given R  (or ``fixed_scale``)
        t  = centroid_ar - s R centroid_map

    with outlier rejection by exhaustive RANSAC over minimal sets (pairs when the
    scale is free, single observations when it is fixed). An observation is an
    inlier if its camera centre is within ``pos_threshold_m`` of the model and its
    rotation within ``rot_threshold_deg``.

    With one observation and no ``fixed_scale`` the scale cannot be known: the
    result then has ``scale_source == "unknown"`` and scale 1.0 (rotation is valid,
    positions are not).
    """
    n = len(T_cvcam_from_map)
    if n == 0 or n != len(T_arworld_from_arcam):
        raise ValueError("need N >= 1 matching observation pairs")
    w = np.ones(n) if weights is None else np.asarray(weights, dtype=float)
    Tc = [np.asarray(T, dtype=float) for T in T_cvcam_from_map]
    Ta = [np.asarray(T, dtype=float) for T in T_arworld_from_arcam]
    c_map = np.array([-(T[:3, :3].T @ T[:3, 3]) for T in Tc])  # camera centres, map
    c_ar = np.array([T[:3, 3] for T in Ta])  # camera centres, AR world
    R_obs = np.array([Ta[i][:3, :3] @ GL_FROM_CV @ Tc[i][:3, :3] for i in range(n)])

    def fit(idx: np.ndarray) -> Sim3 | None:
        R = mean_rotation(R_obs[idx], w[idx])
        mu_m = np.average(c_map[idx], axis=0, weights=w[idx])
        mu_a = np.average(c_ar[idx], axis=0, weights=w[idx])
        if fixed_scale is not None:
            s = float(fixed_scale)
        else:
            xm = (c_map[idx] - mu_m) @ R.T
            xa = c_ar[idx] - mu_a
            den = float((w[idx, None] * xm * xm).sum())
            if den < 1e-18:
                return None
            s = float((w[idx, None] * xm * xa).sum() / den)
            if not np.isfinite(s) or s <= 0:
                return None
        return Sim3(s, R, mu_a - s * R @ mu_m)

    def residuals(m: Sim3) -> tuple[np.ndarray, np.ndarray]:
        e_pos = np.linalg.norm(m.apply(c_map) - c_ar, axis=1)
        e_rot = np.array([rotation_angle_deg(m.R, R_obs[i]) for i in range(n)])
        return e_pos, e_rot

    if fixed_scale is None and n == 1:
        sim = alignment_from_observation(Tc[0], Ta[0], 1.0)
        return AlignmentResult(sim, np.array([True]), 0.0, 0.0, 0.0, None, "unknown")

    if fixed_scale is not None:
        samples = [np.array([i]) for i in range(n)]
    else:
        samples = [
            np.array(p)
            for p in combinations(range(n), 2)
            if np.linalg.norm(c_ar[p[0]] - c_ar[p[1]]) >= min_baseline_m
        ]
        if not samples:  # the phone did not move enough to observe the scale
            R = mean_rotation(R_obs, w)
            best = int(np.argmin([rotation_angle_deg(R, Ro) for Ro in R_obs]))
            sim = alignment_from_observation(Tc[best], Ta[best], 1.0)
            inl = np.array([rotation_angle_deg(sim.R, Ro) < rot_threshold_deg for Ro in R_obs])
            return AlignmentResult(sim, inl, 0.0, 0.0, 0.0, None, "unknown")

    best_model, best_inl, best_key = None, None, (-1, -np.inf)
    for idx in samples:
        m = fit(idx)
        if m is None:
            continue
        e_pos, e_rot = residuals(m)
        inl = (e_pos < pos_threshold_m) & (e_rot < rot_threshold_deg)
        key = (int(inl.sum()), -float(e_pos[inl].sum()) if inl.any() else -np.inf)
        if key > best_key:
            best_model, best_inl, best_key = m, inl, key
    if best_model is None or best_inl is None or best_inl.sum() < len(samples[0]):
        raise ValueError("no consistent alignment between the observations")

    for _ in range(3):  # refit on the consensus set
        m = fit(np.flatnonzero(best_inl))
        if m is None:
            break
        e_pos, e_rot = residuals(m)
        inl = (e_pos < pos_threshold_m) & (e_rot < rot_threshold_deg)
        if inl.sum() < best_inl.sum():
            break
        best_model, changed = m, not (inl == best_inl).all()
        best_inl = inl
        if not changed:
            break

    e_pos, e_rot = residuals(best_model)
    ca = c_ar[best_inl]
    baseline = float(max((np.linalg.norm(a - b) for a, b in combinations(ca, 2)), default=0.0))
    rms = float(np.sqrt(np.mean(e_pos[best_inl] ** 2)))
    if fixed_scale is None:
        spread = float(np.sqrt(((ca - ca.mean(0)) ** 2).sum()))
        rel_std = max(rms, pos_noise_floor_m) / spread if spread > 1e-9 else None
        source = "estimated"
    else:
        rel_std, source = None, "fixed"
    return AlignmentResult(
        best_model, best_inl, rms, float(e_rot[best_inl].max()), baseline, rel_std, source
    )
