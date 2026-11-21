"""The recording as a phone really writes it (app/docs/capture-format.md).

Two kinds of tests:

* always run: a synthetic recording written the way the phone does it (frames
  stored in the sensor's orientation with a 90-degree rotation tag, variable
  frame rate, poses of the upright camera, binary PLY mesh), and the refusal of
  recordings that are too short or do not move;
* run only where the files exist: the two captures of 2026-11-20 from a Xiaomi
  14 Ultra. They are not in the repository (camera video of a private room).
  Set ``LOCSERVER_DEVICE_CAPTURES`` to a folder that contains ``capture-*``
  folders, or keep them under ``<LOCSERVER_ROOT>/device-tests``.
"""

import os
import struct
from pathlib import Path

import cv2
import numpy as np
import pytest

from locserver import geometry as g
from locserver.capture import rotate_image_cw, rotate_intrinsics_cw
from locserver.recording import (
    MIN_RECORDING_FRAMES,
    ViroRecordingCapture,
    parse_session_jsonl,
    recording_problem,
    write_recording,
)
from locserver.roomstage import read_ply
from test_api_v2 import builder, make_server, upload

# 33 / 67 ms between frames, as on the phone
PHONE_STEPS_S = [0.1335, 0.0667, 0.0334, 0.0668, 0.0668, 0.0334, 0.0668]


def phone_times(n):
    steps = [PHONE_STEPS_S[k % len(PHONE_STEPS_S)] for k in range(n - 1)]
    return [0.0] + list(np.cumsum(steps))


def upright_pictures(n=8, w=96, h=128):
    """Portrait pictures with a white block in the top-left corner and a grey level that tells the frames apart."""
    out = []
    for k in range(n):
        img = np.full((h, w, 3), 20 + 25 * k, np.uint8)
        img[:24, :24] = 255
        out.append(img)
    return out


def walk(n, step=0.05):
    """Poses of a camera that walks along +x and slowly turns, y up."""
    return [g.make_T(g.rot_y(np.radians(2.0 * k)), [step * k, 1.4, 0.0]) for k in range(n)]


# ------------------------------------------------------ synthetic phone file --- #
def test_phone_like_recording_round_trip(tmp_path):
    pytest.importorskip("imageio_ffmpeg")
    n = 8
    pics, poses, times = upright_pictures(n), walk(n), phone_times(n)
    upright = dict(fx=100.0, fy=104.0, cx=46.0, cy=66.0)
    rec = write_recording(tmp_path / "rec", pics, poses, upright, rotation_cw=90, times_s=times)

    # the file is what a phone writes: pixels and intrinsics in the sensor's (landscape) orientation
    slog = parse_session_jsonl(rec / "session.jsonl")
    assert (slog.intrinsics["width"], slog.intrinsics["height"]) == (128, 96)
    assert (slog.intrinsics["fx"], slog.intrinsics["fy"]) == (104.0, 100.0)
    raw = cv2.VideoCapture(str(rec / "video.mp4"))
    raw.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
    assert int(round(raw.get(cv2.CAP_PROP_ORIENTATION_META))) % 360 == 90
    ok, first = raw.read()
    raw.release()
    assert ok and first.shape[:2] == (96, 128)
    lines = (rec / "session.jsonl").read_text(encoding="utf-8").splitlines()
    assert '"gravity": [0.0, 0.0, 0.0]' in lines[1] and '"gravity": [0.0, 0.0, 0.0]' not in lines[2]

    # the reader turns it upright again, intrinsics included, and pairs every frame with its pose
    cap = ViroRecordingCapture(rec)
    assert cap.rotation_cw == 90 and not cap.decoder_rotated and cap.info.num_frames == n
    i = cap.info.intrinsics
    assert (i["width"], i["height"]) == (96, 128)
    assert np.allclose([i["fx"], i["fy"], i["cx"], i["cy"]], [100.0, 104.0, 46.0, 66.0])
    frames = list(cap.frames())
    assert len(frames) == n
    for k, fr in enumerate(frames):
        assert fr.image.shape[:2] == (128, 96)
        assert fr.image[:16, :16].mean() > 200 and abs(float(fr.image[100:, 60:].mean()) - (20 + 25 * k)) < 12  # upright, in order
        assert np.allclose(fr.T_world_from_arcam, poses[k], atol=1e-6)
        assert abs(fr.timestamp - times[k]) < 0.002  # variable frame rate kept
    assert max(np.diff(times)) > 3 * min(np.diff(times))


def test_phone_like_recording_of_many_frames_keeps_its_times(tmp_path):
    pytest.importorskip("imageio_ffmpeg")
    n = 130  # more per-frame times than ffmpeg takes in one expression
    times = phone_times(n)
    rec = write_recording(tmp_path / "rec", upright_pictures(1) * n, walk(n), dict(fx=100.0, fy=104.0, cx=46.0, cy=66.0),
                          rotation_cw=90, times_s=times)
    frames = list(ViroRecordingCapture(rec).frames())
    assert len(frames) == n and all(fr.T_world_from_arcam is not None for fr in frames)
    assert np.abs(np.array([fr.timestamp for fr in frames]) - times).max() < 0.002


def test_frames_and_poses_are_paired_by_time_when_the_counts_differ(tmp_path):
    pytest.importorskip("imageio_ffmpeg")
    n = 8
    rec = write_recording(tmp_path / "rec", upright_pictures(n), walk(n), dict(fx=100.0, fy=104.0, cx=46.0, cy=66.0),
                          rotation_cw=90, times_s=phone_times(n))
    lines = (rec / "session.jsonl").read_text(encoding="utf-8").splitlines()
    del lines[4]  # the pose of frame 3 is missing
    (rec / "session.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    cap = ViroRecordingCapture(rec)
    frames = list(cap.frames())
    assert len(frames) == n and frames[3].T_world_from_arcam is None
    for k in (0, 1, 2, 4, 5, 6, 7):
        assert np.allclose(frames[k].T_world_from_arcam, walk(n)[k], atol=1e-6)


def test_a_decoder_that_rotates_on_its_own_is_not_rotated_twice(tmp_path, monkeypatch):
    pytest.importorskip("imageio_ffmpeg")
    rec = write_recording(tmp_path / "rec", upright_pictures(4), walk(4), dict(fx=100.0, fy=104.0, cx=46.0, cy=66.0),
                          rotation_cw=90, times_s=phone_times(4))

    def open_rotating(self):  # an OpenCV build that ignores CAP_PROP_ORIENTATION_AUTO = 0
        cap = cv2.VideoCapture(str(self.video))
        cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
        return cap

    monkeypatch.setattr(ViroRecordingCapture, "_open", open_rotating)
    cap = ViroRecordingCapture(rec)
    assert cap.decoder_rotated and any("applied the rotation tag itself" in note for note in cap.info.notes)
    fr = next(iter(cap.frames()))
    assert fr.image.shape[:2] == (128, 96) and fr.image[:16, :16].mean() > 200
    assert np.allclose([cap.info.intrinsics[k] for k in ("fx", "fy", "cx", "cy")], [100.0, 104.0, 46.0, 66.0])


# ------------------------------------------------- refusal when it arrives --- #
def session(n, dt_s=0.0667, step_m=0.02):
    import json

    lines = [json.dumps({"type": "header", "intrinsics": {"fx": 500, "fy": 500, "cx": 320, "cy": 240, "width": 640, "height": 480}})]
    lines += [json.dumps({"type": "pose", "t": int(k * dt_s * 1e9), "orientation": [0, 0, 0, 1], "position": [step_m * k, 1.4, 0],
                          "gravity": [0, 0, 0] if k == 0 else [0, 9.81, 0]}) for k in range(n)]
    return ("\n".join(lines) + "\n").encode()


def test_recording_problem_names_what_is_wrong(tmp_path):
    def problem(data):
        f = tmp_path / "session.jsonl"
        f.write_bytes(data)
        return recording_problem(parse_session_jsonl(f))

    assert problem(session(120)) is None
    code, text = problem(session(15))  # the accidental 0.9 s capture
    assert code == "recording_too_short" and "0.9 s, 15 frames" in text and "one to two minutes" in text
    assert problem(session(MIN_RECORDING_FRAMES - 1, dt_s=1.0))[0] == "recording_too_short"  # long enough, too few frames
    assert problem(session(200, dt_s=0.01))[0] == "recording_too_short"  # enough frames, 2 s
    code, text = problem(session(120, step_m=0.0005))  # standing still for 8 s
    assert code == "too_little_motion" and "6 cm" in text and "walk through the room" in text


def test_a_recording_that_cannot_work_is_refused_at_upload(tmp_path):
    c = make_server(tmp_path, builder())
    r = upload(c, "room", session=session(15))
    assert r.status_code == 422 and r.headers["x-error-code"] == "recording_too_short"
    assert "too short" in r.json()["detail"] and "15 frames" in r.json()["detail"]
    r = upload(c, "room", session=session(120, step_m=0.0))
    assert r.status_code == 422 and r.headers["x-error-code"] == "too_little_motion"
    # nothing was queued and nothing is left on disk
    assert c.get("/jobs").json()["jobs"] == [] and not list((tmp_path / "work" / "jobs").glob("*/video.mp4"))
    assert upload(c, "room", session=session(120)).status_code == 202


# ------------------------------------------------------------ mesh as PLY --- #
def write_app_ply(path, vertices, confidence, triangles):
    """Binary PLY exactly as the app's `meshFormat.ts` writes it."""
    head = ("ply\nformat binary_little_endian 1.0\ncomment AR Portal world mesh\n"
            f"element vertex {len(vertices)}\nproperty float x\nproperty float y\nproperty float z\nproperty float confidence\n"
            f"element face {len(triangles)}\nproperty list uchar int vertex_indices\nend_header\n")
    body = b"".join(struct.pack("<4f", *v, c) for v, c in zip(vertices, confidence))
    body += b"".join(struct.pack("<B3i", 3, *t) for t in triangles)
    Path(path).write_bytes(head.encode("ascii") + body)


def test_mesh_ply_of_the_app_is_read(tmp_path):
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 2.5, 0], [0, 2.5, 0]], np.float32)
    t = [[0, 1, 2], [0, 2, 3]]
    write_app_ply(tmp_path / "world_mesh.ply", v, [0.9, 0.8, 1.0, 0.1], t)
    verts, faces = read_ply(tmp_path / "world_mesh.ply")
    assert np.allclose(verts, v) and [list(f) for f in faces] == t


# ------------------------------------------------- the captures of a phone --- #
def device_captures():
    roots = [os.environ.get("LOCSERVER_DEVICE_CAPTURES"), os.path.join(os.environ.get("LOCSERVER_ROOT") or "", "device-tests")]
    found = []
    for root in roots:
        if root and Path(root).is_dir():
            found += sorted(p.parent for p in Path(root).rglob("capture-*/session.jsonl") if (p.parent / "video.mp4").exists())
    return found


CAPTURES = device_captures()
needs_captures = pytest.mark.skipif(not CAPTURES, reason="no phone captures on this machine (see the module docstring)")


def pose_error_px(img_a, img_b, T_a, T_b, intr):
    """How well the two AR poses explain where image features moved, in pixels (median).

    With a camera that moved: distance from the epipolar lines the poses predict.
    With a camera that only turned (less than 5 mm of travel): distance from where
    the rotation alone puts every feature.
    """
    orb = cv2.ORB_create(3000)
    ka, da = orb.detectAndCompute(cv2.cvtColor(img_a, cv2.COLOR_BGR2GRAY), None)
    kb, db = orb.detectAndCompute(cv2.cvtColor(img_b, cv2.COLOR_BGR2GRAY), None)
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(da, db)
    pa, pb = np.array([ka[x.queryIdx].pt for x in m]), np.array([kb[x.trainIdx].pt for x in m])
    _, inl = cv2.findFundamentalMat(pa, pb, cv2.FM_RANSAC, 2.0, 0.999)  # matches the images agree on, poses not involved
    pa, pb = pa[inl.ravel() > 0], pb[inl.ravel() > 0]
    K = np.array([[intr["fx"], 0, intr["cx"]], [0, intr["fy"], intr["cy"]], [0, 0, 1.0]])
    gl = g.make_T(g.CV_FROM_GL, np.zeros(3))
    T = np.linalg.inv(T_b @ gl) @ (T_a @ gl)  # camera b <- camera a, OpenCV axes
    R, t = T[:3, :3], T[:3, 3]
    if np.linalg.norm(t) < 0.005:
        q = (K @ R @ np.linalg.inv(K) @ np.c_[pa, np.ones(len(pa))].T).T
        return float(np.median(np.linalg.norm(q[:, :2] / q[:, 2:] - pb, axis=1))), len(pa)
    E = np.array([[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]) @ R
    F = np.linalg.inv(K).T @ E @ np.linalg.inv(K)
    x1, x2 = np.c_[pa, np.ones(len(pa))], np.c_[pb, np.ones(len(pb))]
    l2, l1 = (F @ x1.T).T, (F.T @ x2.T).T
    d = np.abs(np.sum(x2 * l2, axis=1)) / np.sqrt(l2[:, 0] ** 2 + l2[:, 1] ** 2 + l1[:, 0] ** 2 + l1[:, 1] ** 2)
    return float(np.median(d)), len(pa)


@needs_captures
@pytest.mark.parametrize("folder", CAPTURES, ids=lambda p: p.name)
def test_phone_capture_is_read_upright_with_matching_poses(folder):
    cap = ViroRecordingCapture(folder)
    slog = cap.session
    assert (slog.intrinsics["width"], slog.intrinsics["height"]) == (1920, 1080)  # stored landscape
    assert cap.rotation_cw == 90 and not cap.decoder_rotated
    i = cap.info.intrinsics  # turned with the pixels: fx' = fy, fy' = fx, cx' = height - cy, cy' = cx
    assert (i["width"], i["height"]) == (1080, 1920)
    assert np.allclose([i["fx"], i["fy"], i["cx"], i["cy"]],
                       [slog.intrinsics["fy"], slog.intrinsics["fx"], 1080 - slog.intrinsics["cy"], slog.intrinsics["cx"]])
    frames = list(cap.frames())
    assert len(frames) == len(slog.poses) == cap.info.num_frames  # one pose line per frame, paired by number
    assert all(fr.image.shape[:2] == (1920, 1080) and fr.T_world_from_arcam is not None for fr in frames)
    # variable frame rate; the container's frame times are the pose times
    t_pose = np.array([(p.t_ns - slog.poses[0].t_ns) / 1e9 for p in slog.poses])
    assert np.allclose([fr.timestamp for fr in frames], t_pose, atol=0.002)
    assert np.diff(t_pose).max() > 1.9 * np.diff(t_pose).min()
    # the phone was held upright: the camera's "up" is the world's up, the world is gravity-aligned
    for fr in frames:
        assert (fr.T_world_from_arcam[:3, :3] @ [0, 1, 0])[1] > 0.9


@needs_captures
@pytest.mark.parametrize("folder", CAPTURES, ids=lambda p: p.name)
def test_phone_capture_pixels_agree_with_the_poses_only_when_turned_upright(folder):
    """The main point of the format: the pose is that of the upright picture, the pixels are landscape."""
    cap = ViroRecordingCapture(folder)
    frames = list(cap.frames())
    a, b = frames[0], frames[-1]
    good, n = pose_error_px(a.image, b.image, a.T_world_from_arcam, b.T_world_from_arcam, cap.info.intrinsics)
    assert n > 200 and good < 2.0, f"upright frames should fit the poses, median error {good:.2f} px"
    for extra in (90, 180, 270):  # any other orientation of the pixels must fit clearly worse
        intr = dict(zip(("fx", "fy", "cx", "cy", "width", "height"),
                        rotate_intrinsics_cw(*(cap.info.intrinsics[k] for k in ("fx", "fy", "cx", "cy", "width", "height")), extra)))
        wrong, _ = pose_error_px(rotate_image_cw(a.image, extra), rotate_image_cw(b.image, extra),
                                     a.T_world_from_arcam, b.T_world_from_arcam, intr)
        assert wrong > 5 * good, f"turned by another {extra} deg: {wrong:.2f} px vs {good:.2f} px"


@needs_captures
@pytest.mark.parametrize("folder", CAPTURES, ids=lambda p: p.name)
def test_phone_capture_of_one_second_is_refused_at_upload(folder, tmp_path):
    code, text = recording_problem(parse_session_jsonl(folder / "session.jsonl"))
    assert code == "recording_too_short"
    c = make_server(tmp_path, builder())
    with open(folder / "video.mp4", "rb") as v, open(folder / "session.jsonl", "rb") as s:
        r = c.post("/maps/room/recording", files={"video": ("video.mp4", v, "video/mp4"),
                                                  "session_jsonl": ("session.jsonl", s, "application/x-ndjson")})
    assert r.status_code == 422 and r.headers["x-error-code"] == "recording_too_short" and r.json()["detail"] == text


@needs_captures
@pytest.mark.parametrize("folder", [c for c in CAPTURES if (c / "world_mesh.bin").exists()], ids=lambda p: p.name)
def test_phone_mesh_converted_like_the_app_does_is_read(folder, tmp_path):
    """`world_mesh.bin` (the engine's "RVWM" format) -> the PLY the app uploads -> our reader."""
    data = (folder / "world_mesh.bin").read_bytes()
    assert data[:4] == b"RVWM" and data[4] == 1
    nv, nt = struct.unpack_from("<II", data, 5)
    xyz = np.frombuffer(data, "<f4", nv * 3, 13).reshape(-1, 3)
    conf = np.frombuffer(data, "<f4", nv, 13 + nv * 12)
    tri = np.frombuffer(data, "<u4", nt * 3, 13 + nv * 16).reshape(-1, 3)
    assert 13 + nv * 16 + nt * 12 == len(data) and tri.max() < nv
    write_app_ply(tmp_path / "world_mesh.ply", xyz, conf, tri.tolist())
    verts, faces = read_ply(tmp_path / "world_mesh.ply")
    assert verts.shape == (nv, 3) and len(faces) == nt and np.allclose(verts, xyz)
    assert np.isfinite(verts).all() and np.ptp(verts, axis=0).max() < 20.0  # a room, in metres
