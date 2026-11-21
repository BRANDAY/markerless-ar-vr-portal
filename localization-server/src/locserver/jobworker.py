"""Worker process of a background job: ``python -m locserver.jobworker <spec.json>``.

Started by :class:`locserver.jobs.JobManager`. Talks to it through stdout, one
JSON object per line::

    {"stage": "matching", "p": 0.41, "msg": "matched 410 of 1000 image pairs"}
    {"result": {...}}            <- last line on success
    {"error": {"code": "sfm_failed", "message": "..."}}

Everything else (logging, COLMAP's own output) goes to stderr, which the
manager writes to ``worker.log`` in the job directory.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

log = logging.getLogger("locserver.jobworker")


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Reporter:
    """Progress lines, at most a few per second."""

    def __init__(self):
        self.last = (None, 0.0)

    def __call__(self, stage: str, fraction: float, message: str = "") -> None:
        now = time.time()
        if stage == self.last[0] and fraction < 1.0 and now - self.last[1] < 0.3:
            return
        self.last = (stage, now)
        emit({"stage": stage, "p": round(float(fraction), 4), "msg": message})


def classify(e: BaseException) -> str:
    text = str(e).lower()
    name = type(e).__name__
    if "outofmemory" in name.lower() or isinstance(e, MemoryError) or "out of memory" in text:
        return "out_of_memory"
    if "usable frames" in text:
        return "too_few_frames"
    if "sfm" in text:
        return "sfm_failed"
    if isinstance(e, (OSError, ValueError, KeyError)):
        return "bad_recording"
    return "internal"


def room_summary(room: dict) -> dict:
    return {"status": room["status"], "reason": room.get("reason"), "num_walls": len(room["walls"]),
            "num_corners": len(room["corners"]), "num_openings": len(room["openings"]),
            "best_opening_id": room.get("best_opening_id")}


def portal_summary(room: dict) -> dict:
    from .roomplan import opening_by_id

    o = opening_by_id(room, room.get("best_opening_id"))
    if o is None:
        return {"source": "none", "opening_id": None, "confidence": None}
    return {"source": "auto", "opening_id": o["id"], "confidence": o["confidence"]}


def _room(lmap, spec: dict, report, warnings: list[str]) -> dict:
    from .roomplan import empty_room
    from .roomstage import compute_room_for_map, save_room

    mesh = spec.get("mesh")
    try:
        room, warn = compute_room_for_map(lmap, spec.get("device", "auto"), mesh, spec.get("mesh_format"),
                                          bool(spec.get("detect_openings", True)), report)
        warnings += warn
    except Exception as e:  # the map itself is fine: report, do not fail the build
        log.exception("room plan failed")
        room = empty_room(f"room plan failed: {type(e).__name__}: {e}")
        warnings.append(room["reason"])
    if room["status"] == "unavailable":
        warnings.append(f"no room plan: {room['reason']}")
    elif room["status"] == "partial" and room.get("reason"):
        warnings.append(f"room plan is partial: {room['reason']}")
    save_room(lmap.path, room)
    return room


def run(spec: dict, report) -> dict:
    from .mapstore import load_map

    t0 = time.time()
    warnings: list[str] = []
    if spec["kind"] == "room_plan":
        lmap = load_map(Path(spec["map_dir"]))
        room = _room(lmap, spec, report, warnings)
    elif spec["kind"] == "build_map":
        from .features import FeaturePipeline
        from .mapping import BuildOptions, build_map
        from .recording import ViroRecordingCapture

        rec_dir, out_dir = Path(spec["job_dir"]), Path(spec["out_dir"])
        report("frames", 0.0, "opening the recording")
        cap = ViroRecordingCapture(rec_dir, display_rotation_cw=spec.get("display_rotation_cw"))
        pipe = FeaturePipeline(spec.get("device", "auto"))
        opts = BuildOptions(max_frames=int(spec.get("max_frames", 200)))
        lmap = build_map(rec_dir, out_dir, spec["map_id"], pipe, opts, capture=cap, progress=report)
        del pipe
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        extra = {k: spec[k] for k in ("label", "device_id", "recording_session_id", "wifi") if spec.get(k)}
        extra["built_from"] = "recording upload"
        lmap.meta.update(extra)
        (lmap.path / "map.json").write_text(json.dumps(lmap.meta, indent=2), encoding="utf-8")
        warnings += lmap.meta.get("warnings") or []
        if not lmap.metric:
            warnings.append("the reconstruction could not be aligned to the recorded AR poses: the map is not metric")
        room = _room(lmap, spec, report, warnings)
    else:
        raise ValueError(f"unknown job kind {spec['kind']!r}")
    report("finalize", 0.0, "writing the map")
    return {
        "map_id": spec["map_id"], "num_images": len(lmap.images), "num_points3D": lmap.meta.get("num_points3D"),
        "metric": lmap.metric, "gravity_aligned": bool(lmap.meta.get("up")) or room["status"] != "unavailable",
        "build_time_s": round(time.time() - t0, 1), "room": room_summary(room), "portal": portal_summary(room),
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    from . import config

    argv = sys.argv[1:] if argv is None else argv
    config.setup_logging("INFO")
    spec = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    try:
        result = run(spec, Reporter())
    except BaseException as e:  # noqa: BLE001 - everything is reported to the manager
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            raise
        log.exception("job failed")
        emit({"error": {"code": classify(e), "message": f"{type(e).__name__}: {e}"}})
        return 1
    emit({"result": result})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
