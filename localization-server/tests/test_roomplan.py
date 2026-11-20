"""Room plan geometry on synthetic rooms with known walls and door."""

import numpy as np
import pytest

from locserver import geometry as g
from locserver.roomplan import compute_room_plan, opening_by_id, transform_room
from locserver.synthroom import make_room, make_views

UP = (0.0, 1.0, 0.0)


def near(a, b, tol):
    return np.linalg.norm(np.asarray(a, float) - np.asarray(b, float)) <= tol


def check_door(room, truth, tol=0.08):
    assert len(room["openings"]) == 1, room["openings"]
    o = room["openings"][0]
    d = truth["door"]
    assert near(o["center_bottom"], d["center_bottom"], tol), (o["center_bottom"], d["center_bottom"])
    assert abs(o["width"] - d["width"]) < 0.12 and abs(o["height"] - d["height"]) < 0.12, (o["width"], o["height"])
    assert np.dot(o["normal"], d["normal"]) > 0.99
    return o


@pytest.fixture(scope="module")
def plain():
    truth = make_room()
    return truth, compute_room_plan(make_views(truth), UP)


def test_box_room_floor_walls_corners(plain):
    truth, room = plain
    assert room["status"] == "ok" and room["frame"] == "map" and room["up"] == [0.0, 1.0, 0.0]
    assert abs(room["floor"]["level"] - truth["floor_y"]) < 0.02
    assert abs(room["height"] - 2.6) < 0.04 and room["ceiling"]["normal"] == [0.0, -1.0, 0.0]
    assert len(room["walls"]) == 4 and len(room["corners"]) == 4
    for c in truth["corners"]:
        assert min(np.linalg.norm(np.array(k["bottom"]) - c) for k in room["corners"]) < 0.06
    for k in room["corners"]:
        assert abs(k["angle_deg"] - 90) < 2 and abs(k["top"][1] - k["bottom"][1] - 2.6) < 0.05
    lengths = sorted(w["width"] for w in room["walls"])
    assert np.allclose(lengths, [3.2, 3.2, 4.0, 4.0], atol=0.08)
    centre = np.array([2.0, 0.0, 1.6])
    for w in room["walls"]:  # normals point into the room; rectangle corners agree with the pose
        assert np.dot(w["normal"], centre - np.array(w["center"])) > 0
        bl, br, tr, tl = (np.array(p) for p in w["corners"])
        R = g.quat_to_rotmat(w["pose"]["quaternion_xyzw"])
        assert near(R[:, 0], (br - bl) / np.linalg.norm(br - bl), 1e-3) and near(R[:, 1], UP, 1e-3)
        assert near(R[:, 2], w["normal"], 1e-3) and near((bl + tr) / 2, w["center"], 1e-3)
        assert near(g.viro_euler_to_rotmat(w["pose"]["rotation_euler_deg"]), R, 1e-3)
    out = np.array(room["floor"]["outline"])
    assert len(out) == 4 and np.cross(out[1] - out[0], out[2] - out[1])[1] > 0  # counter-clockwise seen from above


def test_open_door_is_found_by_geometry_alone(plain):
    truth, room = plain
    o = check_door(room, truth)
    assert o["state"] == "open" and o["evidence"]["detector"] is None and o["evidence"]["geometry"] > 0.7
    assert o["confidence"] >= 0.5 and room["best_opening_id"] == "o0" and o["height_measured"]
    # the doorway frame of the app: origin on the floor mid-threshold, +Y up, +Z into the scanned room
    R = g.quat_to_rotmat(o["portal_pose"]["quaternion_xyzw"])
    assert near(o["portal_pose"]["position"], truth["door"]["center_bottom"], 0.08)
    assert near(R[:, 2], truth["door"]["normal"], 0.02) and near(R[:, 1], UP, 1e-3)
    assert np.linalg.det(R) == pytest.approx(1.0, abs=1e-6)
    assert opening_by_id(room, "o0") is o and opening_by_id(room, "nope") is None


def test_rotated_noisy_room_with_cupboard_and_window():
    truth = make_room(lx=4.6, lz=3.6, yaw_deg=33.0, offset=(1.2, 0.4, -2.0), cupboard=True, window=True, door=(2.6, 3.5, 2.05))
    room = compute_room_plan(make_views(truth, noise=0.01), UP)
    assert room["status"] == "ok" and len(room["walls"]) == 4  # the cupboard front is not a wall
    assert abs(room["floor"]["level"] - truth["floor_y"]) < 0.03
    check_door(room, truth, tol=0.12)  # and the window is not reported
    for c in truth["corners"]:
        assert min(np.linalg.norm(np.array(k["bottom"]) - c) for k in room["corners"]) < 0.12


def test_closed_door_needs_the_detector_and_is_never_invented():
    truth = make_room(door_closed=True)
    room = compute_room_plan(make_views(truth), UP)
    assert room["status"] == "ok" and room["openings"] == [] and room["best_opening_id"] is None
    room = compute_room_plan(make_views(truth, door_boxes=True), UP)
    o = check_door(room, truth, tol=0.1)
    assert o["state"] == "closed" and o["evidence"]["geometry"] is None and o["evidence"]["detector"] == pytest.approx(0.6)
    assert o["evidence"]["views"] >= 3 and room["best_opening_id"] == "o0"


def test_detector_and_geometry_agree_on_one_opening():
    truth = make_room()
    room = compute_room_plan(make_views(truth, door_boxes=True), UP)
    o = check_door(room, truth)
    assert o["evidence"]["geometry"] and o["evidence"]["detector"] and o["confidence"] > 0.85


def test_detector_box_on_an_open_door_leaf_is_rejected():
    """A box whose depth is well in front of the wall is not an opening in that wall."""
    truth = make_room(door_closed=True)
    views = make_views(truth, door_boxes=True)
    for v in views:
        if v.boxes:
            v.depth = v.depth * 0.5  # everything twice as close as the wall
    assert compute_room_plan(views, UP)["openings"] == []


def test_z_up_frame():
    truth = make_room()
    views = make_views(truth)
    Rx = np.eye(4)
    Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]  # +Y -> +Z
    for v in views:
        v.T_map_from_cvcam = Rx @ v.T_map_from_cvcam
    room = compute_room_plan(views, (0, 0, 1))
    assert room["status"] == "ok" and len(room["walls"]) == 4 and len(room["openings"]) == 1
    assert near(room["openings"][0]["center_bottom"], Rx[:3, :3] @ truth["door"]["center_bottom"], 0.08)


def test_no_floor_or_no_views_is_reported_not_guessed():
    assert compute_room_plan([], UP)["status"] == "unavailable"
    truth = make_room()
    views = [v for v in make_views(truth) if v.name.endswith("_8")]  # only the views pitched up: no floor
    for v in views:
        v.depth[v.depth.shape[0] // 2 :] = np.nan
    room = compute_room_plan(views, UP)
    assert room["status"] == "unavailable" and "floor" in room["reason"] and room["openings"] == []


def test_transform_room_to_another_frame(plain):
    truth, room = plain
    sim = g.Sim3(1.0, g.viro_euler_to_rotmat([0, 40, 0]), np.array([0.5, 1.0, -2.0]))
    ar = transform_room(room, sim)
    assert ar["frame"] == "arworld" and near(ar["up"], UP, 1e-6) and "stats" not in ar
    assert ar["floor"]["level"] == pytest.approx(room["floor"]["level"] + 1.0, abs=1e-3)
    o, oa = room["openings"][0], ar["openings"][0]
    assert near(oa["center_bottom"], sim.apply(np.array([o["center_bottom"]]))[0], 1e-3)
    assert near(oa["portal_pose"]["position"], oa["center_bottom"], 1e-3)
    assert near(g.quat_to_rotmat(oa["portal_pose"]["quaternion_xyzw"])[:, 2], oa["normal"], 1e-3)
    assert near(oa["normal"], sim.R @ np.array(o["normal"]), 1e-3) and oa["width"] == o["width"]
    w, wa = room["walls"][0], ar["walls"][0]
    assert near(wa["corners"], sim.apply(np.array(w["corners"])), 1e-3)
    half = transform_room(room, g.Sim3(0.5, np.eye(3), np.zeros(3)))
    assert half["walls"][0]["width"] == pytest.approx(w["width"] / 2, abs=1e-3)
