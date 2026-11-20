"""Phone videos are stored sensor-native (landscape) plus a rotation tag.

These tests build such a file with the ffmpeg binary shipped by the dev
dependency ``imageio-ffmpeg`` and check that both readers end up with upright
frames: the plain video reader through OpenCV's auto-rotation, the ViroReact
recording reader through its own rotation by the container hint.
"""

import subprocess

import cv2
import numpy as np
import pytest

from locserver.capture import VideoCapture
from locserver.recording import ViroRecordingCapture, write_recording

imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")

W, H = 96, 64


def landscape_frames(n=6):
    """Dark frames with a white block in the top-left corner."""
    frames = []
    for _ in range(n):
        img = np.full((H, W, 3), 30, np.uint8)
        img[:16, :24] = 255
        frames.append(img)
    return frames


def tag_rotation(src, dst, degrees_cw):
    # ffmpeg's -display_rotation is counter-clockwise, Android's orientation hint is clockwise
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-display_rotation", str(-degrees_cw),
           "-i", str(src), "-c", "copy", str(dst)]
    subprocess.run(cmd, check=True)


def bright_corner(img):
    h, w = img.shape[:2]
    q = {"top-left": img[: h // 4, : w // 4], "top-right": img[: h // 4, -w // 4 :],
         "bottom-right": img[-h // 4 :, -w // 4 :], "bottom-left": img[-h // 4 :, : w // 4]}
    return max(q, key=lambda k: q[k].mean())


@pytest.mark.parametrize("hint,corner,shape", [(90, "top-right", (W, H)), (180, "bottom-right", (H, W)), (270, "bottom-left", (W, H))])
def test_plain_video_reader_applies_rotation_tag(tmp_path, hint, corner, shape):
    rec = write_recording(tmp_path / "raw", landscape_frames(), [np.eye(4)] * 6, dict(fx=80, fy=80, cx=48, cy=32))
    out = tmp_path / "phone.mp4"
    tag_rotation(rec / "video.mp4", out, hint)
    cap = VideoCapture(out)
    fr = next(iter(cap.frames()))
    assert fr.image.shape[:2] == shape
    assert bright_corner(fr.image) == corner
    assert any("rotation tag" in n for n in cap.info.notes)


def test_recording_reader_uses_container_hint(tmp_path):
    rec = write_recording(tmp_path / "rec", landscape_frames(), [np.eye(4)] * 6, dict(fx=80.0, fy=82.0, cx=50.0, cy=30.0))
    raw = rec / "raw.mp4"
    (rec / "video.mp4").rename(raw)
    tag_rotation(raw, rec / "video.mp4", 90)
    cap = ViroRecordingCapture(rec)
    assert cap.rotation_cw == 90
    fr = next(iter(cap.frames()))
    assert fr.image.shape[:2] == (W, H) and bright_corner(fr.image) == "top-right"
    i = cap.info.intrinsics  # sensor-native intrinsics rotated with the pixels
    assert (i["width"], i["height"], i["fx"], i["fy"]) == (H, W, 82.0, 80.0)
    assert np.isclose(i["cx"], H - 30.0) and np.isclose(i["cy"], 50.0)
    assert fr.T_world_from_arcam is not None
