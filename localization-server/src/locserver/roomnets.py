"""The two networks of the room-plan stage: dense depth and a door detector.

Both come from Hugging Face ``transformers`` with permissive licences:

* Depth Anything V2 Small - Apache-2.0 - relative (affine-invariant) inverse depth;
* Grounding DINO tiny     - Apache-2.0 - open-vocabulary boxes for the prompt "door".

They are loaded only while a room plan is being computed (map building), one at
a time, and released afterwards: the localisation models keep their place on a
4 GB card. Everything in :mod:`locserver.roomplan` works on plain arrays, so the
geometry is testable without these models.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

log = logging.getLogger(__name__)

DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"
DOOR_MODEL = "IDEA-Research/grounding-dino-tiny"
DOOR_PROMPT = "door. doorway."


def _torch_device(device: str):
    import torch

    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    return torch.device(device)


def release(*models) -> None:
    """Drop models and give their VRAM back."""
    import gc

    import torch

    for m in models:
        if m is not None and hasattr(m, "model"):
            m.model = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


class DepthNet:
    """Relative inverse depth ("disparity up to scale and shift") of an image."""

    def __init__(self, device: str = "auto", long_side: int = 518):
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        self.device = _torch_device(device)
        self.long_side = long_side
        self.processor = AutoImageProcessor.from_pretrained(DEPTH_MODEL)
        self.model = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL).to(self.device).eval()
        self._torch = torch

    def disparity(self, image_bgr: np.ndarray) -> np.ndarray:
        """float32 HxW at the size of the input image; larger = closer."""
        torch = self._torch
        h, w = image_bgr.shape[:2]
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        inputs = self.processor(images=rgb, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            pred = self.model(**inputs).predicted_depth  # 1 x h' x w'
            pred = torch.nn.functional.interpolate(pred[None], size=(h, w), mode="bilinear", align_corners=False)[0, 0]
        return pred.float().cpu().numpy()


@dataclass
class Box:
    x0: float
    y0: float
    x1: float
    y1: float
    score: float
    label: str


class DoorNet:
    """Door / doorway boxes in an image."""

    def __init__(self, device: str = "auto", box_threshold: float = 0.30, text_threshold: float = 0.25):
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        self.device = _torch_device(device)
        self.box_threshold, self.text_threshold = box_threshold, text_threshold
        self.processor = AutoProcessor.from_pretrained(DOOR_MODEL)
        self.model = AutoModelForZeroShotObjectDetection.from_pretrained(DOOR_MODEL).to(self.device).eval()
        self._torch = torch

    def detect(self, image_bgr: np.ndarray) -> list[Box]:
        torch = self._torch
        h, w = image_bgr.shape[:2]
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        inputs = self.processor(images=rgb, text=DOOR_PROMPT, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            out = self.model(**inputs)
        kw = dict(text_threshold=self.text_threshold, target_sizes=[(h, w)])
        try:
            res = self.processor.post_process_grounded_object_detection(out, inputs.input_ids, threshold=self.box_threshold, **kw)[0]
        except TypeError:  # older transformers name the argument box_threshold
            res = self.processor.post_process_grounded_object_detection(out, inputs.input_ids, box_threshold=self.box_threshold, **kw)[0]
        labels = res.get("text_labels", res.get("labels"))
        boxes = []
        for b, s, lab in zip(res["boxes"].cpu().numpy(), res["scores"].cpu().numpy(), labels):
            boxes.append(Box(float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(s), str(lab)))
        return boxes
