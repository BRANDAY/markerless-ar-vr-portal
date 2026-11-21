"""Reader for ViroReact AR recordings (``video.mp4`` + ``session.jsonl``).

STATUS: checked against two captures from a phone (Xiaomi 14 Ultra, Android 16,
2026-11-20; 15 and 18 frames, phone held upright) - see
``tests/test_device_capture.py`` and ``app/docs/capture-format.md``. A full
room scan from a phone has not been read yet.

    {"type":"header","intrinsics":{"fx","fy","cx","cy","width","height"},
     "extrinsics":{...},"depth":false}                          <- first line
    {"type":"pose","t":<ns>,"orientation":[qx,qy,qz,qw],
     "position":[x,y,z],"gravity":[gx,gy,gz][,"gps":{...}]}      <- one per video frame
    {"type":"imu","t":<ns>,"accel":[...],"gyro":[...]}           <- ignored here
    {"type":"depth",...}                                         <- ignored here

What the reader relies on, and how it was checked:

* **Pose.** ``orientation`` is a quaternion ``[x, y, z, w]`` camera -> world and
  ``position`` the camera centre, in the AR world of the session (y up,
  metres). The camera frame is x right, y up, looking along -z **of the
  upright picture** (the portrait screen).
* **Pixels.** The video frames are the sensor-native image (1920 x 1080
  landscape on the test phone) and the header intrinsics refer to those
  pixels; the container carries a rotation tag (90 degrees clockwise) so that
  players show the picture upright.
* **Bringing the two together.** Every frame is rotated upright by the
  container's tag, and the intrinsics with it; the upright image is then the
  view of the reported camera. Checked on both captures: with the 90-degree
  rotation the poses predict the motion of image features between the first
  and the last frame to 1-10 px (epipolar error 0.4-1.0 px); with 0, 180 or
  270 degrees the error is 12 to 17 times larger. OpenCV reports the tag as
  ``CAP_PROP_ORIENTATION_META`` = 90 and returns unrotated frames when
  ``CAP_PROP_ORIENTATION_AUTO`` is switched off; should a build of OpenCV
  rotate anyway, the reader notices it by the frame size and does not rotate
  twice. ``display_rotation_cw`` overrides the tag.
* **Pairing.** The n-th ``pose`` line belongs to the n-th encoded frame; the
  frame rate is variable (33-133 ms between frames on the test phone, about
  16 per second). Frames and poses are paired by number when their counts are
  equal (they were: 15/15 and 18/18), otherwise by time: a frame's time in the
  video is ``t - t(first pose)``, which matched the container to 0.1 ms.
* **Not used:** ``gravity`` (accelerometer in the camera frame, pointing up,
  zero in the first pose line) and the ``imu`` lines. The AR world is already
  gravity-aligned.

Still open (no data yet): a recording of one to two minutes, a phone held in
landscape, and encoders that drop frames.
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

# A recording has to be at least this much to be worth a build (refused at upload otherwise):
MIN_RECORDING_SECONDS = 3.0
MIN_RECORDING_FRAMES = 30
MIN_RECORDING_TRAVEL_M = 0.30

# A motion-capture world with z up (TUM RGB-D) expressed as an AR world with y up.
# Demo recordings made from such sequences need it: an AR recording has gravity along -y.
T_YUP_FROM_ZUP = g.make_T(np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]]), np.zeros(3))


@dataclass
class RecordedPose:
    t_ns: int
    T_arworld_from_arcam: np.ndarray


@dataclass
class SessionLog:
    intrinsics: dict | None  # fx, fy, cx, cy, width, height of the sensor-native frames
    poses: list[RecordedPose]
    skipped_lines: int = 0


def recording_problem(slog: "SessionLog") -> tuple[str, str] | None:
    """Why this recording cannot become a map, as ``(code, text for the user)`` - or None if it can be tried.

    Cheap checks on the pose lines only, so that a recording made by accident is
    refused when it arrives and not after minutes of reconstruction.
    """
    n = len(slog.poses)
    seconds = (slog.poses[-1].t_ns - slog.poses[0].t_ns) / 1e9 if n > 1 else 0.0
    if n < MIN_RECORDING_FRAMES or seconds < MIN_RECORDING_SECONDS:
        return ("recording_too_short",
                f"the recording is too short to build a map: {seconds:.1f} s, {n} frames (at least {MIN_RECORDING_SECONDS:.0f} s and "
                f"{MIN_RECORDING_FRAMES} frames are needed). Record while walking through the room - one to two minutes is a good length")
    pos = np.array([p.T_arworld_from_arcam[:3, 3] for p in slog.poses])
    if not np.isfinite(pos).all():
        return ("bad_poses", "the recording contains camera positions that are not numbers")
    travel = float(np.linalg.norm(pos.max(0) - pos.min(0)))
    if travel < MIN_RECORDING_TRAVEL_M:
        return ("too_little_motion",
                f"the phone hardly moved during the recording: {travel * 100:.0f} cm (at least {MIN_RECORDING_TRAVEL_M * 100:.0f} cm are needed). "
                "Turning on the spot is not enough - walk through the room and along the walls while recording")
    return None


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
        ok, first = cap.read()  # the size the decoder really delivers (the properties can lie about rotated video)
        w, h = (first.shape[1], first.shape[0]) if ok else (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        cap.release()
        self.rotation_cw = hint if display_rotation_cw is None else int(display_rotation_cw) % 360
        self.info = CaptureInfo("viro_recording", str(self.path), n if n > 0 else None, fps, has_metric_poses=True)
        # The decoder was told not to rotate. If it did anyway (frame size = header size turned by 90 degrees),
        # the pixels are upright already: rotate only the intrinsics, not the frames a second time.
        hw, hh = (self.session.intrinsics or {}).get("width"), (self.session.intrinsics or {}).get("height")
        self.decoder_rotated = bool(hw and hh and hw != hh and self.rotation_cw in (90, 270) and (w, h) == (hh, hw))
        if self.decoder_rotated:
            w, h = h, w  # size of the sensor-native frame, which the intrinsics refer to
            self.info.notes.append("the video decoder applied the rotation tag itself; frames are not rotated again")
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
        # The frame rate is variable (33 / 67 ms steps on a phone), so the tolerance follows the SHORTEST step:
        # a frame whose own pose line is missing must stay without a pose instead of taking its neighbour's.
        steps = np.diff(rel)
        step = float(steps[steps > 0].min()) if (steps > 0).any() else 33.0
        return poses[j].T_arworld_from_arcam if abs(rel[j] - pos_ms) <= 0.45 * step else None

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
                    if not self.decoder_rotated:
                        img = rotate_image_cw(img, self.rotation_cw)
                    yield Frame(i, img, pos_ms / 1000.0, self._pose_for(i, pos_ms, by_index))
                i += 1
        finally:
            cap.release()


# --------------------------------------------------------------------------- #
def _ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        import shutil

        exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("a phone-like recording (rotation tag, variable frame rate) needs ffmpeg: "
                               "install the dev dependencies (`uv sync`) or put ffmpeg on PATH") from None
        return exe


def write_recording(
    out_dir: str | Path,
    images: list[np.ndarray],
    poses_T_arworld_from_arcam: list[np.ndarray],
    intrinsics: dict,
    fps: float = 30.0,
    rotation_cw: int = 0,
    times_s: list[float] | None = None,
) -> Path:
    """Write a synthetic recording in the schema above (for tests, demos and the phone simulator).

    ``images`` are upright pictures, ``intrinsics`` belong to them and the poses
    are those of the upright camera - as on a phone. With ``rotation_cw`` (90 on
    a phone held upright) the frames are stored turned back into the "sensor"
    orientation together with their intrinsics, and the container gets the
    rotation tag; ``times_s`` gives every frame its own time (variable frame
    rate). Both need ffmpeg (shipped with the dev dependency ``imageio-ffmpeg``);
    without them OpenCV writes a plain constant-rate file.
    """
    import shutil
    import subprocess

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rotation_cw = int(rotation_cw) % 360
    back = (360 - rotation_cw) % 360
    stored = [rotate_image_cw(img, back) for img in images]
    uh, uw = images[0].shape[:2]
    fx, fy, cx, cy, w, h = rotate_intrinsics_cw(*(float(intrinsics[k]) for k in ("fx", "fy", "cx", "cy")), uw, uh, back)
    if times_s is None:
        times_s = [k / fps for k in range(len(images))]
    if len(times_s) != len(images) or len(poses_T_arworld_from_arcam) != len(images):
        raise ValueError("images, poses and times must have the same length")
    if rotation_cw == 0 and np.allclose(np.diff(times_s), 1.0 / fps, atol=1e-6):
        vw = cv2.VideoWriter(str(out / "video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        if not vw.isOpened():
            raise IOError("cannot open the mp4 writer")
        for img in stored:
            vw.write(img)
        vw.release()
    else:
        exe, tmp = _ffmpeg_exe(), out / "_frames"
        tmp.mkdir(exist_ok=True)
        try:
            for k, img in enumerate(stored):
                cv2.imwrite(str(tmp / f"f{k:05d}.png"), img)
            # every frame gets its own time: PTS(n) = sum of the steps before frame n (the 1000 fps input clock
            # only sets the resolution of the time stamps: 1 ms)
            steps = np.diff(np.asarray(times_s, dtype=float))
            pts = "+".join(f"gte(N\\,{k + 1})*{dt:.6f}" for k, dt in enumerate(steps)) or "0"
            raw = tmp / "raw.mp4"
            head = [exe, "-y", "-loglevel", "error", "-framerate", "1000", "-i", str(tmp / "f%05d.png"),
                    "-vf", f"settb=1/90000,setpts=({pts})/TB"]
            tail = ["-pix_fmt", "yuv420p", "-video_track_timescale", "90000"]
            codecs = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-bf", "0"], ["-c:v", "mpeg4", "-q:v", "3"])
            done = None
            # "-fps_mode" is the current name of the option, "-vsync" the one of ffmpeg before 5.1; x264 may be missing
            for cmd in [head + sync + tail + codec + [str(raw)] for sync in (["-fps_mode", "vfr"], ["-vsync", "vfr"]) for codec in codecs]:
                done = subprocess.run(cmd, capture_output=True)
                if done.returncode == 0:
                    break
            else:
                raise RuntimeError("ffmpeg could not encode the recording: " + done.stderr.decode("utf-8", "replace")[-400:])
            # ffmpeg's -display_rotation is counter-clockwise, the container tag of a phone is clockwise
            subprocess.run([exe, "-y", "-loglevel", "error", "-display_rotation", str(-rotation_cw), "-i", str(raw), "-c", "copy",
                            str(out / "video.mp4")], check=True, capture_output=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    t0 = 1_000_000_000_000
    with open(out / "session.jsonl", "w", encoding="utf-8") as fh:
        hdr = {
            "type": "header",
            "intrinsics": {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": w, "height": h},
            "extrinsics": {"q_imu_cam": [0, 0, 0, 1], "p_imu_cam": [0, 0, 0], "time_offset": 0.0},
            "depth": False,
        }
        fh.write(json.dumps(hdr) + "\n")
        for k, T in enumerate(poses_T_arworld_from_arcam):
            # like the recorder: the accelerometer reading in the camera frame (it points up), zero in the first line
            gravity = [0.0, 0.0, 0.0] if k == 0 else [float(v) for v in T[:3, :3].T @ np.array([0.0, 9.81, 0.0])]
            rec = {
                "type": "pose",
                "t": t0 + int(round(times_s[k] * 1e9)),
                "orientation": [float(v) for v in g.rotmat_to_quat(T[:3, :3])],
                "position": [float(v) for v in T[:3, 3]],
                "gravity": gravity,
            }
            fh.write(json.dumps(rec) + "\n")
    return out
