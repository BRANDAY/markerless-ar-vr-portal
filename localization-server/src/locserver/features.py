"""Learned local features, matching and a light global descriptor.

* Local features: ALIKED (BSD-3-Clause) through the LightGlue package.
* Matching: LightGlue (Apache-2.0) with its ALIKED weights.
* Global descriptor for retrieval: VLAD over the ALIKED descriptors with a small
  codebook trained on the map itself (no extra model, no extra licence).

Keypoints are stored in "pixel index" coordinates (the centre of the top-left
pixel is (0, 0)), as the networks produce them. COLMAP uses centre = (0.5, 0.5);
the +0.5 shift is applied where points are handed to COLMAP (``to_colmap_xy``).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import cv2
import numpy as np
import torch

log = logging.getLogger(__name__)

EXTRACTOR_NAME = "aliked-n16"
MATCHER_NAME = "lightglue-aliked"


def pick_device(requested: str = "auto") -> str:
    """'auto' -> cuda if a working CUDA device exists, else cpu."""
    if requested in ("cpu", "cuda"):
        if requested == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but not available")
        return requested
    if torch.cuda.is_available():
        try:  # a build without kernels for this GPU fails here, not at import
            torch.zeros(8, device="cuda").sum().item()
            return "cuda"
        except Exception as e:  # pragma: no cover - hardware dependent
            log.warning("CUDA present but unusable (%s); falling back to CPU", e)
    return "cpu"


def to_colmap_xy(keypoints: np.ndarray) -> np.ndarray:
    return np.asarray(keypoints, dtype=np.float64) + 0.5


@dataclass
class Features:
    keypoints: np.ndarray  # (N, 2) float32, x/y in pixel-index coordinates
    descriptors: np.ndarray  # (N, D) float32, L2-normalised
    scores: np.ndarray  # (N,) float32
    width: int
    height: int


class FeaturePipeline:
    """ALIKED extraction + LightGlue matching on one device."""

    def __init__(self, device: str = "auto", max_keypoints: int = 2048, detection_threshold: float = 0.1):
        from lightglue import ALIKED, LightGlue

        self.device = pick_device(device)
        self.max_keypoints = max_keypoints
        t0 = time.perf_counter()
        self.extractor = (
            ALIKED(model_name=EXTRACTOR_NAME, max_num_keypoints=max_keypoints, detection_threshold=detection_threshold)
            .eval()
            .to(self.device)
        )
        # mp=False: mixed precision does not pay off on GPUs without fast FP16 (Pascal).
        self.matcher = LightGlue(features="aliked", mp=False).eval().to(self.device)
        self.load_seconds = time.perf_counter() - t0
        self.device_name = torch.cuda.get_device_name(0) if self.device == "cuda" else "cpu"

    @torch.inference_mode()
    def extract(self, image_bgr: np.ndarray) -> Features:
        """Extract from an image at the resolution it is given in (no resizing)."""
        h, w = image_bgr.shape[:2]
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(np.ascontiguousarray(rgb)).permute(2, 0, 1).float().div_(255.0)
        out = self.extractor.extract(t.to(self.device), resize=None)
        return Features(
            out["keypoints"][0].float().cpu().numpy(),
            out["descriptors"][0].float().cpu().numpy(),
            out["keypoint_scores"][0].float().cpu().numpy(),
            w,
            h,
        )

    def _pack(self, f: Features) -> dict:
        return {
            "keypoints": torch.from_numpy(f.keypoints)[None].to(self.device),
            "descriptors": torch.from_numpy(np.ascontiguousarray(f.descriptors, dtype=np.float32))[None].to(self.device),
            "image_size": torch.tensor([[f.width, f.height]], dtype=torch.float32, device=self.device),
        }

    @torch.inference_mode()
    def match(self, f0: Features, f1: Features) -> tuple[np.ndarray, np.ndarray]:
        """Returns (matches (K, 2) int64 indices into f0/f1, scores (K,))."""
        if len(f0.keypoints) == 0 or len(f1.keypoints) == 0:
            return np.zeros((0, 2), dtype=np.int64), np.zeros(0, dtype=np.float32)
        out = self.matcher({"image0": self._pack(f0), "image1": self._pack(f1)})
        return out["matches"][0].cpu().numpy().astype(np.int64), out["scores"][0].float().cpu().numpy()

    def sync(self) -> None:
        if self.device == "cuda":
            torch.cuda.synchronize()

    def vram_mb(self) -> dict | None:
        if self.device != "cuda":
            return None
        return dict(
            allocated=round(torch.cuda.memory_allocated() / 2**20),
            peak=round(torch.cuda.max_memory_allocated() / 2**20),
        )


# --------------------------------------------------------------------------- #
class VLAD:
    """Vector of locally aggregated descriptors with intra-normalisation."""

    def __init__(self, centers: np.ndarray):
        self.centers = np.asarray(centers, dtype=np.float32)

    @property
    def dim(self) -> int:
        return int(self.centers.size)

    @staticmethod
    def fit(descriptors: np.ndarray, k: int = 32, iters: int = 25, max_samples: int = 100_000, seed: int = 0) -> "VLAD":
        """Spherical k-means on a random sample of (L2-normalised) descriptors."""
        rng = np.random.default_rng(seed)
        X = np.asarray(descriptors, dtype=np.float32)
        if len(X) > max_samples:
            X = X[rng.choice(len(X), max_samples, replace=False)]
        k = int(min(k, max(1, len(X) // 20)))
        C = X[rng.choice(len(X), k, replace=False)].copy()
        for _ in range(iters):
            assign = np.argmax(X @ C.T, axis=1)
            for j in range(k):
                m = assign == j
                C[j] = X[m].mean(0) if m.any() else X[rng.integers(len(X))]
            C /= np.linalg.norm(C, axis=1, keepdims=True) + 1e-12
        return VLAD(C)

    def encode(self, descriptors: np.ndarray) -> np.ndarray:
        X = np.asarray(descriptors, dtype=np.float32)
        k, d = self.centers.shape
        v = np.zeros((k, d), dtype=np.float32)
        if len(X):
            assign = np.argmax(X @ self.centers.T, axis=1)
            np.add.at(v, assign, X - self.centers[assign])
            v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-12  # intra-normalisation
        v = v.ravel()
        return v / (np.linalg.norm(v) + 1e-12)
