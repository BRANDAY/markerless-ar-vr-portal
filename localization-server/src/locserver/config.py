"""Paths and defaults shared by the CLIs and the server."""

from __future__ import annotations

import logging
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PORT = 8077


def maps_dir() -> Path:
    return Path(os.environ.get("LOCSERVER_MAPS_DIR") or PROJECT_ROOT / "data" / "maps")


def calibration_dir() -> Path:
    return Path(os.environ.get("LOCSERVER_CALIB_DIR") or PROJECT_ROOT / "data" / "calibration")


def work_dir() -> Path:
    return Path(os.environ.get("LOCSERVER_WORK") or PROJECT_ROOT / "data" / "work")


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
