"""FastAPI server. Start with ``uv run locserver-serve`` (see README)."""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import tempfile
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile

from . import __version__, config
from . import geometry as g
from .capture import Frame, VideoCapture, rotate_image_cw, rotate_intrinsics_cw, sharpness
from .features import EXTRACTOR_NAME, MATCHER_NAME, FeaturePipeline
from .localize import DeviceCalibrationStore, LocalizeOptions, Localizer
from .mapstore import LocMap, check_id, list_map_dirs, load_map
from .responses import (
    AlignOptions,
    Observation,
    anchor_pose_dict,
    compute_alignment,
    localization_dict,
    mat,
    parse_ar_pose,
    strip_private,
)

log = logging.getLogger("locserver.server")

MAX_IMAGE_BYTES = 25 * 2**20
MAX_VIDEO_BYTES = 150 * 2**20
SESSION_TTL_S = 30 * 60
SESSION_MAX_OBS = 60


class State:
    def __init__(self, maps_dir: Path, device: str = "auto", max_keypoints: int = 2048, pipe=None, localizer=None,
                 calibration_dir: Path | None = None):
        """``pipe`` / ``localizer`` can be injected (the API tests use stubs without models)."""
        self.maps_dir = Path(maps_dir)
        self.pipe = pipe or FeaturePipeline(device, max_keypoints=max_keypoints)
        self.loc_opts = LocalizeOptions()
        self.align_opts = AlignOptions()
        self.calib = DeviceCalibrationStore(calibration_dir or config.calibration_dir())
        self.localizer = localizer or Localizer(self.pipe, self.calib, self.loc_opts)
        self.maps: dict[str, LocMap] = {}
        self.sessions: dict[str, dict] = {}
        self.gpu_lock = threading.Lock()  # one inference at a time (4 GB VRAM)
        self.started = time.time()
        self.reload()

    def reload(self) -> list[str]:
        maps = {}
        for d in list_map_dirs(self.maps_dir):
            try:
                m = load_map(d)
                maps[m.map_id] = m
            except Exception as e:
                log.error("cannot load map %s: %s", d, e)
        self.maps = maps
        return sorted(maps)

    def get_map(self, map_id: str | None) -> LocMap:
        if not map_id:
            if len(self.maps) == 1:
                return next(iter(self.maps.values()))
            raise HTTPException(422, f"map_id is required (loaded maps: {sorted(self.maps)})")
        if map_id not in self.maps:
            raise HTTPException(404, f"unknown map {map_id!r} (loaded maps: {sorted(self.maps)})")
        return self.maps[map_id]

    def session(self, session_id: str, map_id: str) -> dict:
        now = time.time()
        for k in [k for k, s in self.sessions.items() if now - s["used"] > SESSION_TTL_S]:
            del self.sessions[k]
        s = self.sessions.get(session_id)
        if s is None or s["map_id"] != map_id:
            s = self.sessions[session_id] = {"map_id": map_id, "observations": [], "created": now}
        s["used"] = now
        return s


def _floats(text: str | None, n: int, name: str) -> list[float] | None:
    if text is None or text == "":
        return None
    try:
        v = json.loads(text) if text.strip().startswith("[") else [float(x) for x in text.replace(";", ",").split(",")]
        v = [float(x) for x in v]
    except (ValueError, TypeError):
        raise HTTPException(422, f"{name}: expected {n} numbers")
    if len(v) != n:
        raise HTTPException(422, f"{name}: expected {n} numbers, got {len(v)}")
    return v


def _sim3_from_matrix(M) -> g.Sim3:
    M = np.asarray(M, dtype=float)
    if M.shape != (4, 4):
        raise ValueError("T_arworld_from_map must be 4x4")
    s = float(np.cbrt(np.linalg.det(M[:3, :3])))
    if not np.isfinite(s) or s <= 0:
        raise ValueError("T_arworld_from_map is not a similarity transform")
    return g.Sim3(s, g.project_to_rotation(M[:3, :3] / s), M[:3, 3])


def _anchor_json(lmap: LocMap, name: str) -> dict:
    a = lmap.anchors().get(name)
    if a is None:
        raise HTTPException(404, f"map {lmap.map_id!r} has no anchor {name!r}")
    return {"map_id": lmap.map_id, "name": name, "frame": "map", **a}


def pick_clip_frames(frames: list[Frame], n: int) -> list[Frame]:
    """The sharpest frame of each of ``n`` equal parts of a clip."""
    if len(frames) <= n:
        return frames
    out = []
    for part in np.array_split(np.arange(len(frames)), n):
        out.append(frames[int(max(part, key=lambda i: sharpness(frames[i].image)))])
    return out


def create_app(state: State | None = None, maps_dir: Path | None = None, device: str = "auto") -> FastAPI:
    app = FastAPI(title="locserver", version=__version__, description="Markerless visual localisation for an AR portal")
    st = state or State(maps_dir or config.maps_dir(), device)
    app.state.locserver = st

    # ------------------------------------------------------------- info --- #
    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "version": __version__,
            "device": st.pipe.device,
            "device_name": st.pipe.device_name,
            "vram_mb": st.pipe.vram_mb(),
            "models": {"extractor": EXTRACTOR_NAME, "matcher": MATCHER_NAME, "max_keypoints": st.pipe.max_keypoints},
            "maps": sorted(st.maps),
            "maps_dir": str(st.maps_dir),
            "sessions": len(st.sessions),
            "uptime_s": round(time.time() - st.started, 1),
        }

    @app.get("/maps")
    def maps():
        return {"maps": [m.summary() for m in st.maps.values()]}

    @app.post("/maps/reload")
    def maps_reload():
        return {"maps": st.reload()}

    @app.get("/maps/{map_id}")
    def map_info(map_id: str):
        m = st.get_map(map_id)
        return {**m.meta, "num_images": len(m.images), "anchors": m.anchors()}

    @app.put("/maps/{map_id}/scale")
    def map_scale(map_id: str, body: dict = Body(...)):
        m = st.get_map(map_id)
        try:
            m.set_scale(float(body["scale_m_per_unit"]), str(body.get("source", "manual")))
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(422, str(e))
        return m.summary()

    # ---------------------------------------------------------- anchors --- #
    @app.get("/maps/{map_id}/anchors")
    def anchors(map_id: str):
        return {"map_id": map_id, "frame": "map", "anchors": st.get_map(map_id).anchors()}

    @app.get("/maps/{map_id}/anchors/{name}")
    def anchor_get(map_id: str, name: str):
        return _anchor_json(st.get_map(map_id), name)

    @app.put("/maps/{map_id}/anchors/{name}")
    def anchor_put(map_id: str, name: str, body: dict = Body(...)):
        """Store a named pose. Either in map coordinates::

            {"position": [x, y, z], "quaternion_xyzw": [..]}        (or "rotation_euler_deg")

        or as seen in a running AR session, together with that session's alignment::

            {"ar_pose": {"position": [..], "rotation": [ex, ey, ez]},
             "T_arworld_from_map": [[4x4]]}                         (or "session_id": "...")
        """
        m = st.get_map(map_id)
        try:
            check_id(name, "anchor name")
            if "ar_pose" in body:
                ap = body["ar_pose"]
                R = (
                    g.quat_to_rotmat(ap["quaternion_xyzw"])
                    if "quaternion_xyzw" in ap
                    else g.viro_euler_to_rotmat(ap.get("rotation", ap.get("rotation_euler_deg", [0, 0, 0])))
                )
                T_ar_from_anchor = g.make_T(R, ap["position"])
                if "T_arworld_from_map" in body:
                    sim = _sim3_from_matrix(body["T_arworld_from_map"])
                elif "session_id" in body:
                    s = st.sessions.get(str(body["session_id"]))
                    if not s or s["map_id"] != m.map_id or not s["observations"]:
                        raise ValueError("unknown session_id or session without observations for this map")
                    sim = compute_alignment(m, s["observations"], st.align_opts).get("_sim3")
                    if sim is None:
                        raise ValueError("the session has no complete alignment yet (scale unknown)")
                else:
                    raise ValueError("ar_pose needs T_arworld_from_map or session_id")
                T = sim.inverse().transform_pose(T_ar_from_anchor)
            else:
                R = (
                    g.quat_to_rotmat(body["quaternion_xyzw"])
                    if "quaternion_xyzw" in body
                    else g.viro_euler_to_rotmat(body.get("rotation_euler_deg", [0, 0, 0]))
                )
                T = g.make_T(R, body["position"])
            if not np.isfinite(T).all():
                raise ValueError("pose contains non-finite numbers")
            m.set_anchor(name, T, body.get("note"))
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(422, f"bad anchor: {e}")
        return _anchor_json(m, name)

    @app.delete("/maps/{map_id}/anchors/{name}")
    def anchor_delete(map_id: str, name: str):
        if not st.get_map(map_id).delete_anchor(name):
            raise HTTPException(404, f"no anchor {name!r}")
        return {"deleted": name}

    # ------------------------------------------------------ calibration --- #
    @app.get("/calibration")
    def calibration():
        return {"devices": st.calib.all(), "min_samples": st.calib.min_samples, "max_rel_spread": st.calib.max_rel_spread}

    @app.delete("/calibration/{device_id}")
    def calibration_delete(device_id: str):
        try:
            ok = st.calib.delete(device_id)
        except ValueError as e:
            raise HTTPException(422, str(e))
        if not ok:
            raise HTTPException(404, "unknown device_id")
        return {"deleted": device_id}

    # --------------------------------------------------------- sessions --- #
    @app.get("/sessions/{session_id}")
    def session_get(session_id: str):
        s = st.sessions.get(session_id)
        if not s:
            raise HTTPException(404, "unknown session")
        m = st.get_map(s["map_id"])
        return {
            "session_id": session_id,
            "map_id": s["map_id"],
            "num_observations": len(s["observations"]),
            "alignment": strip_private(compute_alignment(m, s["observations"], st.align_opts)),
        }

    @app.delete("/sessions/{session_id}")
    def session_delete(session_id: str):
        if st.sessions.pop(session_id, None) is None:
            raise HTTPException(404, "unknown session")
        return {"deleted": session_id}

    # ------------------------------------------------------------ align --- #
    @app.post("/align")
    def align(body: dict = Body(...)):
        """Stateless alignment of N observations of one AR session.

        Body: ``{"map_id": "...", "observations": [{"T_cvcam_from_map": [[4x4]],
        "ar_pose": {"position": [..], "rotation": [..]}, "weight": 1.0}, ...]}``.
        ``T_cvcam_from_map`` is ``pose.T_cvcam_from_map`` of a /localize response.
        """
        m = st.get_map(body.get("map_id"))
        try:
            obs = []
            for o in body["observations"]:
                T = np.asarray(o["T_cvcam_from_map"], dtype=float)
                if T.shape != (4, 4):
                    raise ValueError("T_cvcam_from_map must be 4x4")
                obs.append(Observation(T, parse_ar_pose(o["ar_pose"]), float(o.get("weight", 1.0))))
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(422, f"bad observations: {e}")
        al = compute_alignment(m, obs, st.align_opts)
        _maybe_persist_scale(m, al, bool(body.get("persist_scale")))
        return {"map_id": m.map_id, "alignment": strip_private(al)}

    def _maybe_persist_scale(m: LocMap, al: dict, persist: bool) -> None:
        al["scale_persisted"] = False
        if persist and al.get("scale_source") == "estimated_from_session" and al.get("scale_reliable"):
            m.set_scale(float(al["scale"]), "ar_session")
            al["scale_persisted"] = True

    # --------------------------------------------------------- localize --- #
    @app.post("/localize")
    def localize(
        image: UploadFile | None = File(None, description="JPEG/PNG camera image"),
        video: UploadFile | None = File(None, description="short clip; the sharpest frames are used"),
        session_jsonl: UploadFile | None = File(None, description="ViroReact session.jsonl belonging to `video`"),
        map_id: str | None = Form(None),
        fx: float | None = Form(None),
        fy: float | None = Form(None),
        cx: float | None = Form(None),
        cy: float | None = Form(None),
        width: int | None = Form(None),
        height: int | None = Form(None),
        intrinsics_mode: str = Form("auto", description="auto | map (same camera and zoom as the mapping capture)"),
        device_id: str | None = Form(None),
        image_rotation_cw: int | None = Form(None, description="rotate the upload clockwise by 0/90/180/270 to make it upright"),
        ar_pose: str | None = Form(None, description='JSON {"position":[..],"rotation":[..]} (ViroReact camera transform)'),
        ar_position: str | None = Form(None),
        ar_rotation: str | None = Form(None),
        ar_forward: str | None = Form(None),
        ar_up: str | None = Form(None),
        session_id: str | None = Form(None),
        max_frames: int = Form(3),
        persist_scale: bool = Form(False),
    ):
        t_req = time.perf_counter()
        m = st.get_map(map_id)
        if (image is None) == (video is None):
            raise HTTPException(422, "send exactly one of the files `image` or `video`")
        if intrinsics_mode not in ("auto", "map"):
            raise HTTPException(422, "intrinsics_mode must be 'auto' or 'map'")
        rot = (image_rotation_cw or 0) % 360
        if rot % 90:
            raise HTTPException(422, "image_rotation_cw must be 0, 90, 180 or 270")
        try:
            if device_id:
                check_id(device_id, "device_id")
            if session_id:
                check_id(session_id, "session_id")
        except ValueError as e:
            raise HTTPException(422, str(e))

        # AR pose of the request (single image, or a clip taken while standing still)
        T_ar_req = None
        try:
            if ar_pose:
                T_ar_req = parse_ar_pose(json.loads(ar_pose))
            elif ar_position:
                T_ar_req = parse_ar_pose({
                    "position": _floats(ar_position, 3, "ar_position"),
                    "rotation": _floats(ar_rotation, 3, "ar_rotation"),
                    "forward": _floats(ar_forward, 3, "ar_forward"),
                    "up": _floats(ar_up, 3, "ar_up"),
                })
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            raise HTTPException(422, f"bad AR pose: {e}")

        intr = None
        given = [v is not None for v in (fx, fy, cx, cy)]
        if any(given):
            if not all(given):
                raise HTTPException(422, "intrinsics need all of fx, fy, cx, cy")
            intr = dict(fx=fx, fy=fy, cx=cx, cy=cy, width=width, height=height)

        # ---- decode the upload into upright frames (+ per-frame AR poses) ---- #
        frames: list[Frame] = []
        pairing = None
        if image is not None:
            data = image.file.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(413, "image too large")
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                raise HTTPException(422, "cannot decode `image` (send JPEG or PNG)")
            if intr:
                intr["width"], intr["height"] = intr["width"] or img.shape[1], intr["height"] or img.shape[0]
                f = rotate_intrinsics_cw(intr["fx"], intr["fy"], intr["cx"], intr["cy"], intr["width"], intr["height"], rot)
                intr = dict(zip(("fx", "fy", "cx", "cy", "width", "height"), f))
            frames = [Frame(0, rotate_image_cw(img, rot), None, T_ar_req)]
            pairing = "request" if T_ar_req is not None else None
        else:
            tmp = Path(tempfile.mkdtemp(prefix="clip_", dir=str(_tmp_root())))
            try:
                vpath = tmp / "video.mp4"
                with open(vpath, "wb") as fh:
                    shutil.copyfileobj(video.file, fh, 2**20)
                if vpath.stat().st_size > MAX_VIDEO_BYTES:
                    raise HTTPException(413, "video too large")
                try:
                    if session_jsonl is not None:
                        from .recording import ViroRecordingCapture

                        with open(tmp / "session.jsonl", "wb") as fh:
                            shutil.copyfileobj(session_jsonl.file, fh, 2**20)
                        cap = ViroRecordingCapture(tmp, display_rotation_cw=image_rotation_cw)
                        intr = intr or cap.info.intrinsics
                        pairing = "session_jsonl"
                        decoded = list(cap.frames(step=max(1, (cap.info.num_frames or 1) // 60)))
                    else:
                        cap = VideoCapture(vpath)
                        decoded = [
                            Frame(f.index, rotate_image_cw(f.image, rot), f.timestamp)
                            for f in cap.frames(step=max(1, (cap.info.num_frames or 1) // 60))
                        ]
                        if intr and rot:
                            raise HTTPException(422, "intrinsics with image_rotation_cw are only supported for `image`")
                except (IOError, ValueError) as e:
                    raise HTTPException(422, f"cannot read the clip: {e}")
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            if not decoded:
                raise HTTPException(422, "the clip contains no decodable frames")
            frames = pick_clip_frames(decoded, max(1, min(int(max_frames), 8)))
            if pairing is None and T_ar_req is not None:
                pairing = "assumed_static"  # one pose for the whole clip

        # ---- localise ---- #
        results = []
        with st.gpu_lock:
            for fr in frames:
                try:
                    r = st.localizer.localize(m, fr.image, intr, device_id, intrinsics_mode == "map")
                except Exception as e:  # e.g. CUDA out of memory: report, do not crash the server
                    log.exception("localisation crashed")
                    raise HTTPException(500, f"localisation error: {type(e).__name__}: {e}")
                results.append((fr, r))
        best_fr, best = max(results, key=lambda fr_r: (fr_r[1].success, fr_r[1].num_inliers))
        out = localization_dict(best, m, st.loc_opts)
        out["frames"] = [
            {
                "index": fr.index,
                "timestamp_s": fr.timestamp,
                "success": r.success,
                "quality": r.quality,
                "num_inliers": r.num_inliers,
                "has_ar_pose": (fr.T_world_from_arcam is not None) or (pairing == "assumed_static" and fr is best_fr),
                "T_cvcam_from_map": mat(r.T_cvcam_from_map) if r.T_cvcam_from_map is not None else None,
            }
            for fr, r in results
        ]
        out["best_frame_index"] = best_fr.index

        # ---- alignment to the AR session ---- #
        new_obs = []
        for fr, r in results:
            T_ar = fr.T_world_from_arcam
            if T_ar is None and pairing == "assumed_static" and fr is best_fr:
                T_ar = T_ar_req
            if r.success and T_ar is not None:
                new_obs.append(Observation(r.T_cvcam_from_map, T_ar, float(r.num_inliers)))
        obs = new_obs
        if session_id:
            s = st.session(session_id, m.map_id)
            s["observations"] = (s["observations"] + new_obs)[-SESSION_MAX_OBS:]
            obs = s["observations"]
            out["session"] = {"session_id": session_id, "num_observations": len(obs)}
        has_ar = T_ar_req is not None or pairing == "session_jsonl"
        if has_ar or (session_id and obs):
            al = compute_alignment(m, obs, st.align_opts)
            _maybe_persist_scale(m, al, persist_scale)
            al["ar_pose_pairing"] = pairing
            al["from_weak_localization_only"] = bool(new_obs) and all(r.quality != "good" for _, r in results if r.success)
            out["alignment"] = strip_private(al)
        else:
            out["alignment"] = None
        out["elapsed_ms"] = round((time.perf_counter() - t_req) * 1000, 1)
        return out

    return app


def _tmp_root() -> Path:
    d = config.work_dir() / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def main(argv: list[str] | None = None) -> int:
    import uvicorn

    ap = argparse.ArgumentParser(description="Run the localisation server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    ap.add_argument("--maps-dir", default=None, help=f"default: {config.maps_dir()}")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--log-level", default="INFO")
    a = ap.parse_args(argv)
    config.setup_logging(a.log_level)
    app = create_app(maps_dir=Path(a.maps_dir) if a.maps_dir else None, device=a.device)
    st: State = app.state.locserver
    log.info("device %s (%s), maps %s from %s", st.pipe.device, st.pipe.device_name, sorted(st.maps), st.maps_dir)
    uvicorn.run(app, host=a.host, port=a.port, log_level=a.log_level.lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
