"""Paths and defaults shared by the CLIs and the server.

Everything has a project-local default, so a fresh clone works without any
environment variable. The variables only relocate things (see ``env.ps1``).
"""

from __future__ import annotations

import logging
import os
import socket
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8077


def _env_path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name) or default)


def maps_dir() -> Path:
    return _env_path("LOCSERVER_MAPS_DIR", PROJECT_ROOT / "data" / "maps")


def calibration_dir() -> Path:
    return _env_path("LOCSERVER_CALIB_DIR", PROJECT_ROOT / "data" / "calibration")


def work_dir() -> Path:
    return _env_path("LOCSERVER_WORK", PROJECT_ROOT / "data" / "work")


def datasets_dir() -> Path:
    return _env_path("LOCSERVER_DATASETS", PROJECT_ROOT / "data" / "datasets")


def host() -> str:
    return os.environ.get("LOCSERVER_HOST") or DEFAULT_HOST


def port() -> int:
    try:
        return int(os.environ.get("LOCSERVER_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def server_name() -> str:
    """Human-readable name shown in the app: LOCSERVER_NAME or the machine's host name."""
    return os.environ.get("LOCSERVER_NAME") or socket.gethostname() or "locserver"


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
