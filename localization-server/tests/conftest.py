"""Shared fixtures: a tiny synthetic map and a server with stubbed models.

None of the tests in this folder load a neural network or need a GPU, so the
suite runs in a few seconds. The models are exercised by the evaluation script.
"""

from __future__ import annotations

import numpy as np
import pytest

from locserver import geometry as g
from locserver.features import VLAD, Features
from locserver.localize import LocalizationResult
from locserver.mapstore import MapImage, load_map, save_map, utc_now


def make_map(path, map_id="testmap", metric=True, n_images=3, seed=0):
    rng = np.random.default_rng(seed)
    images = []
    for i in range(n_images):
        n = 40
        desc = rng.normal(size=(n, 16)).astype(np.float32)
        desc /= np.linalg.norm(desc, axis=1, keepdims=True)
        feats = Features(rng.uniform(0, 100, (n, 2)).astype(np.float32), desc, np.ones(n, np.float32), 640, 480)
        xyz = rng.normal(size=(n, 3)).astype(np.float32)
        pid = np.arange(n, dtype=np.int64) + (0 if i < 2 else 1000)  # images 0 and 1 share their points
        T = g.make_T(np.eye(3), [0.1 * i, 0, 0])
        images.append(MapImage(f"{i:06d}.jpg", T, feats, xyz, pid))
    vlad = VLAD.fit(np.concatenate([im.features.descriptors for im in images]), k=4)
    gdesc = np.stack([vlad.encode(im.features.descriptors) for im in images])
    meta = {
        "format_version": 1, "map_id": map_id, "created_utc": utc_now(), "metric": metric,
        "scale_m_per_unit": 1.0 if metric else None, "scale_source": "test" if metric else None,
        "num_points3D": 80,
        "camera": {"model": "SIMPLE_RADIAL", "width": 640, "height": 480, "params": [500.0, 320.0, 240.0, 0.0],
                   "fx": 500.0, "fy": 500.0, "cx": 320.0, "cy": 240.0},
        "features": {"image_max_size": 640},
    }
    save_map(path, meta, images, vlad, gdesc)
    return load_map(path)


class StubPipe:
    device = "cpu"
    device_name = "stub"
    max_keypoints = 0

    def vram_mb(self):
        return None


class StubLocalizer:
    """Returns the poses queued by the test instead of running any model."""

    def __init__(self):
        self.queue: list[np.ndarray | None] = []
        self.calls: list[dict] = []

    def localize(self, lmap, image_bgr, intrinsics=None, device_id=None, assume_map_camera=False):
        self.calls.append({"shape": image_bgr.shape, "intrinsics": intrinsics, "device_id": device_id})
        T = self.queue.pop(0) if self.queue else None
        h, w = image_bgr.shape[:2]
        if T is None:
            return LocalizationResult(False, "failed", "stub: no pose", working_size=(w, h), timings_ms={"total": 1.0})
        return LocalizationResult(
            True, "good", None, T, num_matches=300, num_inliers=200, inlier_ratio=0.66,
            reproj_error_px_mean=1.0, reproj_error_px_median=0.9,
            intrinsics=dict(fx=500.0, fy=500.0, cx=w / 2, cy=h / 2, width=w, height=h),
            intrinsics_source="request" if intrinsics else "estimated", working_size=(w, h),
            num_keypoints=1000, timings_ms={"total": 1.0},
        )


@pytest.fixture
def maps_dir(tmp_path):
    d = tmp_path / "maps"
    make_map(d / "metric_room", "metric_room", metric=True)
    make_map(d / "scaleless_room", "scaleless_room", metric=False)
    return d


@pytest.fixture
def api(maps_dir, tmp_path):
    from fastapi.testclient import TestClient

    from locserver.server import State, create_app

    stub = StubLocalizer()
    state = State(maps_dir, pipe=StubPipe(), localizer=stub, calibration_dir=tmp_path / "calib")
    client = TestClient(create_app(state))
    client.stub = stub
    client.state_obj = state
    return client
