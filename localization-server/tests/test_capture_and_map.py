import json

import cv2
import numpy as np
import pytest

from conftest import make_map
from locserver import geometry as g
from locserver.capture import (
    CaptureInfo,
    Frame,
    ImageFolderCapture,
    TumCapture,
    open_capture,
    resize_max,
    rotate_image_cw,
    rotate_intrinsics_cw,
    select_frames,
    sharpness,
)
from locserver.evaluate import PERTURBATIONS, split_indices, summarize
from locserver.localize import DeviceCalibrationStore, project, scale_intrinsics
from locserver.recording import ViroRecordingCapture, parse_session_jsonl, write_recording


def textured(seed=0, h=120, w=160) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return cv2.resize(rng.integers(0, 255, (h // 4, w // 4, 3), dtype=np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)


# ------------------------------------------------------------- rotation --- #
@pytest.mark.parametrize("deg", [0, 90, 180, 270])
def test_rotating_image_and_intrinsics_keeps_projections_consistent(deg):
    """A 3D point must land on the same *content* after rotating image + intrinsics."""
    w, h = 160, 120
    fx, fy, cx, cy = 140.0, 150.0, 70.0, 65.0
    img = np.zeros((h, w, 3), np.uint8)
    # the ray through the centre of pixel (col 91, row 50); COLMAP pixel centres are at +0.5
    u, v = 91.5, 50.5
    X = np.array([(u - cx) / fx, (v - cy) / fy, 1.0])  # camera frame (x right, y down, z forward)
    img[int(v), int(u)] = 255
    rimg = rotate_image_cw(img, deg)
    fx2, fy2, cx2, cy2, w2, h2 = rotate_intrinsics_cw(fx, fy, cx, cy, w, h, deg)
    assert rimg.shape[:2] == (h2, w2)
    # rotating the image clockwise by `deg` rotates the camera frame about its z axis
    Xr = g.rot_z(np.radians(deg)) @ X
    u2, v2 = fx2 * Xr[0] / Xr[2] + cx2, fy2 * Xr[1] / Xr[2] + cy2
    assert rimg[int(v2), int(u2)].max() == 255


def test_rotate_rejects_odd_angles():
    with pytest.raises(ValueError):
        rotate_image_cw(np.zeros((2, 2, 3), np.uint8), 45)


def test_resize_and_scale_intrinsics():
    img, s = resize_max(np.zeros((1080, 1920, 3), np.uint8), 1024)
    assert img.shape[:2] == (576, 1024) and np.isclose(s, 1024 / 1920)
    same, s1 = resize_max(np.zeros((480, 640, 3), np.uint8), 1024)
    assert same.shape[:2] == (480, 640) and s1 == 1.0
    i = scale_intrinsics(dict(fx=1500, fy=1500, cx=960, cy=540, width=1920, height=1080), 1024, 576)
    assert np.isclose(i["fx"], 800) and np.isclose(i["cx"], 512) and np.isclose(i["cy"], 288)


def test_project_models_agree_without_distortion():
    X = np.array([[0.2, -0.1, 2.0], [-0.5, 0.3, 4.0]])
    a = project("SIMPLE_PINHOLE", np.array([500.0, 320, 240]), X)
    b = project("PINHOLE", np.array([500.0, 500, 320, 240]), X)
    c = project("SIMPLE_RADIAL", np.array([500.0, 320, 240, 0.0]), X)
    assert np.allclose(a, b) and np.allclose(a, c)
    assert np.allclose(a[0], [500 * 0.1 + 320, 500 * -0.05 + 240])


# ------------------------------------------------------ frame selection --- #
class FakeCapture:
    def __init__(self, images, fps=30.0):
        self.images = images
        self.info = CaptureInfo("video", "fake", len(images), fps)

    def frames(self, step=1):
        for i in range(0, len(self.images), step):
            yield Frame(i, self.images[i], i / 30.0)


def test_sharpness_orders_blur():
    img = textured()
    assert sharpness(img) > sharpness(cv2.GaussianBlur(img, (0, 0), 3)) * 5


def test_select_frames_subsamples_and_rejects_blur():
    sharp = [textured(i) for i in range(60)]
    imgs = list(sharp)
    for i in range(20, 30):  # a burst of motion blur covering a whole window
        imgs[i] = cv2.GaussianBlur(imgs[i], (0, 0), 6)
    sel, stats = select_frames(FakeCapture(imgs), target_fps=3.0, max_frames=100, max_size=80)
    assert stats["window"] == 10 and stats["windows"] == 6
    assert stats["rejected_blur"] == 1 and len(sel) == 5
    assert all(not (20 <= s.frame.index < 30) for s in sel)
    assert all(max(s.frame.image.shape[:2]) == 80 and np.isclose(s.scale, 0.5) for s in sel)


def test_select_frames_respects_max_frames():
    sel, stats = select_frames(FakeCapture([textured(i) for i in range(90)]), target_fps=30.0, max_frames=10)
    assert len(sel) <= 10 and stats["window"] == 9


def test_image_folder_and_open_capture(tmp_path):
    for i in range(3):
        cv2.imwrite(str(tmp_path / f"im_{i}.png"), textured(i))
    (tmp_path / "notes.txt").write_text("x")
    cap = open_capture(tmp_path)
    assert isinstance(cap, ImageFolderCapture) and cap.info.num_frames == 3
    assert [f.index for f in cap.frames(step=2)] == [0, 2]
    with pytest.raises(FileNotFoundError):
        open_capture(tmp_path / "missing")


def test_tum_capture_reads_groundtruth_as_gl_camera(tmp_path):
    seq = tmp_path / "rgbd_dataset_freiburg1_test"
    (seq / "rgb").mkdir(parents=True)
    cv2.imwrite(str(seq / "rgb" / "1.000000.png"), textured())
    (seq / "rgb.txt").write_text("# header\n1.000000 rgb/1.000000.png\n")
    # camera at (1, 2, 3) with identity orientation in the OpenCV convention
    (seq / "groundtruth.txt").write_text("# ts tx ty tz qx qy qz qw\n1.0050 1 2 3 0 0 0 1\n")
    cap = open_capture(seq)
    assert isinstance(cap, TumCapture) and cap.info.has_metric_poses and cap.info.intrinsics["fx"] == 517.3
    fr = next(iter(cap.frames()))
    assert np.allclose(fr.T_world_from_arcam[:3, 3], [1, 2, 3])
    # CV camera looks along world +z, so the GL camera's -z axis must be world +z
    assert np.allclose(fr.T_world_from_arcam[:3, :3] @ [0, 0, -1], [0, 0, 1])


# ------------------------------------------------------------ recording --- #
def test_viro_recording_roundtrip(tmp_path):
    rng = np.random.default_rng(0)
    imgs = [np.full((48, 64, 3), 20 * (k + 1), np.uint8) for k in range(8)]
    poses = [g.make_T(g.viro_euler_to_rotmat(rng.uniform(-40, 40, 3)), rng.uniform(-1, 1, 3)) for _ in range(8)]
    intr = dict(fx=60.0, fy=61.0, cx=31.0, cy=25.0)
    rec = write_recording(tmp_path / "rec", imgs, poses, intr)
    with open(rec / "session.jsonl", "a", encoding="utf-8") as fh:
        fh.write('{"type":"imu","t":1,"accel":[0,0,9.8],"gyro":[0,0,0]}\n{"type":"pose","t":12')  # truncated tail

    log = parse_session_jsonl(rec / "session.jsonl")
    assert len(log.poses) == 8 and log.skipped_lines == 1
    assert log.intrinsics == dict(fx=60.0, fy=61.0, cx=31.0, cy=25.0, width=64, height=48)

    cap = open_capture(rec)
    assert isinstance(cap, ViroRecordingCapture) and cap.info.has_metric_poses and cap.rotation_cw == 0
    frames = list(cap.frames())
    assert len(frames) == 8
    for k, fr in enumerate(frames):
        assert np.allclose(fr.T_world_from_arcam, poses[k], atol=1e-5)
        assert abs(float(fr.image.mean()) - 20 * (k + 1)) < 6  # the right picture got the right pose
    assert [f.index for f in cap.frames(step=3)] == [0, 3, 6]


def test_viro_recording_portrait_override(tmp_path):
    imgs = [textured(k, 48, 64) for k in range(3)]
    rec = write_recording(tmp_path / "rec", imgs, [np.eye(4)] * 3, dict(fx=60.0, fy=61.0, cx=31.0, cy=25.0))
    cap = ViroRecordingCapture(rec, display_rotation_cw=90)
    fr = next(iter(cap.frames()))
    assert fr.image.shape[:2] == (64, 48)
    i = cap.info.intrinsics
    assert (i["width"], i["height"], i["fx"], i["fy"]) == (48, 64, 61.0, 60.0)
    assert np.isclose(i["cx"], 48 - 25.0) and np.isclose(i["cy"], 31.0)


def test_recording_without_poses_is_rejected(tmp_path):
    rec = write_recording(tmp_path / "rec", [textured()], [np.eye(4)], dict(fx=1, fy=1, cx=1, cy=1))
    (rec / "session.jsonl").write_text('{"type":"header"}\n')
    with pytest.raises(ValueError):
        ViroRecordingCapture(rec)


# ------------------------------------------------------------- mapstore --- #
def test_map_roundtrip_anchors_and_scale(tmp_path):
    m = make_map(tmp_path / "m", "m", metric=False)
    assert len(m.images) == 3 and m.scale_m_per_unit is None
    assert m.images[1].features.descriptors.dtype == np.float32
    assert np.allclose(m.images[2].center, [-0.2, 0, 0])
    T = g.make_T(g.viro_euler_to_rotmat([5, 10, 15]), [1, 2, 3])
    m.set_anchor("portal", T, "note")
    again = make_map.__globals__["load_map"](tmp_path / "m")
    assert np.allclose(again.anchor_T(again.anchors()["portal"]), T, atol=1e-9)
    with pytest.raises(ValueError):
        m.set_anchor("../evil", T)
    with pytest.raises(ValueError):
        m.set_anchor("skewed", g.make_T(np.diag([1, 2, 1]), [0, 0, 0]))
    m.set_scale(0.25, "test")
    assert json.loads((tmp_path / "m" / "map.json").read_text())["scale_m_per_unit"] == 0.25
    q = m.vlad.encode(m.images[1].features.descriptors)
    assert m.retrieve(q, 2)[0] == 1


def test_map_subset_drops_unsupported_points(tmp_path):
    m = make_map(tmp_path / "m", "m")
    sub = m.subset([0, 2])  # image 1 shared all its points with image 0
    assert len(sub.images) == 2 and (sub.images[0].point3D_ids == -1).all()
    assert np.isnan(sub.images[0].xyz).all() and sub.global_desc.shape[0] == 2
    both = m.subset([0, 1])
    assert (both.images[0].point3D_ids >= 0).all()


# ---------------------------------------------------------- calibration --- #
def test_device_calibration_locks_after_consistent_samples(tmp_path):
    store = DeviceCalibrationStore(tmp_path)
    assert store.get("pixel7", 1024, 768) is None
    for f in (800, 805, 795, 802):
        prof = store.add_sample("pixel7", 1024, 768, f)
    assert not prof["locked"]
    prof = store.add_sample("pixel7", 1024, 768, 799)
    assert prof["locked"]
    c = store.get("pixel7", 512, 384)  # same aspect ratio, other resolution
    assert np.isclose(c["fx"], 400, rtol=0.01) and c["cx"] == 256
    assert store.get("pixel7", 1024, 576) is None  # different aspect ratio (crop) is a different profile
    for f in (500, 1200, 650, 900, 1500):
        noisy = store.add_sample("cheap", 640, 480, f)
    assert not noisy["locked"]
    with pytest.raises(ValueError):
        store.add_sample("../x", 1, 1, 1.0)
    assert store.delete("pixel7") and not store.delete("pixel7")


# ----------------------------------------------------------- evaluation --- #
def test_split_indices():
    keep, held = split_indices(20, "interleaved", 5, 4)
    assert held == [2, 7, 12, 17] and len(keep) == 16
    keep, held = split_indices(40, "blocks", 5, 4)
    assert held == [16, 17, 18, 19, 36, 37, 38, 39] and not set(keep) & set(held)


def test_perturbations_keep_shape_and_type():
    img = textured()
    for name, fn in PERTURBATIONS.items():
        out = fn(img)
        assert out.dtype == np.uint8 and out.ndim == 3, name
        if name != "downscale":
            assert out.shape == img.shape, name
    assert PERTURBATIONS["dark"](img).mean() < img.mean() * 0.5


def test_summarize_counts_false_good():
    rows = [
        dict(success=True, quality="good", t_err=0.01, r_err_deg=0.5, inliers=200, ms=900),
        dict(success=True, quality="good", t_err=0.60, r_err_deg=1.0, inliers=70, ms=1100),  # confident but wrong
        dict(success=True, quality="weak", t_err=0.08, r_err_deg=2.0, inliers=30, ms=1000),
        dict(success=False, quality="failed", inliers=3, ms=800),
    ]
    s = summarize(rows, unit_m=1.0, extent=5.0)
    assert s["queries"] == 4 and s["success_rate"] == 0.75 and s["good_rate"] == 0.5
    assert s["false_good"] == 1 and s["recall_5cm_5deg"] == 0.25 and s["recall_10cm_10deg"] == 0.5
    assert np.isclose(s["t_err_median"], 0.08) and s["t_err_unit"] == "m"
