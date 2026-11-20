"""Reader for ViroReact AR recordings (``video.mp4`` + ``session.jsonl``).

STATUS: written from the open-source writer, NOT yet checked against a file
from a real phone. The schema below is what
``virocore/android/sharedCode/src/main/java/com/viro/core/internal/ARSessionRecorder.java``
(ReactVision/virocore, main branch, read on 2026-11-20) writes:

    {"type":"header","intrinsics":{"fx","fy","cx","cy","width","height"},
     "extrinsics":{...},"depth":false}                          <- first line
    {"type":"pose","t":<ns>,"orientation":[qx,qy,qz,qw],
     "position":[x,y,z],"gravity":[gx,gy,gz][,"gps":{...}]}      <- one per video frame
    {"type":"imu","t":<ns>,"accel":[...],"gyro":[...]}           <- ignored here
    {"type":"depth",...}                                         <- ignored here

Facts taken from that source:

* ``orientation``/``position`` are the renderer camera (the inverse ARCore view
  matrix): camera axes x right, y up, looking along -z, in the ARCore world
  (y up, metres). That is exactly what ``onCameraTransformUpdate`` reports.
* The video frames are the ARCore CPU image in *sensor-native* orientation
  (usually landscape) and the header intrinsics refer to those pixels. The
  container carries an orientation hint so that players show the video upright.
* There is no frame index: the n-th ``pose`` line belongs to the n-th encoded
  frame, whose presentation time is ``t - t_first_pose``.

TODO(device) - to confirm with the first real recording:

1. Pose vs. pixels. The pose is display-oriented while the pixels are
   sensor-native. This reader rotates every frame upright by the container's
   orientation hint (and the intrinsics with it) and then treats the upright
   image as the view of the reported camera. If the phone's display rotation
   differs from the hint, pass ``display_rotation_cw`` explicitly.
2. The sign convention of the hint as OpenCV reports it
   (``CAP_PROP_ORIENTATION_META`` taken as "degrees clockwise for display").
3. Frame/pose pairing when the encoder dropped frames (handled by timestamps,
   falls back to pairing by index).

``tests/test_recording.py`` round-trips a synthetic recording written by
:func:`write_recording`, so the parsing and the frame/pose pairing are covered;
only the three device facts above are open.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import cv2
import numpy as np

from . import geometry as g
from .capture import CaptureInfo, Frame, rotate_image_cw, rotate_intrinsics_cw

log = logging.getLogger(__name__)


@dataclass
class RecordedPose:
    t_ns: int
    T_arworld_from_arcam: np.ndarray


@dataclass
class SessionLog:
    intrinsics: dict | None  # fx, fy, cx, cy, width, height of the sensor-native frames
    poses: list[RecordedPose]
    skipped_lines: int = 0


def parse_session_jsonl(path: str | Path) -> SessionLog:
    intr, poses, skipped = None, [], 0
    with open(path, "r", encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            try:
                rec = json.loads(ln)
            except json.JSONDecodeError:
                skipped += 1  # e.g. a truncated last line when the app was killed
                continue
            kind = rec.get("type")
            if kind == "header":
                i = rec.get("intrinsics") or {}
                if all(k in i for k in ("fx", "fy", "cx", "cy")):
                    intr = {k: float(i[k]) for k in ("fx", "fy", "cx", "cy")}
                    intr["width"], intr["height"] = int(i.get("width", 0)), int(i.get("height", 0))
            elif kind == "pose":
                try:
                    T = g.make_T(g.quat_to_rotmat(rec["orientation"]), rec["position"])
                    poses.append(RecordedPose(int(rec["t"]), T))
                except (KeyError, ValueError, TypeError):
                    skipped += 1
    return SessionLog(intr, poses, skipped)


class ViroRecordingCapture:
    """A recording folder as a :class:`locserver.capture.Capture` with metric poses."""

    def __init__(
        self,
        path: str | Path,
        video_name: str = "video.mp4",
        session_name: str = "session.jsonl",
        display_rotation_cw: int | None = None,
    ):
        self.path = Path(path)
        self.video = self.path / video_name
        self.session = parse_session_jsonl(self.path / session_name)
        if not self.session.poses:
            raise ValueError(f"{self.path / session_name} contains no pose records")
        cap = self._open()
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(cap.get(cv2.CAP_PROP_FPS)) or None
        hint = int(round(cap.get(cv2.CAP_PROP_ORIENTATION_META))) % 360
        w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
        self.rotation_cw = hint if display_rotation_cw is None else int(display_rotation_cw) % 360
        self.info = CaptureInfo("viro_recording", str(self.path), n if n > 0 else None, fps, has_metric_poses=True)
        self.info.notes.append("UNVERIFIED reader: pose/pixel orientation pairing not yet checked on a device")
        self.info.notes.append(f"frames rotated {self.rotation_cw} deg clockwise (container hint {hint})")
        if n > 0 and n != len(self.session.poses):
            self.info.notes.append(f"{n} video frames vs {len(self.session.poses)} pose records: paired by timestamp")
        i = self.session.intrinsics
        if i:
            iw, ih = i["width"] or w, i["height"] or h
            if (iw, ih) != (w, h) and w and h:  # the encoder may have scaled the frames
                sx, sy = w / iw, h / ih
                i = dict(fx=i["fx"] * sx, fy=i["fy"] * sy, cx=i["cx"] * sx, cy=i["cy"] * sy, width=w, height=h)
                iw, ih = w, h
            fx, fy, cx, cy, rw, rh = rotate_intrinsics_cw(i["fx"], i["fy"], i["cx"], i["cy"], iw, ih, self.rotation_cw)
            self.info.intrinsics = dict(fx=fx, fy=fy, cx=cx, cy=cy, width=rw, height=rh)

    def _open(self) -> cv2.VideoCapture:
        cap = cv2.VideoCapture(str(self.video))
        if not cap.isOpened():
            raise IOError(f"cannot open video {self.video}")
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)  # keep sensor-native pixels; we rotate ourselves
        return cap

    def _pose_for(self, index: int, pos_ms: float, by_index: bool) -> np.ndarray | None:
        poses = self.session.poses
        if by_index:
            return poses[index].T_arworld_from_arcam if index < len(poses) else None
        t0 = poses[0].t_ns
        rel = np.array([(p.t_ns - t0) / 1e6 for p in poses])
        j = int(np.argmin(np.abs(rel - pos_ms)))
        step = np.median(np.diff(rel)) if len(rel) > 1 else 33.0
        return poses[j].T_arworld_from_arcam if abs(rel[j] - pos_ms) <= 0.6 * step else None

    def frames(self, step: int = 1) -> Iterator[Frame]:
        cap = self._open()
        by_index = not self.info.num_frames or self.info.num_frames == len(self.session.poses)
        i = 0
        try:
            while cap.grab():
                if i % step == 0:
                    pos_ms = float(cap.get(cv2.CAP_PROP_POS_MSEC))
                    ok, img = cap.retrieve()
                    if not ok:
                        break
                    yield Frame(i, rotate_image_cw(img, self.rotation_cw), pos_ms / 1000.0, self._pose_for(i, pos_ms, by_index))
                i += 1
        finally:
            cap.release()


# --------------------------------------------------------------------------- #
def write_recording(
    out_dir: str | Path,
    images: list[np.ndarray],
    poses_T_arworld_from_arcam: list[np.ndarray],
    intrinsics: dict,
    fps: float = 30.0,
) -> Path:
    """Write a synthetic recording in the schema above (for tests and demos).

    The frames are written as given (no orientation hint can be set through
    OpenCV), so the result corresponds to a phone held in landscape.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    h, w = images[0].shape[:2]
    vw = cv2.VideoWriter(str(out / "video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not vw.isOpened():
        raise IOError("cannot open the mp4 writer")
    for img in images:
        vw.write(img)
    vw.release()
    t0 = 1_000_000_000_000
    with open(out / "session.jsonl", "w", encoding="utf-8") as fh:
        hdr = {
            "type": "header",
            "intrinsics": {**{k: float(intrinsics[k]) for k in ("fx", "fy", "cx", "cy")}, "width": w, "height": h},
            "extrinsics": {"q_imu_cam": [0, 0, 0, 1], "p_imu_cam": [0, 0, 0], "time_offset": 0.0},
            "depth": False,
        }
        fh.write(json.dumps(hdr) + "\n")
        for k, T in enumerate(poses_T_arworld_from_arcam):
            rec = {
                "type": "pose",
                "t": t0 + int(round(k * 1e9 / fps)),
                "orientation": [float(v) for v in g.rotmat_to_quat(T[:3, :3])],
                "position": [float(v) for v in T[:3, 3]],
                "gravity": [0.0, -9.81, 0.0],
            }
            fh.write(json.dumps(rec) + "\n")
    return out
