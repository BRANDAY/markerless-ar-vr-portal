"""Capture readers: turn a video, an image folder or a recording into frames.

Every reader yields :class:`Frame` objects in capture order. Frame *selection*
(subsampling, blur rejection, resizing) is shared and lives in
:func:`select_frames`, so all input kinds behave the same.

Supported inputs (see :func:`open_capture`):

* a video file (``.mp4``, ``.mov``, ...) - phone rotation metadata is applied;
* a folder of images (sorted by name);
* a TUM RGB-D sequence folder (``rgb.txt`` + ``groundtruth.txt``) - used for the
  public test data, provides metric ground-truth poses;
* a ViroReact AR recording folder (``video.mp4`` + ``session.jsonl``) - see
  :mod:`locserver.recording`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Protocol

import cv2
import numpy as np

from . import geometry as g

log = logging.getLogger(__name__)

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp"}


@dataclass
class Frame:
    index: int  # position in the source (video frame number / file index)
    image: np.ndarray  # BGR, upright
    timestamp: float | None = None  # seconds
    # Metric pose of the camera in the capture's own world frame, GL camera
    # convention (x right, y up, looking along -z), if the source provides one.
    T_world_from_arcam: np.ndarray | None = None


@dataclass
class CaptureInfo:
    kind: str  # "video" | "images" | "tum" | "viro_recording"
    source: str
    num_frames: int | None = None
    fps: float | None = None
    has_metric_poses: bool = False
    # Optional calibration for the *native* frame size: fx, fy, cx, cy, width, height
    intrinsics: dict | None = None
    notes: list[str] = field(default_factory=list)


class Capture(Protocol):
    info: CaptureInfo

    def frames(self, step: int = 1) -> Iterator[Frame]:
        """Yield frames; ``step`` > 1 may skip decoding of unused frames."""
        ...


# --------------------------------------------------------------------------- #
def sharpness(image_bgr: np.ndarray, long_side: int = 480) -> float:
    """Variance of the Laplacian on a small grey copy. Higher = sharper."""
    h, w = image_bgr.shape[:2]
    s = long_side / max(h, w)
    grey = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    if s < 1.0:
        grey = cv2.resize(grey, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def resize_max(image: np.ndarray, max_size: int) -> tuple[np.ndarray, float]:
    """Downscale so the longer side is at most ``max_size``. Returns (image, scale)."""
    h, w = image.shape[:2]
    s = max_size / max(h, w)
    if s >= 1.0:
        return image, 1.0
    out = cv2.resize(image, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return out, s


def rotate_image_cw(image: np.ndarray, degrees_cw: int) -> np.ndarray:
    d = int(degrees_cw) % 360
    if d == 0:
        return image
    if d == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if d == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if d == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    raise ValueError("rotation must be a multiple of 90 degrees")


def rotate_intrinsics_cw(fx, fy, cx, cy, width, height, degrees_cw: int):
    """Intrinsics of an image after rotating it clockwise by a multiple of 90 deg.

    Uses the pixel-centre-at-(x+0.5, y+0.5) convention, under which a point (x, y)
    of a W x H image moves to (H - y, x) for 90 deg clockwise.
    """
    d = int(degrees_cw) % 360
    if d == 0:
        return fx, fy, cx, cy, width, height
    if d == 90:
        return fy, fx, height - cy, cx, height, width
    if d == 180:
        return fx, fy, width - cx, height - cy, width, height
    if d == 270:
        return fy, fx, cy, width - cx, height, width
    raise ValueError("rotation must be a multiple of 90 degrees")


# --------------------------------------------------------------------------- #
class VideoCapture:
    """Video file. OpenCV applies the container's rotation tag (phone portrait)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        cap = self._open()
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(cap.get(cv2.CAP_PROP_FPS)) or None
        meta = cap.get(cv2.CAP_PROP_ORIENTATION_META)
        cap.release()
        self.info = CaptureInfo("video", str(self.path), n if n > 0 else None, fps)
        if meta:
            self.info.notes.append(f"container rotation tag {meta:.0f} deg applied on decode")

    def _open(self) -> cv2.VideoCapture:
        cap = cv2.VideoCapture(str(self.path))
        if not cap.isOpened():
            raise IOError(f"cannot open video {self.path}")
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        return cap

    def frames(self, step: int = 1) -> Iterator[Frame]:
        cap = self._open()
        fps = self.info.fps
        i = 0
        try:
            while True:
                if not cap.grab():
                    break
                if i % step == 0:
                    ok, img = cap.retrieve()
                    if not ok:
                        break
                    yield Frame(i, img, i / fps if fps else None)
                i += 1
        finally:
            cap.release()


class ImageFolderCapture:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.files = sorted(p for p in self.path.iterdir() if p.suffix.lower() in IMAGE_EXT)
        if not self.files:
            raise IOError(f"no images in {self.path}")
        self.info = CaptureInfo("images", str(self.path), len(self.files))

    def frames(self, step: int = 1) -> Iterator[Frame]:
        for i in range(0, len(self.files), step):
            img = cv2.imread(str(self.files[i]), cv2.IMREAD_COLOR)
            if img is None:
                log.warning("unreadable image skipped: %s", self.files[i])
                continue
            yield Frame(i, img)


class TumCapture:
    """TUM RGB-D sequence: ``rgb.txt`` (timestamp, file) + ``groundtruth.txt``.

    Ground truth is ``timestamp tx ty tz qx qy qz qw`` = pose of the colour camera
    (OpenCV axes) in the motion-capture world, metres. It is exposed in the GL
    camera convention, like an AR session would report it.
    """

    # Published calibration of the freiburg1 colour camera (ROS default if unknown).
    FR_INTRINSICS = {
        "freiburg1": dict(fx=517.3, fy=516.5, cx=318.6, cy=255.3, width=640, height=480),
        "freiburg2": dict(fx=520.9, fy=521.0, cx=325.1, cy=249.7, width=640, height=480),
        "freiburg3": dict(fx=535.4, fy=539.2, cx=320.1, cy=247.6, width=640, height=480),
    }

    def __init__(self, path: str | Path, max_dt: float = 0.02):
        self.path = Path(path)
        self.rgb = self._read_list(self.path / "rgb.txt")
        gt_file = self.path / "groundtruth.txt"
        self.poses: list[np.ndarray | None] = [None] * len(self.rgb)
        if gt_file.exists():
            gt = np.array([[float(v) for v in ln.split()] for ln in self._lines(gt_file)])
            for i, (ts, _) in enumerate(self.rgb):
                j = int(np.argmin(np.abs(gt[:, 0] - ts)))
                if abs(gt[j, 0] - ts) <= max_dt:
                    T_world_from_cvcam = g.make_T(g.quat_to_rotmat(gt[j, 4:8]), gt[j, 1:4])
                    self.poses[i] = T_world_from_cvcam @ g.make_T(g.CV_FROM_GL, np.zeros(3))
        self.info = CaptureInfo(
            "tum", str(self.path), len(self.rgb), 30.0, has_metric_poses=any(p is not None for p in self.poses)
        )
        for key, intr in self.FR_INTRINSICS.items():
            if key in self.path.name:
                self.info.intrinsics = dict(intr)

    @staticmethod
    def _lines(path: Path) -> list[str]:
        return [ln for ln in path.read_text().splitlines() if ln.strip() and not ln.startswith("#")]

    def _read_list(self, path: Path) -> list[tuple[float, str]]:
        return [(float(a), b) for a, b in (ln.split()[:2] for ln in self._lines(path))]

    def frames(self, step: int = 1) -> Iterator[Frame]:
        for i in range(0, len(self.rgb), step):
            ts, rel = self.rgb[i]
            img = cv2.imread(str(self.path / rel), cv2.IMREAD_COLOR)
            if img is None:
                continue
            yield Frame(i, img, ts, self.poses[i])


def open_capture(path: str | Path) -> Capture:
    """Pick a reader from what ``path`` looks like."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    if p.is_file():
        if p.suffix.lower() in VIDEO_EXT:
            return VideoCapture(p)
        raise ValueError(f"unsupported input file type: {p.suffix}")
    if (p / "session.jsonl").exists():
        from .recording import ViroRecordingCapture

        return ViroRecordingCapture(p)
    if (p / "rgb.txt").exists():
        return TumCapture(p)
    return ImageFolderCapture(p)


# --------------------------------------------------------------------------- #
@dataclass
class SelectedFrame:
    frame: Frame
    sharpness: float
    scale: float  # resize factor applied to frame.image


def select_frames(
    capture: Capture,
    target_fps: float | None = 3.0,
    every: int | None = None,
    max_frames: int = 200,
    max_size: int = 1024,
    blur_ratio: float = 0.35,
) -> tuple[list[SelectedFrame], dict]:
    """Subsample a capture and reject blurred frames.

    1. The capture is cut into windows of ``every`` source frames (derived from
       ``target_fps`` when the source frame rate is known, and enlarged if the
       result would exceed ``max_frames``).
    2. From every window only the sharpest frame is kept (motion blur on a phone
       comes in bursts, so there is usually a sharp neighbour).
    3. Frames whose sharpness is below ``blur_ratio`` x the median of the kept
       frames are dropped.
    4. Images are downscaled to ``max_size`` on the longer side.
    """
    info = capture.info
    if every is None:
        every = max(1, round(info.fps / target_fps)) if (info.fps and target_fps) else 1
    if info.num_frames and info.num_frames / every > max_frames:
        every = int(np.ceil(info.num_frames / max_frames))

    # Decode a few candidates per window rather than every frame.
    cand_step = max(1, every // 4)
    best: dict[int, SelectedFrame] = {}
    decoded = 0
    for fr in capture.frames(step=cand_step):
        decoded += 1
        s = sharpness(fr.image)
        win = fr.index // every
        if win not in best or s > best[win].sharpness:
            img, scale = resize_max(fr.image, max_size)
            best[win] = SelectedFrame(Frame(fr.index, img, fr.timestamp, fr.T_world_from_arcam), s, scale)
    kept = [best[k] for k in sorted(best)]
    if not kept:
        raise ValueError("capture has no readable frames")
    median = float(np.median([k.sharpness for k in kept]))
    sharp = [k for k in kept if k.sharpness >= blur_ratio * median]
    if len(sharp) > max_frames:
        idx = np.linspace(0, len(sharp) - 1, max_frames).round().astype(int)
        sharp = [sharp[i] for i in idx]
    stats = dict(
        source_frames=info.num_frames,
        decoded_candidates=decoded,
        window=every,
        candidates_per_window=max(1, every // cand_step),
        windows=len(kept),
        rejected_blur=len(kept) - len([k for k in kept if k.sharpness >= blur_ratio * median]),
        selected=len(sharp),
        median_sharpness=round(median, 1),
        blur_ratio=blur_ratio,
        max_size=max_size,
    )
    return sharp, stats
