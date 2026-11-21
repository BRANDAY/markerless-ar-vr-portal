"""A wall that the scan saw only as a low band is not a wall of the plan - but the plan has to say so.

Found with the simulated phone on 2026-11-21: two builds of one recording, the first with two walls, the second
with none, because both walls were seen over 0.8 and 1.1 m of their height (the rule asks for 1.2 m).
"""
import numpy as np

from locserver.roomplan import DepthView, PlanOptions, compute_room_plan, fit_walls


def wall_points(length: float, h0: float, h1: float, y: float = 2.0, step: float = 0.04):
    """Points of the vertical plane y = const (plan frame: z up), normals towards the origin."""
    u, h = np.meshgrid(np.arange(-length / 2, length / 2, step), np.arange(h0, h1, step))
    q = np.stack([u.ravel(), np.full(u.size, y), h.ravel()], 1)
    return q, np.tile([0.0, -1.0], (len(q), 1))


def test_a_wall_seen_over_its_height_is_a_wall():
    q, n2 = wall_points(3.0, 0.3, 2.2)
    low: list[dict] = []
    walls = fit_walls(q, n2, 0.0, np.nan, PlanOptions(), low)
    assert len(walls) == 1 and low == []


def test_a_long_surface_seen_as_a_low_band_is_reported_not_kept():
    q, n2 = wall_points(3.0, 0.9, 1.7)
    low: list[dict] = []
    walls = fit_walls(q, n2, 0.0, np.nan, PlanOptions(), low)
    assert walls == []
    assert len(low) == 1
    assert abs(low[0]["length_m"] - 3.0) < 0.15 and abs(low[0]["seen_height_m"] - 0.8) < 0.1 and abs(low[0]["seen_from_m"] - 0.9) < 0.1


def test_a_short_low_thing_is_furniture_and_not_reported():
    q, n2 = wall_points(1.2, 0.3, 0.8)
    low: list[dict] = []
    assert fit_walls(q, n2, 0.0, np.nan, PlanOptions(), low) == [] and low == []


def looking_down_view(height: float = 1.5) -> DepthView:
    """A camera that looks straight down at the floor from ``height`` (map frame: y up)."""
    T = np.eye(4)
    T[:3, :3] = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])  # columns: image right, image down, forward
    T[:3, 3] = [0.0, height, 0.0]
    return DepthView(T, 32.0, 32.0, 32.0, 32.0, np.full((64, 64), height, np.float32), name="v0")


def test_the_reason_of_a_partial_plan_names_the_low_walls():
    # Through the whole computation, with points handed in as a "mesh": floor + two walls seen as bands, y up.
    opts = PlanOptions()
    g = np.arange(-1.5, 1.5, 0.04)
    fx, fz = np.meshgrid(g, g)
    floor = np.stack([fx.ravel(), np.zeros(fx.size), fz.ravel()], 1)
    fn = np.tile([0.0, 1.0, 0.0], (len(floor), 1))
    u, h = np.meshgrid(g, np.arange(0.9, 1.7, 0.04))
    w1 = np.stack([u.ravel(), h.ravel(), np.full(u.size, -1.5)], 1)
    n1 = np.tile([0.0, 0.0, 1.0], (len(w1), 1))
    w2 = np.stack([np.full(u.size, 1.5), h.ravel(), u.ravel()], 1)
    n2 = np.tile([-1.0, 0.0, 0.0], (len(w2), 1))
    room = compute_room_plan([looking_down_view()], (0.0, 1.0, 0.0), np.concatenate([floor, w1, w2]), np.concatenate([fn, n1, n2]), opts)
    assert room["status"] == "partial" and room["walls"] == []
    assert "2 more wall-like surfaces were seen over less than 1.2 m of height" in room["reason"]
    assert "from the floor to the ceiling" in room["reason"]
    assert len(room["stats"]["wall_candidates_seen_too_low"]) == 2
