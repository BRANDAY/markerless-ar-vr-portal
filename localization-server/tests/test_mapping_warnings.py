"""A finished map that is thin or contradicts the recording must say so (job result and panel show these lines)."""
from locserver.mapping import map_warnings


def alignment(inliers: int, frames: int, median_m: float = 0.02, attempts: int = 1) -> dict:
    return {"frames_with_pose": frames, "inliers": inliers, "inlier_fraction": round(inliers / frames, 3), "median_m": median_m,
            "threshold_m": 0.10, "sfm_attempts": attempts}


def test_a_good_map_has_no_warning():
    assert map_warnings(28, 30, alignment(27, 28)) == []
    assert map_warnings(30, 30, None) == []  # plain images: nothing to compare the cameras with


def test_a_map_that_contradicts_the_recorded_poses_is_reported():
    # the build that was accepted silently on 2026-11-20: 13 of 28 cameras near their recorded places, median 26 cm
    (w,) = map_warnings(28, 28, alignment(13, 28, median_m=0.26, attempts=3))
    assert "only 13 of 28 cameras" in w and "10 cm" in w and "median 26 cm" in w and "3 attempts" in w
    assert "scan again" in w


def test_the_limit_is_the_builders_own():
    assert map_warnings(10, 10, alignment(6, 10)) == []  # exactly 60 %
    assert len(map_warnings(10, 10, alignment(5, 10))) == 1
    assert map_warnings(10, 10, alignment(5, 10), min_inlier_fraction=0.4) == []


def test_a_map_that_lost_most_of_its_frames_is_reported():
    (w,) = map_warnings(14, 30, alignment(14, 14))
    assert "only 14 of 30 selected frames" in w and "parts of the room are missing" in w
    assert map_warnings(18, 30, alignment(18, 18)) == []  # 60 % kept


def test_both_problems_give_both_lines():
    assert len(map_warnings(5, 30, alignment(2, 5, median_m=0.4))) == 2
