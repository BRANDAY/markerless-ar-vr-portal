"""The bridge between the map of an external positioning service and the room's frame.

A room has one door, stored in the room's frame (the frame of this server's
map). Another way of recognising the room - ReactVision Advanced VPS, an ARCore
cloud anchor - reports the phone in a frame of its own. The bridge says how
that frame lies in the room's frame::

    p_room = T_map_from_service * p_service

so the one door serves every way: moving the door moves it for all of them.

The bridge is measured, not typed in: in one AR session the phone is located
by this server (``T_arworld_from_map``) and by the service
(``T_arworld_from_service``); every such pair gives one estimate
``inv(T_arworld_from_map) @ T_arworld_from_service``, and several are averaged.

Kept free of FastAPI.
"""

from __future__ import annotations

import numpy as np

from . import geometry as g

MAX_SAMPLES = 200
OUTLIER_M = 0.25      # a sample further than this from the others (at the reference point) is left out
OUTLIER_DEG = 10.0
CLIENT_FIELDS = {"T_map_from_service", "position_error_m", "rotation_error_deg", "samples", "measured_utc", "method"}


def pose_matrix(obj, what: str) -> np.ndarray:
    """A rigid 4x4 from a 4x4 list or from ``{"position": [..], "quaternion_xyzw": [..]}``."""
    if isinstance(obj, dict):
        pos = np.asarray([float(x) for x in obj["position"]])
        quat = [float(x) for x in obj["quaternion_xyzw"]]
        if pos.shape != (3,) or len(quat) != 4 or not np.isfinite(pos).all() or not np.isfinite(quat).all():
            raise ValueError(f"{what}: position [x, y, z] and quaternion_xyzw [x, y, z, w] are needed")
        return g.make_T(g.quat_to_rotmat(quat), pos)
    M = np.asarray(obj, dtype=float)
    if M.shape != (4, 4) or not np.isfinite(M).all() or not np.allclose(M[3], [0, 0, 0, 1], atol=1e-6):
        raise ValueError(f"{what}: a 4x4 matrix with the last row 0 0 0 1 (or position + quaternion_xyzw)")
    return M


def split_similarity(M: np.ndarray, what: str) -> tuple[float, np.ndarray, np.ndarray]:
    """``(scale, R, t)`` of a 4x4 similarity; refuses anything else (shear, mirror)."""
    det = float(np.linalg.det(M[:3, :3]))
    if not np.isfinite(det) or det <= 0:
        raise ValueError(f"{what} is not a rotation with a positive scale")
    s = float(np.cbrt(det))
    R = g.project_to_rotation(M[:3, :3] / s)
    if not np.allclose(M[:3, :3], s * R, atol=1e-3 * max(s, 1.0)):
        raise ValueError(f"{what} is not a similarity transform (rotation, one scale, shift)")
    return s, R, M[:3, 3].copy()


def similarity(s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    M = np.eye(4)
    M[:3, :3] = s * R
    M[:3, 3] = t
    return M


def invert_similarity(M: np.ndarray) -> np.ndarray:
    s, R, t = split_similarity(M, "transform")
    return similarity(1.0 / s, R.T, -(R.T @ t) / s)


def sample_arworld_from_service(sample: dict, i: int) -> np.ndarray:
    """``T_arworld_from_service`` of one sample.

    Either given directly, or as the same camera seen at one moment by both:
    ``camera_in_arworld`` (ARCore) and ``camera_in_service`` (what the service
    reported). The camera's own axes cancel out, they only have to be the same
    in both poses.
    """
    what = f"samples[{i}]"
    if not isinstance(sample, dict):
        raise ValueError(f"{what}: an object is needed")
    if "T_arworld_from_service" in sample:
        M = pose_matrix(sample["T_arworld_from_service"], f"{what}.T_arworld_from_service")
    elif "camera_in_arworld" in sample and "camera_in_service" in sample:
        a = pose_matrix(sample["camera_in_arworld"], f"{what}.camera_in_arworld")
        b = pose_matrix(sample["camera_in_service"], f"{what}.camera_in_service")
        M = a @ invert_similarity(b)
    else:
        raise ValueError(f"{what}: T_arworld_from_service, or camera_in_arworld together with camera_in_service")
    s, R, t = split_similarity(M, what)
    if abs(s - 1.0) > 0.02:
        raise ValueError(f"{what}: the AR world and the service's map are both in metres, the scale between them is {s:.3f}")
    return g.make_T(R, t)


def average(Ms: list[np.ndarray], reference: np.ndarray | None = None) -> dict:
    """One ``T_map_from_service`` out of several estimates of it.

    The estimates are compared and averaged *at the reference point* (a point
    of the room, in map coordinates - the door) and not at the origin of the
    service's map, which may lie far away: there a small difference in rotation
    would look like a large difference in position.
    """
    if not Ms:
        raise ValueError("no samples")
    ref = np.zeros(3) if reference is None else np.asarray(reference, dtype=float)
    parts = [split_similarity(M, "sample") for M in Ms]
    scales = np.array([p[0] for p in parts])
    Rs = np.array([p[1] for p in parts])
    x_ref = (invert_similarity(Ms[0]) @ np.append(ref, 1.0))[:3]          # the reference point in the service's map
    ys = np.array([(M @ np.append(x_ref, 1.0))[:3] for M in Ms])          # where each estimate puts it in the room
    keep = np.ones(len(Ms), dtype=bool)
    for _ in range(3):
        R_mean = g.mean_rotation(Rs[keep])
        y_med = np.median(ys[keep], axis=0)
        ok = (np.linalg.norm(ys - y_med, axis=1) <= OUTLIER_M) & \
             np.array([g.rotation_angle_deg(R, R_mean) <= OUTLIER_DEG for R in Rs])
        if ok.sum() * 2 < len(Ms) or not ok.any():
            raise ValueError(
                f"the samples disagree: fewer than half of {len(Ms)} lie within {OUTLIER_M} m and {OUTLIER_DEG:g} deg "
                "of each other - measure again while both ways track well")
        if (ok == keep).all():
            break
        keep = ok
    R_mean, y_mean, s = g.mean_rotation(Rs[keep]), ys[keep].mean(axis=0), float(scales[keep].mean())
    n = int(keep.sum())
    pos = float(np.sqrt(np.mean(np.sum((ys[keep] - y_mean) ** 2, axis=1)))) if n > 1 else None
    rot = float(np.sqrt(np.mean([g.rotation_angle_deg(R, R_mean) ** 2 for R in Rs[keep]]))) if n > 1 else None
    return {
        "T_map_from_service": similarity(s, R_mean, y_mean - s * R_mean @ x_ref),
        "scale": s, "samples": n, "samples_total": len(Ms), "used": [bool(b) for b in keep],
        "position_spread_m": pos, "rotation_spread_deg": rot,
    }


def _num(v, what: str, top: float) -> float | None:
    if v is None:
        return None
    x = float(v)
    if not np.isfinite(x) or not 0 <= x <= top:
        raise ValueError(f"{what}: a number from 0 to {top:g}")
    return x


def from_client(b, frame_id, device: str | None, now: str) -> dict:
    """A bridge the app worked out itself (``PATCH /maps/{id}`` -> ``vps.bridge``)."""
    if not isinstance(b, dict):
        raise ValueError("vps.bridge: an object or null")
    unknown = set(b) - CLIENT_FIELDS
    if unknown:
        raise ValueError(f"vps.bridge: unknown field(s) {sorted(unknown)}")
    M = pose_matrix(b["T_map_from_service"], "vps.bridge.T_map_from_service")
    s, R, t = split_similarity(M, "vps.bridge.T_map_from_service")
    samples = b.get("samples")
    if samples is not None and (not isinstance(samples, int) or isinstance(samples, bool) or not 1 <= samples <= 100000):
        raise ValueError("vps.bridge.samples: a whole number of 1 or more")
    when = b.get("measured_utc")
    if when is not None and (not isinstance(when, str) or not 0 < len(when) <= 40):
        raise ValueError("vps.bridge.measured_utc: a time as text, e.g. 2026-11-22T10:00:00Z")
    return {
        "T_map_from_service": [[float(v) for v in row] for row in similarity(s, R, t)],
        "scale": s, "frame_id": frame_id, "method": str(b.get("method") or "client")[:40],
        "samples": samples, "samples_total": samples,
        "position_error_m": _num(b.get("position_error_m"), "vps.bridge.position_error_m", 100.0),
        "rotation_error_deg": _num(b.get("rotation_error_deg"), "vps.bridge.rotation_error_deg", 180.0),
        "measured_utc": when or now, "received_utc": now, "measured_by": device,
    }


def from_samples(samples, T_arworld_from_map: np.ndarray, reference, frame_id, device: str | None, now: str,
                 alignment_used: str, alignment_rms_m: float | None, reference_name: str,
                 alignment_frames: int | None = None) -> dict:
    """A bridge from the phone located both ways in one AR session (``POST /maps/{id}/vps/bridge``)."""
    if not isinstance(samples, list) or not samples:
        raise ValueError("samples: a list with at least one entry")
    if len(samples) > MAX_SAMPLES:
        raise ValueError(f"samples: at most {MAX_SAMPLES}")
    inv = invert_similarity(np.asarray(T_arworld_from_map, dtype=float))
    r = average([inv @ sample_arworld_from_service(s, i) for i, s in enumerate(samples)], reference)
    spread, rms = r["position_spread_m"], alignment_rms_m
    error = None if spread is None else float(np.hypot(spread, rms or 0.0))
    warnings = []
    if r["samples"] < 5:
        warnings.append(f"only {r['samples']} sample(s): send five or more from different places in the room")
    if alignment_used != "recording_session":
        warnings.append(
            "measured through this session's own alignment with the room"
            + (f" ({alignment_frames} frames)" if alignment_frames else "")
            + ": any error of that alignment is part of the bridge and is NOT in position_error_m "
              "(the samples all share it). The AR session that recorded the room has no such error - measure there when possible")
    return {
        "T_map_from_service": [[float(v) for v in row] for row in r["T_map_from_service"]],
        "scale": r["scale"], "frame_id": frame_id, "method": "dual_localization",
        "samples": r["samples"], "samples_total": r["samples_total"],
        "position_error_m": error, "rotation_error_deg": r["rotation_spread_deg"],
        "position_spread_m": spread, "rotation_spread_deg": r["rotation_spread_deg"],
        "alignment_used": alignment_used, "alignment_position_rms_m": rms, "alignment_frames": alignment_frames,
        "compared_at": reference_name, "warnings": warnings,
        "measured_utc": now, "received_utc": now, "measured_by": device,
    }


def public_vps(vps: dict | None, frame_id) -> dict | None:
    """The room's ``vps`` entry as the API returns it: the inverse matrix added, validity said out loud."""
    if not vps:
        return None
    out = {k: v for k, v in vps.items() if k != "door"}   # "door" was the second copy of the door of server 0.4.0
    b = out.get("bridge")
    if b:
        b = dict(b)
        b["T_service_from_map"] = [[float(v) for v in row] for row in invert_similarity(np.asarray(b["T_map_from_service"], dtype=float))]
        b["valid"] = b.get("frame_id") == frame_id
        out["bridge"] = b
    else:
        out["bridge"] = None
    return out
