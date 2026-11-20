"""JSON shapes of the API and the map <-> AR-world alignment glue.

Kept free of FastAPI so that the same code serves the HTTP API, the CLIs and
the tests.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import geometry as g
from .localize import LocalizationResult, LocalizeOptions
from .mapstore import LocMap
from .roomplan import opening_by_id, transform_room


def mat(T: np.ndarray) -> list[list[float]]:
    return [[float(v) for v in row] for row in np.asarray(T)]


def vec(v) -> list[float]:
    return [float(x) for x in np.asarray(v).ravel()]


@dataclass
class AlignOptions:
    pos_threshold_m: float = 0.10
    rot_threshold_deg: float = 5.0
    min_baseline_m: float = 0.15
    # A scale estimated in one session is reported as reliable (and may be stored
    # in the map) only above this camera travel and below this uncertainty:
    reliable_baseline_m: float = 0.5
    reliable_scale_rel_std: float = 0.05

    def thresholds(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Observation:
    T_cvcam_from_map: np.ndarray
    T_arworld_from_arcam: np.ndarray
    weight: float = 1.0


# --------------------------------------------------------------------------- #
def pose_dict(T_cvcam_from_map: np.ndarray) -> dict:
    T_map_from_cvcam = g.invert_T(T_cvcam_from_map)
    T_map_from_arcam = T_map_from_cvcam @ g.make_T(g.CV_FROM_GL, np.zeros(3))
    return {
        "T_map_from_cvcam": mat(T_map_from_cvcam),
        "T_cvcam_from_map": mat(T_cvcam_from_map),
        "T_map_from_arcam": mat(T_map_from_arcam),
        "position": vec(T_map_from_cvcam[:3, 3]),
        "quaternion_xyzw": vec(g.rotmat_to_quat(T_map_from_cvcam[:3, :3])),
        "quaternion_xyzw_arcam": vec(g.rotmat_to_quat(T_map_from_arcam[:3, :3])),
    }


def localization_dict(res: LocalizationResult, lmap: LocMap, opts: LocalizeOptions) -> dict:
    return {
        "success": res.success,
        "quality": res.quality,
        "reason": res.reason,
        "map_id": lmap.map_id,
        "map_metric": lmap.metric,
        "map_scale_m_per_unit": lmap.scale_m_per_unit,
        "pose": pose_dict(res.T_cvcam_from_map) if res.T_cvcam_from_map is not None else None,
        "num_keypoints": res.num_keypoints,
        "num_matches": res.num_matches,
        "num_inliers": res.num_inliers,
        "inlier_ratio": round(res.inlier_ratio, 4),
        "reprojection_error_px": {"mean": res.reproj_error_px_mean, "median": res.reproj_error_px_median},
        "intrinsics_used": res.intrinsics,
        "intrinsics_source": res.intrinsics_source,
        "working_size": list(res.working_size) if res.working_size else None,
        "retrieved": res.retrieved,
        "thresholds": opts.thresholds(),
        "timings_ms": res.timings_ms,
    }


# --------------------------------------------------------------------------- #
def anchor_pose_dict(T_frame_from_anchor: np.ndarray) -> dict:
    """Pose of an anchor in some frame, in the form a ViroNode takes it."""
    R = T_frame_from_anchor[:3, :3]
    return {
        "position": vec(T_frame_from_anchor[:3, 3]),
        "rotation_euler_deg": vec(g.rotmat_to_viro_euler(R)),
        "quaternion_xyzw": vec(g.rotmat_to_quat(R)),
    }


def anchors_in_arworld(lmap: LocMap, sim: g.Sim3) -> dict:
    return {
        name: anchor_pose_dict(sim.transform_pose(LocMap.anchor_T(entry))) for name, entry in lmap.anchors().items()
    }


def resolve_portal(lmap: LocMap) -> dict:
    """Where the portal stands, in map coordinates: manual anchor > selected opening > best opening > none.

    The pose is the doorway frame of the app: origin on the floor in the middle
    of the threshold, +Y up, +Z into the scanned room. ``_T`` (4x4) is private.
    """
    out = {"map_id": lmap.map_id, "frame": "map", "source": "none", "opening_id": None, "position": None,
           "rotation_euler_deg": None, "quaternion_xyzw": None, "width": None, "height": None, "confidence": None,
           "reason": None, "_T": None}
    manual = lmap.anchors().get("portal")
    if manual is not None:
        T = LocMap.anchor_T(manual)
        return {**out, "source": "manual", **anchor_pose_dict(T), "_T": T}
    room = lmap.room()
    if not room or room.get("status") == "unavailable":
        why = (room or {}).get("reason") or "not computed"
        return {**out, "reason": f"the map has no room plan ({why})"}
    chosen = opening_by_id(room, lmap.portal_selection())
    source = "selected"
    if chosen is None:
        chosen, source = opening_by_id(room, room.get("best_opening_id")), "auto"
    if chosen is None:
        n = len(room.get("openings", []))
        why = "no door opening was found in this room" if n == 0 else             f"{n} possible opening(s) found, none confident enough to use automatically"
        return {**out, "reason": why}
    pp = chosen["portal_pose"]
    T = g.make_T(g.quat_to_rotmat(pp["quaternion_xyzw"]), pp["position"])
    return {**out, "source": source, "opening_id": chosen["id"], **anchor_pose_dict(T), "width": chosen["width"],
            "height": chosen["height"], "confidence": chosen["confidence"], "_T": T}


def portal_in_arworld(portal: dict, sim: g.Sim3) -> dict:
    out = {k: v for k, v in portal.items() if k not in ("_T", "map_id")}
    out["frame"] = "arworld"
    if portal["_T"] is not None:
        out.update(anchor_pose_dict(sim.transform_pose(portal["_T"])))
        for k in ("width", "height"):
            if out[k] is not None:
                out[k] = round(float(out[k]) * sim.scale, 4)
    return out


def compute_alignment(lmap: LocMap, observations: list[Observation], opts: AlignOptions | None = None,
                      include_room: bool = True) -> dict:
    """``arworld <- map`` from the observations of one AR session, as API JSON."""
    opts = opts or AlignOptions()
    out: dict = {
        "status": "failed",
        "observations_total": len(observations),
        "thresholds": opts.thresholds(),
    }
    if not observations:
        out["reason"] = "no successfully localised frame with an AR camera pose"
        return out
    fixed = lmap.scale_m_per_unit
    try:
        r = g.align_observations(
            [o.T_cvcam_from_map for o in observations],
            [o.T_arworld_from_arcam for o in observations],
            fixed_scale=fixed,
            pos_threshold_m=opts.pos_threshold_m,
            rot_threshold_deg=opts.rot_threshold_deg,
            min_baseline_m=opts.min_baseline_m,
            weights=[o.weight for o in observations],
        )
    except ValueError as e:
        out["reason"] = str(e)
        return out

    sim = r.sim3
    if r.scale_source == "fixed":
        scale_source = "map_metric" if lmap.metric else "map_calibrated"
        reliable = True
    elif r.scale_source == "estimated":
        scale_source = "estimated_from_session"
        reliable = bool(
            r.baseline_m >= opts.reliable_baseline_m
            and r.scale_rel_std is not None
            and r.scale_rel_std <= opts.reliable_scale_rel_std
            and int(r.inliers.sum()) >= 3
        )
    else:
        scale_source, reliable = "unknown", False

    out.update(
        status="ok" if r.scale_source != "unknown" else "scale_unknown",
        scale=sim.scale if r.scale_source != "unknown" else None,
        scale_source=scale_source,
        scale_reliable=reliable,
        scale_rel_std=r.scale_rel_std,
        rotation_quaternion_xyzw=vec(g.rotmat_to_quat(sim.R)),
        observations_used=int(r.inliers.sum()),
        inlier_mask=[bool(b) for b in r.inliers],
        position_rms_m=r.position_rms_m,
        rotation_max_deg=r.rotation_max_deg,
        baseline_m=r.baseline_m,
    )
    if r.scale_source == "unknown":
        out["reason"] = (
            "the map has no metric scale and one frame (or frames without camera travel) cannot "
            "provide it: send >= 2 frames taken >= 0.15 m apart, or calibrate the map scale once"
        )
        out["rotation_only"] = True
        out["T_arworld_from_map"] = None
        out["anchors"] = {}
    else:
        out["translation"] = vec(sim.t)
        out["T_arworld_from_map"] = mat(sim.matrix())
        out["anchors"] = anchors_in_arworld(lmap, sim)
        portal = portal_in_arworld(resolve_portal(lmap), sim)
        out["portal"] = portal
        if portal["source"] not in ("none", "manual"):  # v1 clients read anchors.portal
            out["anchors"]["portal"] = {k: portal[k] for k in ("position", "rotation_euler_deg", "quaternion_xyzw")}
        room = lmap.room() if include_room else None
        out["room"] = transform_room(room, sim) if room and room.get("status") != "unavailable" else None
    out["_sim3"] = sim if r.scale_source != "unknown" else None  # stripped before sending
    return out


def strip_private(d: dict) -> dict:
    return {k: v for k, v in d.items() if not k.startswith("_")}


def parse_ar_pose(obj: dict) -> np.ndarray:
    """``T_arworld_from_arcam`` from ``{position, rotation|forward+up|quaternion_xyzw}``.

    ``rotation`` is ViroReact's Euler triple in degrees, exactly as delivered by
    ``onCameraTransformUpdate`` / ``getCameraOrientationAsync``.
    """
    if "position" not in obj:
        raise ValueError("AR pose needs 'position'")
    return g.viro_camera_pose(
        obj["position"],
        rotation_euler_deg=obj.get("rotation", obj.get("rotation_euler_deg")),
        forward=obj.get("forward"),
        up=obj.get("up"),
        quaternion_xyzw=obj.get("quaternion_xyzw"),
    )
