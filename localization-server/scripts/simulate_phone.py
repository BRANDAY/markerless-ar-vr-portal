"""A stand-in for the phone: behaves like the app does, against a running server.

It walks through the whole scenario of docs/api-v2.md with real requests, so
the server and the monitoring panel (``/ui``) can be watched "live" without a
device. Two devices, as the two modes of the app:

    staff    connect -> "scan" -> upload the recording -> wait for the build ->
             read the room plan -> place the door and save it on the server
    visitor  (another device id, never scanned) connect -> list the rooms ->
             get plan and door -> localise with short clips -> the staff's door
             appears -> inside

    uv run python scripts/simulate_phone.py                   # staff, then visitor: about 6 minutes
    uv run python scripts/simulate_phone.py --role visitor    # only a visitor (1 minute; the room must have a door)
    uv run python scripts/simulate_phone.py --role visitor --device-id sim-visitor-2 --name "Second visitor"
    uv run python scripts/simulate_phone.py --role staff --keep-map   # staff after an app restart: recognise the room, then place the door
    uv run python scripts/simulate_phone.py --door suggested  # the staff confirms the doorway the server found (if it found one)

What is real and what is not:

* The requests, the headers, the device log, the job polling and the answers
  are exactly what the app has to do (section 9 of the API document included).
* The files have the shape of the files a phone writes (app/docs/capture-format.md,
  checked on a Xiaomi 14 Ultra): H.264 frames stored in the sensor's orientation
  with a 90-degree rotation tag, intrinsics for those stored pixels, one pose
  line per frame for the camera of the *upright* picture, a variable frame rate
  (33 / 67 ms between frames), ``gravity`` zero in the first pose line.
* The pictures are a 10 s stretch of the public TUM fr1_room sequence, with the
  motion-capture ground truth in the role of the ARCore poses (made on first
  use, see ``scripts/get_test_data.ps1``). The scan itself is only waited out -
  there is no camera. The pictures are 640 x 480, not 1920 x 1080.
* Localisation is done the way the app does it: 2.5 s clips (video +
  session.jsonl) go to ``/localize``. The clips use frames of the same walk that
  are NOT in the uploaded recording, and the AR session they claim to come from
  is moved and turned against the recording session. The server has to find
  exactly that offset; the script prints how far it was off. ``--clips-from``
  takes the clips from another part of the sequence instead (a later visit).

It is NOT a test with a phone: no ARCore drift, no motion blur of a hand-held
phone, no change of light between scan and visit.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from pathlib import Path
from urllib.parse import quote

import httpx
import numpy as np

from locserver import config
from locserver import geometry as g

TERMINAL = ("succeeded", "failed", "cancelled")


class Phone:
    """The app's side of the contract: identity headers on every request and a batched device log."""

    def __init__(self, server: str, device_id: str, name: str, app_version: str, speed: float = 1.0, role: str = "staff"):
        self.server = server.rstrip("/")
        self.device_id = device_id
        self.role = role  # the app's mode: "staff" (scans, places the door) or "visitor" (only looks)
        self.session_id = f"run-{secrets.token_hex(3)}"
        self.http = httpx.Client(timeout=30, headers={
            "X-Device-Id": device_id, "X-Device-Name": quote(name), "X-Session-Id": self.session_id, "X-App-Version": app_version,
            "X-Device-Role": role,
        })
        self.name, self.app_version, self.speed = name, app_version, speed
        self.state: dict = {"step": "connecting", "tracking": "UNAVAILABLE", "map_id": None, "detail": None}
        self.pending: list[dict] = []
        self.seq = 0
        self.rtt_ms: float | None = None
        self.log_supported = True
        self.last_flush = self.last_health = 0.0

    # ---------------------------------------------------------- device log --- #
    def log(self, kind: str, message: str, level: str = "info", **data) -> None:
        self.seq += 1
        self.pending.append({"seq": self.seq, "t_ms": int(time.time() * 1000), "level": level, "type": kind, "message": message,
                             **({"data": data} if data else {})})
        self.pending = self.pending[-500:]
        print(f"  [{level:5s}] {kind:9s} {message}", flush=True)
        if level == "error" or len(self.pending) >= 20:
            self.flush()

    def set(self, step: str | None = None, **state) -> None:
        if step:
            self.state["step"] = step
        self.state.update(state)

    def flush(self) -> None:
        """Send the waiting events (or an empty batch, which keeps `state` and `rtt_ms` current)."""
        self.last_flush = time.time()
        if not self.log_supported:
            self.pending.clear()
            return
        body = {"session_id": self.session_id, "device_name": self.name, "app_version": self.app_version,
                "sent_at_ms": int(time.time() * 1000), "rtt_ms": self.rtt_ms, "state": self.state, "events": list(self.pending)}
        try:
            r = self.http.post(f"{self.server}/devices/{self.device_id}/log", json=body, timeout=3)
        except httpx.HTTPError:
            return  # keep the events, the seq numbers make the retry safe
        if r.status_code == 404:
            self.log_supported = False
        elif r.status_code == 200:
            last = r.json()["last_seq"]
            self.pending = [e for e in self.pending if e["seq"] > last]

    # ------------------------------------------------------------ requests --- #
    def health(self) -> dict:
        t = time.perf_counter()
        h = self.http.get(f"{self.server}/health", timeout=5).json()
        self.rtt_ms = round((time.perf_counter() - t) * 1000, 1)
        self.last_health = time.time()
        return h

    def idle(self, seconds: float) -> None:
        """Wait like a foreground app does: a health poll every 3 s, a log batch every 2 s."""
        end = time.time() + seconds / self.speed
        while True:
            now = time.time()
            if now - self.last_health >= 3:
                try:
                    self.health()
                except (httpx.HTTPError, ValueError) as e:  # the app keeps going and shows "server unreachable"
                    self.last_health = time.time()
                    self.log("connect", f"health poll failed: {type(e).__name__}", "warn")
            if self.pending or now - self.last_flush >= 2:
                self.flush()
            if now >= end:
                return
            time.sleep(min(0.5, max(0.05, end - now)))


def default_sequence() -> Path:
    return config.datasets_dir() / "tum_fr1_room" / "rgbd_dataset_freiburg1_room"


FRAME_STEPS = (2, 1, 2, 2, 1)  # of a 30 Hz sequence: 67 / 33 ms between frames, like the phone's recorder
CLIP_SECONDS = 2.5  # what the app records for one /localize request
SENSOR_ROTATION_CW = 90  # the phone is held upright, its sensor is not


def recording_indices(start: int, seconds: float) -> list[int]:
    out, i, k = [], start, 0
    while i < start + seconds * 30:
        out.append(i)
        i += FRAME_STEPS[k % len(FRAME_STEPS)]
        k += 1
    return out


class Sequence:
    """The TUM sequence as a source of upright pictures with poses in a y-up AR world."""

    def __init__(self, path: Path):
        from locserver.capture import TumCapture

        if not (path / "rgb.txt").exists():
            raise SystemExit(f"no TUM sequence in {path}.\nGet the public test data first:  .\\scripts\\get_test_data.ps1   (or pass --sequence)")
        self.cap = TumCapture(path)
        self.intrinsics = self.cap.info.intrinsics

    def take(self, indices: list[int]):
        """(images, poses, times in seconds from the first frame, the indices that have a pose)."""
        from locserver.recording import T_YUP_FROM_ZUP

        want, last = set(indices), max(indices)
        images, poses, times, used = [], [], [], []
        for fr in self.cap.frames():
            if fr.index in want and fr.T_world_from_arcam is not None:
                images.append(fr.image)
                poses.append(T_YUP_FROM_ZUP @ fr.T_world_from_arcam)  # an AR world has y up, the TUM world z
                times.append(float(self.cap.rgb[fr.index][0]))
                used.append(fr.index)
            if fr.index > last:
                break
        return images, poses, [t - times[0] for t in times], used


def write_phone_files(folder: Path, images, poses, times, intrinsics) -> None:
    from locserver.recording import write_recording

    write_recording(folder, images, poses, intrinsics, rotation_cw=SENSOR_ROTATION_CW, times_s=times)


def ensure_recording(folder: Path, sequence: Path, start: int, seconds: float) -> dict:
    """Make ``video.mp4`` + ``session.jsonl`` in the phone's format unless the folder already has them."""
    info_file = folder / "expected.json"
    shape = ["phone-v1", start, seconds]
    if (folder / "video.mp4").exists() and (folder / "session.jsonl").exists() and info_file.exists():
        info = json.loads(info_file.read_text(encoding="utf-8"))
        if info.get("shape") == shape:
            return info
    seq = Sequence(sequence)
    images, poses, times, used = seq.take(recording_indices(start, seconds))
    if len(images) < 30:
        raise SystemExit("the sequence has too few frames with ground truth in that range")
    write_phone_files(folder, images, poses, times, seq.intrinsics)
    info = {"frames": used, "sequence": str(sequence), "shape": shape, "seconds": round(times[-1], 2),
            "expected_T_arworld_from_map": np.eye(4).tolist()}
    info_file.write_text(json.dumps(info), encoding="utf-8")
    return info


def clip_plans(info: dict, count: int, clips_from: int | None) -> list[list[int]]:
    """Frame numbers of the /localize clips: 2.5 s each, none of the frames is in the uploaded recording."""
    used = set(info["frames"])
    n = int(CLIP_SECONDS * 30)
    if clips_from is not None:  # another part of the sequence: every frame is new, keep the phone's rhythm
        return [[i for i in recording_indices(clips_from + k * (n + 15), CLIP_SECONDS)] for k in range(count)]
    first, last = min(used), max(used)
    starts = np.linspace(first, max(first, last - n), count).round().astype(int)
    return [[i for i in range(int(a), int(a) + n) if i not in used] for a in starts]


def describe_room(room: dict, portal: dict) -> str:
    if room.get("status") == "unavailable":
        return f"no room plan ({room.get('reason') or 'not computed'})"
    walls = ", ".join(f"{w['id']} {w['width']:.1f} m" for w in room["walls"]) or "none"
    openings = ", ".join(f"{o['id']} on {o['wall_id']} ({o['state']}, {o['confidence']:.2f})" for o in room["openings"]) or "none"
    return f"walls: {walls}; corners: {len(room['corners'])}; openings: {openings}; portal source: {portal.get('source')}"


def connect(phone: Phone) -> dict | None:
    phone.log("app", f"app started in {phone.role} mode (simulator, no camera)")
    phone.log("connect", f"looking for the server at {phone.server}")
    try:
        h = phone.health()
    except (httpx.HTTPError, ValueError) as e:
        print(f"the server does not answer: {e}\nStart it first:  uv run locserver-serve")
        return None
    caps = h.get("capabilities") or []
    if "staff_door" not in caps:
        print("this server does not announce 'staff_door' (older code): update and restart it")
        return None
    phone.set("connected", detail=f"server {h.get('server_name')} {h.get('version')}")
    phone.log("connect", f"connected to {h.get('server_name')} {h.get('version')} ({h.get('device_name')}), round trip {phone.rtt_ms:.0f} ms",
              capabilities=caps)
    phone.idle(2)
    return h


def door_in_front(T_cam: np.ndarray, floor: float | None, ahead: float = 1.5) -> tuple[list[float], float]:
    """Where a person standing at ``T_cam`` puts the door: on the floor ``ahead`` metres in front, facing them."""
    fwd = -T_cam[:3, 2] * [1, 0, 1]
    fwd /= max(np.linalg.norm(fwd), 1e-9)
    pos = T_cam[:3, 3] + ahead * fwd
    pos[1] = floor if floor is not None else T_cam[1, 3] - 1.4
    return pos.tolist(), float(np.degrees(np.arctan2(-fwd[0], -fwd[2])))  # the door's +Z points into the room, at the person


def send_clip(phone: Phone, map_id: str, session: str, clip_dir: Path) -> tuple[dict | None, float]:
    t = time.perf_counter()
    with open(clip_dir / "video.mp4", "rb") as v, open(clip_dir / "session.jsonl", "rb") as sj:
        r = phone.http.post(f"{phone.server}/localize", timeout=120,
                            files={"video": ("video.mp4", v, "video/mp4"), "session_jsonl": ("session.jsonl", sj, "application/x-ndjson")},
                            data={"map_id": map_id, "session_id": session, "device_id": phone.device_id, "include_room": "true"})
    ms = (time.perf_counter() - t) * 1000
    if r.status_code != 200:
        phone.log("localize", f"request failed {r.status_code} {r.text[:160]}", "error")
        return None, ms
    return r.json(), ms


def staff(phone: Phone, a, folder: Path, info: dict, T_last: np.ndarray, clips: list, S: np.ndarray) -> bool:
    """Staff mode: scan the room, wait for the map, place the door once and save it on the server."""
    h = connect(phone)
    if h is None:
        return False
    ar_session = f"{phone.session_id}-ar0"  # one id per AR session: the recording, /localize and the door use the same one
    same_session = True
    if a.map_id in (h.get("maps") or []) and a.keep_map:
        phone.log("app", f"room {a.map_id!r} is already on the server - scan skipped")
        phone.set(tracking="NORMAL")
        same_session = False  # this run's AR session did not record the room
    else:
        # ---- scan ------------------------------------------------------- #
        size_mb = (folder / "video.mp4").stat().st_size / 2**20
        phone.log("tracking", "tracking LIMITED (INITIALIZING)")
        phone.set("scanning", tracking="LIMITED", detail="move the phone to start tracking")
        phone.idle(1.5)
        phone.set(tracking="NORMAL", detail="recording 00:00")
        phone.log("tracking", "tracking NORMAL")
        phone.log("scan", "recording started", map_id=a.map_id)
        t_scan = time.time()
        while (elapsed := (time.time() - t_scan) * a.speed) < a.scan_seconds:
            phone.set(detail=f"recording {int(elapsed) // 60:02d}:{int(elapsed) % 60:02d}")
            phone.idle(1)
        phone.log("scan", f"recording stopped: {len(info['frames'])} frames, {info['seconds']} s, {size_mb:.1f} MB")

        # ---- upload ----------------------------------------------------- #
        phone.set("uploading", detail=f"sending {size_mb:.1f} MB")
        phone.log("upload", f"upload started ({size_mb:.1f} MB)")
        phone.flush()
        t0 = time.time()
        with open(folder / "video.mp4", "rb") as v, open(folder / "session.jsonl", "rb") as s:
            r = phone.http.post(f"{phone.server}/maps/{a.map_id}/recording", timeout=600,
                                files={"video": ("video.mp4", v, "video/mp4"), "session_jsonl": ("session.jsonl", s, "application/x-ndjson")},
                                data={"replace": "true", "device_id": phone.device_id, "label": a.label, "session_id": ar_session})
        if r.status_code != 202:
            phone.set("error", detail=f"upload refused: {r.status_code}")
            phone.log("upload", f"upload refused: {r.status_code} {r.text[:200]}", "error")
            return False
        job = r.json()["job"]
        phone.log("upload", f"upload finished in {time.time() - t0:.1f} s, job {job['job_id']}")

        # ---- build ------------------------------------------------------ #
        phone.set("building", detail="waiting for the map")
        last = None
        while job["state"] not in TERMINAL:
            phone.idle(1)
            job = phone.http.get(f"{phone.server}/jobs/{job['job_id']}").json()
            if (job["state"], job["stage"]) != last:
                last = (job["state"], job["stage"])
                phone.log("job", f"build {job['state']}: step {job['stage_index']}/{job['stage_count']} {job['stage'] or '-'} "
                                 f"({job['progress'] * 100:.0f} %)")
            phone.set(detail=f"{job['stage'] or job['state']} {job['progress'] * 100:.0f} %")
        if job["state"] != "succeeded":
            err = job.get("error") or {}
            phone.set("error", detail=err.get("message") or f"build {job['state']}")
            phone.log("job", f"build {job['state']}: {err.get('code')}: {err.get('message')}", "error")
            phone.idle(2)
            return False
        res = job["result"]
        phone.log("job", f"map built in {job['elapsed_s']:.0f} s: {res.get('num_images')} images", warnings=res.get("warnings") or [])

    # ---- room plan, and what the server suggests for the door ------------- #
    room = phone.http.get(f"{phone.server}/maps/{a.map_id}/room").json()["room"]
    portal = phone.http.get(f"{phone.server}/maps/{a.map_id}/portal").json()
    phone.set("ready", detail="map ready - place the door")
    phone.log("app", "room plan received: " + describe_room(room, portal))
    hint = portal.get("suggested")
    if hint:
        phone.log("portal", f"the server suggests a doorway: {hint['opening_id']}, {hint['width']:.2f} x {hint['height']:.2f} m, "
                            f"confidence {hint['confidence']:.2f}")
    if portal.get("source") == "manual" and not same_session:
        phone.log("portal", f"this room already has a door placed by {portal.get('placed_by') or 'the staff'} - left as it is")
        phone.set("portal_placed", detail="door already saved")
        phone.flush()
        return True
    phone.idle(3)  # the staff member walks to the place of the door and adjusts it

    # ---- the door: placed once by the staff, saved on the server ----------- #
    floor = (room.get("floor") or {}).get("level")
    r = None
    if a.door == "suggested" and hint:
        r = phone.http.put(f"{phone.server}/maps/{a.map_id}/portal", json={"opening_id": hint["opening_id"]})
        how, saved = "the doorway the server suggested", {"alignment_used": "accepted suggestion"}
    else:
        T_ar = T_last  # the staff's AR world of the recording is the map
        if not same_session:
            # another AR session (the app was restarted): the room has to be recognised first
            session_T = S
            phone.set("localizing", detail="recognising the room before the door can be placed")
            out, ms = send_clip(phone, a.map_id, ar_session, clips[0][0]) if clips else (None, 0.0)
            al = (out or {}).get("alignment") or {}
            if al.get("status") != "ok":
                phone.set("error", detail="the room was not recognised")
                phone.log("portal", "the room was not recognised in this session - the door cannot be placed", "error")
                return False
            phone.log("localize", f"room recognised in {ms:.0f} ms ({out['num_inliers']} inliers) - the door can be placed")
            T_ar = session_T @ T_last
            seen_floor = ((al.get("room") or {}).get("floor") or {}).get("level")  # the floor in this session's AR world
            floor = seen_floor if seen_floor is not None else None if floor is None else floor + S[1, 3]
        pos, yaw_deg = door_in_front(T_ar, floor)
        body = {"ar_pose": {"position": pos, "rotation": [0, yaw_deg, 0]}, "session_id": ar_session, "width": a.door_size[0],
                "height": a.door_size[1], "note": "placed by the staff in the simulator"}
        how = "1.5 m in front of the staff member, on the floor"
        r = phone.http.put(f"{phone.server}/maps/{a.map_id}/anchors/portal", json=body)
        saved = r.json() if r.status_code == 200 else {}
    if r.status_code != 200:
        phone.set("error", detail=f"the door was not saved: {r.status_code}")
        phone.log("portal", f"saving the door failed: {r.status_code} {r.text[:200]}", "error")
        return False
    door = saved.get("portal") or r.json()
    phone.log("portal", f"door saved on the server ({door['source']}): {how}; {door['width']:.2f} x {door['height']:.2f} m; "
                        f"alignment used: {saved['alignment_used']}", position=door["position"], alignment_used=saved["alignment_used"])
    phone.set("portal_placed", detail=f"door saved ({saved['alignment_used']})")
    phone.idle(3)
    phone.log("app", "staff part finished")
    phone.flush()
    return True


def visitor(phone: Phone, a, clips: list, S: np.ndarray, what: str) -> tuple[bool, dict]:
    """Visitor mode: nothing but the app - rooms, plan and door come from the server, the phone only looks around."""
    verdict: dict = {"alignment": "none"}
    if connect(phone) is None:
        return False, verdict
    rooms = phone.http.get(f"{phone.server}/maps").json()["maps"]
    ready = [m for m in rooms if m.get("portal_confirmed")]
    phone.log("app", f"{len(rooms)} room(s) on the server, {len(ready)} with a door placed by the staff: "
                     + (", ".join(f"{m.get('label') or m['map_id']}" for m in ready) or "none"))
    room_info = next((m for m in rooms if m["map_id"] == a.map_id), None)
    if room_info is None or not room_info.get("portal_confirmed"):
        phone.set("error", detail="no door for this room - ask a staff member")
        phone.log("portal", f"room {a.map_id!r} has no door placed by the staff - a visitor cannot go on", "error")
        phone.flush()
        return False, verdict
    phone.set(map_id=a.map_id)
    room = phone.http.get(f"{phone.server}/maps/{a.map_id}/room").json()["room"]
    portal = phone.http.get(f"{phone.server}/maps/{a.map_id}/portal").json()
    phone.set("ready", detail=f"room {room_info.get('label') or a.map_id}")
    phone.log("app", f"room {room_info.get('label') or a.map_id!r}: " + describe_room(room, portal)
              + (f"; door {portal['width']:.2f} x {portal['height']:.2f} m" if portal.get("width") else ""))
    phone.idle(2)

    print(f"  visitor: localising with {len(clips)} clips of {CLIP_SECONDS} s: {what}; this AR session is turned and moved against "
          f"the scan (yaw_deg,tx,ty,tz = {a.session_transform})")
    phone.set("localizing", tracking="NORMAL", detail="looking for the room")
    phone.log("localize", "localisation started (new AR session, this device never scanned)")
    visit = f"{phone.session_id}-ar0"
    alignment, placed, last_T, door = None, False, None, None
    for i, (clip_dir, T_ar, used) in enumerate(clips):
        last_T = T_ar
        out, ms = send_clip(phone, a.map_id, visit, clip_dir)
        if out is None:
            phone.idle(a.localize_interval)
            continue
        al = out.get("alignment") or {}
        if out["success"]:
            phone.log("localize", f"clip {i + 1}: {out['quality']}, {out['num_inliers']} inliers, {ms:.0f} ms; alignment {al.get('status')}"
                                  f" from {al.get('observations_used')} of {al.get('observations_total')} frames")
        else:
            phone.log("localize", f"clip {i + 1}: not localised ({out.get('reason')}), {ms:.0f} ms", "warn")
        if al.get("status") == "ok":
            alignment, door = al, al.get("portal") or {}
            if not placed and (al.get("observations_used") or 0) >= 2 and door.get("confirmed"):
                placed = True
                phone.set("portal_placed", detail=f"door from the server ({door.get('source')})")
                phone.log("portal", f"alignment accepted (position rms {(al.get('position_rms_m') or 0) * 100:.1f} cm) - the staff's door is shown "
                                    f"in AR, {door['width']:.2f} x {door['height']:.2f} m")
        phone.idle(a.localize_interval)

    # how far is the alignment from the offset this script applied, and where does the door end up?
    if alignment and alignment.get("T_arworld_from_map"):
        M = np.array(alignment["T_arworld_from_map"])
        scale = float(alignment["scale"])
        cam = np.linalg.inv(S)[:3, :3] @ last_T[:3, 3] + np.linalg.inv(S)[:3, 3]  # last camera, map coordinates
        verdict = {
            "alignment": alignment["status"], "scale": round(scale, 4),
            "rotation_error_deg": round(float(g.rotation_angle_deg(M[:3, :3] / scale, S[:3, :3])), 3),
            "position_error_at_camera_m": round(float(np.linalg.norm((M[:3, :3] @ cam + M[:3, 3]) - last_T[:3, 3])), 4),
            "observations_used": alignment.get("observations_used"),
        }
        if door and door.get("position") and portal.get("position"):
            true_door = S[:3, :3] @ np.array(portal["position"]) + S[:3, 3]  # where the staff's door really is in this AR world
            verdict["door_position_error_m"] = round(float(np.linalg.norm(np.array(door["position"]) - true_door)), 4)
            verdict["door_size_m"] = [door.get("width"), door.get("height")]
        phone.log("localize", f"alignment against the known offset: {verdict['rotation_error_deg']} deg, "
                              f"{verdict['position_error_at_camera_m'] * 100:.1f} cm at the camera"
                              + (f"; the door stands {verdict['door_position_error_m'] * 100:.1f} cm from where the staff put it"
                                 if "door_position_error_m" in verdict else ""), **verdict)
    else:
        phone.set("error", detail="no alignment - the room was not recognised")
        phone.log("localize", "no accepted alignment after all clips", "error")

    if placed:
        phone.idle(3)
        phone.set("inside", detail="in the virtual room")
        phone.log("portal", "the visitor walked through the door")
        phone.idle(a.stay)
        phone.log("portal", "the visitor came back out")
        phone.set("portal_placed", detail="back in the real room")
    phone.log("app", "visitor part finished")
    phone.flush()
    return placed, verdict


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default=f"http://127.0.0.1:{config.port()}")
    ap.add_argument("--role", choices=["both", "staff", "visitor"], default="both",
                    help="staff: scan, build, place the door; visitor: get room + door, localise; both: one after the other, as two devices")
    ap.add_argument("--device-id", default=None, help="device id (default: sim-staff-1 / sim-visitor-1)")
    ap.add_argument("--name", default=None, help="device name (default: Staff phone / Visitor phone)")
    ap.add_argument("--map-id", default="sim_room")
    ap.add_argument("--label", default="Simulated room (TUM fr1_room)", help="the room's name as the staff typed it")
    ap.add_argument("--recording", default=None, help="folder with video.mp4 + session.jsonl (default: <work>/sim_recording, made from TUM)")
    ap.add_argument("--sequence", default=None, help="TUM sequence folder (default: <datasets>/tum_fr1_room/rgbd_dataset_freiburg1_room)")
    ap.add_argument("--start", type=int, default=101, help="first TUM frame of the simulated scan")
    ap.add_argument("--seconds", type=float, default=10.0, help="length of the simulated recording")
    ap.add_argument("--keep-map", action="store_true", help="if the room already exists on the server, skip scan + upload + build")
    ap.add_argument("--door", choices=["pose", "suggested"], default="pose",
                    help="pose: the staff places the door in front of them; suggested: confirm the doorway the server found (if any)")
    ap.add_argument("--door-size", default="0.9,2.0", help="width,height of the door the staff sets, metres")
    ap.add_argument("--localize-count", type=int, default=6, help="number of 2.5 s clips sent to /localize")
    ap.add_argument("--localize-interval", type=float, default=1.0, help="pause between /localize requests, seconds")
    ap.add_argument("--clips-from", type=int, default=None,
                    help="take the /localize clips from this TUM frame on (default: the scanned stretch, frames not in the recording)")
    ap.add_argument("--session-transform", default="35,0.8,0.25,-1.2", help="yaw_deg,tx,ty,tz of the visiting AR session against the scan")
    ap.add_argument("--scan-seconds", type=float, default=10.0, help="how long the simulated scan takes")
    ap.add_argument("--stay", type=float, default=20.0, help="stay 'inside' this long at the end, seconds")
    ap.add_argument("--speed", type=float, default=1.0, help="2 = all simulated waiting twice as fast")
    a = ap.parse_args()
    a.door_size = [float(v) for v in a.door_size.split(",")]

    sequence = Path(a.sequence) if a.sequence else default_sequence()
    folder = Path(a.recording) if a.recording else config.work_dir() / "sim_recording"
    yaw, tx, ty, tz = (float(v) for v in a.session_transform.split(","))
    S = g.make_T(g.rot_y(np.radians(yaw)), [tx, ty, tz])  # visiting AR world <- scan AR world (= map)

    # before connecting, because it takes a while: the recording (first run only) and the clips for /localize
    info = ensure_recording(folder, sequence, a.start, a.seconds)
    print(f"recording: {len(info['frames'])} frames, {info['seconds']} s, in {folder}")
    seq = Sequence(sequence)
    T_last = seq.take([info["frames"][-1]])[1][0]  # where the staff member stands when the recording ends
    clips = []
    for k, plan in enumerate(clip_plans(info, a.localize_count, a.clips_from)):
        images, poses, times, used = seq.take(plan)
        if len(images) >= 5:
            clip_dir = folder / "clips" / f"clip{k}"
            write_phone_files(clip_dir, images, [S @ T for T in poses], times, seq.intrinsics)
            clips.append((clip_dir, S @ poses[-1], used))
    what = "frames of the same walk that are not in the recording" if a.clips_from is None else f"a later part of the sequence (from frame {a.clips_from})"

    ok, verdict = True, {}
    if a.role in ("both", "staff"):
        phone = Phone(a.server, a.device_id if a.device_id and a.role == "staff" else "sim-staff-1",
                      a.name if a.name and a.role == "staff" else "Staff phone", "simulator 1.1", a.speed, role="staff")
        phone.set(map_id=a.map_id)
        print(f"staff device {phone.device_id!r} ({phone.name}), session {phone.session_id}, server {phone.server}")
        ok = staff(phone, a, folder, info, T_last, clips, S)
    if ok and a.role in ("both", "visitor"):
        phone = Phone(a.server, a.device_id if a.device_id and a.role == "visitor" else "sim-visitor-1",
                      a.name if a.name and a.role == "visitor" else "Visitor phone", "simulator 1.1", a.speed, role="visitor")
        print(f"visitor device {phone.device_id!r} ({phone.name}), session {phone.session_id}, server {phone.server}")
        ok, verdict = visitor(phone, a, clips, S, what)
        print(json.dumps(verdict, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
