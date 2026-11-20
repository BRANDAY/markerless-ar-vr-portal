import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from locserver import geometry as g


def random_rotation(rng) -> np.ndarray:
    return Rotation.random(random_state=rng.integers(1 << 31)).as_matrix()


def random_pose(rng, spread=2.0) -> np.ndarray:
    return g.make_T(random_rotation(rng), rng.uniform(-spread, spread, 3))


# ----------------------------------------------------------------- basics --- #
def test_quaternion_roundtrip_and_scipy_agreement():
    rng = np.random.default_rng(1)
    for _ in range(200):
        R = random_rotation(rng)
        q = g.rotmat_to_quat(R)
        assert q[3] >= 0 and np.isclose(np.linalg.norm(q), 1.0)
        assert np.allclose(g.quat_to_rotmat(q), R, atol=1e-9)
        # scipy also uses [x, y, z, w]
        assert np.allclose(Rotation.from_quat(q).as_matrix(), R, atol=1e-9)


def test_quaternion_near_180_degrees():
    for axis in np.eye(3):
        R = Rotation.from_rotvec(np.pi * axis).as_matrix()
        assert np.allclose(g.quat_to_rotmat(g.rotmat_to_quat(R)), R, atol=1e-9)


def test_invert_T():
    rng = np.random.default_rng(2)
    T = random_pose(rng)
    assert np.allclose(g.invert_T(T) @ T, np.eye(4), atol=1e-12)


def test_project_to_rotation_and_mean():
    rng = np.random.default_rng(3)
    R = random_rotation(rng)
    noisy = [R @ Rotation.from_rotvec(rng.normal(0, 0.02, 3)).as_matrix() for _ in range(50)]
    Rm = g.mean_rotation(noisy)
    assert g.is_rotation(Rm)
    assert g.rotation_angle_deg(R, Rm) < 0.5


# ------------------------------------------------------- Viro conventions --- #
def test_viro_euler_is_rz_ry_rx():
    e = [20.0, -35.0, 50.0]
    R = g.viro_euler_to_rotmat(e)
    # extrinsic x, then y, then z  ==  scipy lowercase "xyz"
    assert np.allclose(R, Rotation.from_euler("xyz", e, degrees=True).as_matrix(), atol=1e-12)
    assert np.allclose(R, g.rot_z(np.radians(50)) @ g.rot_y(np.radians(-35)) @ g.rot_x(np.radians(20)))


def test_viro_euler_roundtrip():
    rng = np.random.default_rng(4)
    for _ in range(300):
        R = random_rotation(rng)
        e = g.rotmat_to_viro_euler(R)
        assert -90.0 <= e[1] <= 90.0
        assert np.allclose(g.viro_euler_to_rotmat(e), R, atol=1e-8)


@pytest.mark.parametrize("y", [90.0, -90.0])
def test_viro_euler_gimbal_lock(y):
    R = g.viro_euler_to_rotmat([33.0, y, -71.0])
    e = g.rotmat_to_viro_euler(R)
    assert np.allclose(g.viro_euler_to_rotmat(e), R, atol=1e-7)


def test_viro_single_axis_examples():
    # yaw 90 deg about +Y turns the default view direction -Z into -X
    R = g.viro_euler_to_rotmat([0, 90, 0])
    assert np.allclose(R @ [0, 0, -1], [-1, 0, 0], atol=1e-12)
    # pitch +90 about +X makes the camera look straight up (+Y)
    R = g.viro_euler_to_rotmat([90, 0, 0])
    assert np.allclose(R @ [0, 0, -1], [0, 1, 0], atol=1e-12)


def test_forward_up_matches_euler():
    rng = np.random.default_rng(5)
    for _ in range(100):
        e = rng.uniform([-180, -89, -180], [180, 89, 180])
        R = g.viro_euler_to_rotmat(e)
        forward, up = R @ [0, 0, -1], R @ [0, 1, 0]
        assert np.allclose(g.rotmat_from_forward_up(forward, up), R, atol=1e-9)
        T1 = g.viro_camera_pose([1, 2, 3], rotation_euler_deg=e)
        T2 = g.viro_camera_pose([1, 2, 3], forward=forward * 3.0, up=up * 0.5)
        T3 = g.viro_camera_pose([1, 2, 3], quaternion_xyzw=g.rotmat_to_quat(R))
        assert np.allclose(T1, T2, atol=1e-9) and np.allclose(T1, T3, atol=1e-9)


def test_forward_up_degenerate():
    with pytest.raises(ValueError):
        g.rotmat_from_forward_up([0, 0, -1], [0, 0, 2])
    with pytest.raises(ValueError):
        g.viro_camera_pose([0, 0, 0])


def test_cv_gl_camera_axes():
    # a point 2 m in front of the camera, 1 m to the right, 0.5 m above the axis
    p_cv = np.array([1.0, -0.5, 2.0])  # y down, z forward
    p_gl = g.GL_FROM_CV @ p_cv
    assert np.allclose(p_gl, [1.0, 0.5, -2.0])  # y up, looking along -z
    assert np.allclose(g.CV_FROM_GL @ p_gl, p_cv)


# ------------------------------------------------------------------ Sim3 --- #
def test_sim3_inverse_matrix_and_pose():
    rng = np.random.default_rng(6)
    S = g.Sim3(2.5, random_rotation(rng), rng.normal(size=3))
    pts = rng.normal(size=(20, 3))
    assert np.allclose(S.inverse().apply(S.apply(pts)), pts, atol=1e-10)
    hom = np.c_[pts, np.ones(20)]
    assert np.allclose((S.matrix() @ hom.T).T[:, :3], S.apply(pts), atol=1e-12)
    T = random_pose(rng)
    Tp = S.transform_pose(T)
    assert g.is_rotation(Tp[:3, :3])
    assert np.allclose(Tp[:3, 3], S.apply(T[:3, 3]))
    assert np.allclose(S.inverse().transform_pose(Tp), T, atol=1e-10)


def test_umeyama_exact_and_ransac():
    rng = np.random.default_rng(7)
    S = g.Sim3(0.37, random_rotation(rng), rng.normal(size=3))
    src = rng.normal(size=(40, 3))
    dst = S.apply(src)
    est = g.umeyama(src, dst)
    assert np.isclose(est.scale, S.scale) and np.allclose(est.R, S.R) and np.allclose(est.t, S.t)

    dst_bad = dst.copy()
    dst_bad[:10] += rng.normal(0, 3.0, size=(10, 3))  # 25 % gross outliers
    est, inl = g.umeyama_ransac(src, dst_bad, threshold=0.01)
    assert inl[10:].all() and not inl[:10].any()
    assert np.isclose(est.scale, S.scale, rtol=1e-9)


def test_umeyama_rejects_reflection():
    rng = np.random.default_rng(8)
    src = rng.normal(size=(30, 3))
    dst = src * [1, 1, -1]  # mirrored: best *rotation* must still have det +1
    assert g.is_rotation(g.umeyama(src, dst).R)


# ----------------------------------------------- map <-> AR-world alignment --- #
def synthetic_session(rng, n, map_scale, noise_pos=0.0, noise_rot_deg=0.0, collinear=False):
    """Ground-truth similarity arworld<-map plus n consistent observations."""
    S = g.Sim3(map_scale, random_rotation(rng), rng.uniform(-3, 3, 3))  # arworld <- map
    Tc, Ta = [], []
    for i in range(n):
        R_a = random_rotation(rng)  # arcam axes in arworld
        if collinear:
            p_a = np.array([0.2, 1.4, -0.5]) + i * 0.4 * np.array([0.6, 0.0, -0.8])
        else:
            p_a = rng.uniform(-1.5, 1.5, 3)
        Ta.append(g.make_T(R_a, p_a))
        # exact COLMAP pose of the same camera in the map:
        #   R = R_a GL_FROM_CV R_c   ->   R_c = CV_FROM_GL R_a^T R
        R_c = g.CV_FROM_GL @ R_a.T @ S.R
        c_map = S.inverse().apply(p_a)
        if noise_rot_deg:
            R_c = Rotation.from_rotvec(np.radians(rng.normal(0, noise_rot_deg, 3))).as_matrix() @ R_c
        if noise_pos:
            c_map = c_map + rng.normal(0, noise_pos, 3) / map_scale
        Tc.append(g.make_T(R_c, -R_c @ c_map))
    return S, Tc, Ta


def test_single_observation_metric_map_is_exact():
    rng = np.random.default_rng(10)
    S, Tc, Ta = synthetic_session(rng, 1, map_scale=1.0)
    est = g.alignment_from_observation(Tc[0], Ta[0], 1.0)
    assert np.allclose(est.R, S.R, atol=1e-10) and np.allclose(est.t, S.t, atol=1e-10)


def test_single_observation_known_scale():
    rng = np.random.default_rng(11)
    S, Tc, Ta = synthetic_session(rng, 1, map_scale=0.21)
    est = g.alignment_from_observation(Tc[0], Ta[0], 0.21)
    pts = rng.normal(size=(10, 3))
    assert np.allclose(est.apply(pts), S.apply(pts), atol=1e-9)


def test_single_observation_unknown_scale_is_flagged():
    rng = np.random.default_rng(12)
    S, Tc, Ta = synthetic_session(rng, 1, map_scale=0.21)
    res = g.align_observations(Tc, Ta)
    assert res.scale_source == "unknown"
    assert g.rotation_angle_deg(res.sim3.R, S.R) < 1e-6  # rotation is still right


def test_multi_observation_recovers_scale_exactly():
    rng = np.random.default_rng(13)
    S, Tc, Ta = synthetic_session(rng, 6, map_scale=3.3)
    res = g.align_observations(Tc, Ta)
    assert res.scale_source == "estimated" and res.inliers.all()
    assert np.isclose(res.sim3.scale, 3.3, rtol=1e-9)
    assert np.allclose(res.sim3.R, S.R, atol=1e-9) and np.allclose(res.sim3.t, S.t, atol=1e-8)


def test_multi_observation_collinear_walk():
    # walking in a straight line: Umeyama on centres alone would be degenerate
    rng = np.random.default_rng(14)
    S, Tc, Ta = synthetic_session(rng, 5, map_scale=0.5, collinear=True)
    res = g.align_observations(Tc, Ta)
    assert np.isclose(res.sim3.scale, 0.5, rtol=1e-9)
    assert g.rotation_angle_deg(res.sim3.R, S.R) < 1e-6
    assert np.allclose(res.sim3.t, S.t, atol=1e-8)


def test_multi_observation_with_noise_and_outliers():
    rng = np.random.default_rng(15)
    S, Tc, Ta = synthetic_session(rng, 12, map_scale=1.7, noise_pos=0.01, noise_rot_deg=0.3)
    # three wrong localisations (e.g. a repeated structure matched elsewhere)
    for i in (2, 5, 9):
        Tc[i] = random_pose(rng, spread=3.0)
    res = g.align_observations(Tc, Ta)
    assert not res.inliers[[2, 5, 9]].any() and res.inliers.sum() == 9
    assert abs(res.sim3.scale / 1.7 - 1) < 0.02
    assert g.rotation_angle_deg(res.sim3.R, S.R) < 0.5
    # a portal 2 m from the map origin lands within a few centimetres
    anchor = np.array([[1.0, 0.5, -0.8]]) / 1.7 * 2.0
    assert np.linalg.norm(res.sim3.apply(anchor) - S.apply(anchor)) < 0.05
    assert res.position_rms_m < 0.05 and res.scale_rel_std is not None


def test_fixed_scale_rejects_outlier_with_two_observations_majority():
    rng = np.random.default_rng(16)
    S, Tc, Ta = synthetic_session(rng, 4, map_scale=1.0)
    Tc[1] = random_pose(rng)
    res = g.align_observations(Tc, Ta, fixed_scale=1.0)
    assert list(res.inliers) == [True, False, True, True]
    assert res.scale_source == "fixed" and np.allclose(res.sim3.t, S.t, atol=1e-8)


def test_no_baseline_means_unknown_scale():
    rng = np.random.default_rng(17)
    S, Tc, Ta = synthetic_session(rng, 3, map_scale=2.0)
    # the phone only rotates in place
    for i in range(3):
        c_map = S.inverse().apply(np.array([0.3, 1.2, 0.1]))
        Ta[i][:3, 3] = [0.3, 1.2, 0.1]
        Tc[i][:3, 3] = -Tc[i][:3, :3] @ c_map
    res = g.align_observations(Tc, Ta)
    assert res.scale_source == "unknown"


def test_anchor_roundtrip_through_ar_world():
    """Author an anchor in one AR session, restore it in another one."""
    rng = np.random.default_rng(18)
    T_map_from_anchor = random_pose(rng)
    S1 = g.Sim3(0.8, random_rotation(rng), rng.normal(size=3))  # session 1: arworld <- map
    S2 = g.Sim3(0.8, random_rotation(rng), rng.normal(size=3))  # session 2
    T_ar1_from_anchor = S1.transform_pose(T_map_from_anchor)
    # authoring: the app reports the doorway pose in AR world 1 -> store in the map
    stored = S1.inverse().transform_pose(T_ar1_from_anchor)
    assert np.allclose(stored, T_map_from_anchor, atol=1e-10)
    # restoring in session 2 keeps the doorway rigidly attached to the map
    T_ar2_from_anchor = S2.transform_pose(stored)
    probe_local = np.array([0.0, 1.0, 0.0, 1.0])  # top of the door frame
    probe_map = T_map_from_anchor @ probe_local
    # (anchor-local offsets are metric, map offsets are in map units: scale 0.8)
    expected = S2.apply(T_map_from_anchor[:3, 3]) + S2.R @ (probe_map[:3] - T_map_from_anchor[:3, 3])
    assert np.allclose((T_ar2_from_anchor @ probe_local)[:3], expected, atol=1e-9)
    # euler angles the client gets reproduce the same rotation
    e = g.rotmat_to_viro_euler(T_ar2_from_anchor[:3, :3])
    assert np.allclose(g.viro_euler_to_rotmat(e), T_ar2_from_anchor[:3, :3], atol=1e-8)
