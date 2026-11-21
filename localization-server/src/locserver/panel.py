"""Open the monitoring panel of a running server in its own desktop window.

    uv run locserver-panel                 # the server on this PC, default port
    uv run locserver-panel --port 8078
    uv run locserver-panel --url http://192.168.1.50:8077

The panel is the page the server itself serves at ``/ui``. This command only
opens it: in an "app window" of Microsoft Edge or Google Chrome (no tabs, no
address bar) when one of them is installed, otherwise in the default browser.
Nothing is installed and nothing is downloaded.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from . import SERVICE_ID, config

WINDOW_SIZE = "1500,950"


def find_app_browser() -> str | None:
    """Path of a Chromium-based browser that supports ``--app=<url>``, or None."""
    names = ["msedge", "chrome", "google-chrome", "chromium", "chromium-browser", "microsoft-edge"]
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    candidates = []
    for root in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if root:
            candidates += [Path(root) / "Microsoft/Edge/Application/msedge.exe", Path(root) / "Google/Chrome/Application/chrome.exe"]
    candidates += [Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                   Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    return next((str(p) for p in candidates if p.is_file()), None)


def check_server(base_url: str, timeout: float = 3.0) -> tuple[bool, str]:
    """Is a localisation server with a panel answering at ``base_url``? Returns (ok, message)."""
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=timeout) as resp:
            health = json.load(resp)
    except (urllib.error.URLError, OSError, ValueError) as e:
        reason = getattr(e, "reason", e)
        return False, f"no answer from {base_url} ({reason}). Start the server first:  uv run locserver-serve"
    if health.get("service") != SERVICE_ID:
        return False, f"{base_url} answers, but it is not a localisation server"
    if "monitor_ui" not in (health.get("capabilities") or []):
        return False, (f"the server at {base_url} (version {health.get('version')}) is older than the panel. "
                       "Stop it and start the current code:  uv run locserver-serve")
    return True, f"{health.get('server_name') or 'server'} {health.get('version')} at {base_url}"


def open_panel(url: str, browser: str | None = None, app_window: bool = True) -> str:
    """Open ``url``; returns a line saying how it was opened."""
    exe = browser or (find_app_browser() if app_window else None)
    if exe and app_window:
        try:
            flags = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}
            subprocess.Popen([exe, f"--app={url}", f"--window-size={WINDOW_SIZE}"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **flags)
            return f"opened {url} in a window of {Path(exe).stem}"
        except OSError:
            pass
    if webbrowser.open(url):
        return f"opened {url} in the default browser"
    return f"could not start a browser - open {url} by hand"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Open the monitoring panel of the localisation server in a desktop window.")
    ap.add_argument("--url", help="address of the server, e.g. http://192.168.1.50:8077 (default: this PC)")
    ap.add_argument("--port", type=int, default=None, help=f"port of the server on this PC (default {config.port()})")
    ap.add_argument("--browser", help="path of the browser to use (default: Edge or Chrome if installed)")
    ap.add_argument("--tab", action="store_true", help="open an ordinary tab of the default browser instead of a separate window")
    ap.add_argument("--no-check", action="store_true", help="open the window even if the server does not answer")
    a = ap.parse_args(argv)

    base = (a.url or f"http://127.0.0.1:{a.port or config.port()}").rstrip("/")
    if base.endswith("/ui"):
        base = base[:-3]
    if "://" not in base:
        base = "http://" + base
    if not a.no_check:
        ok, message = check_server(base)
        print(message)
        if not ok:
            return 1
    print(open_panel(f"{base}/ui", a.browser, app_window=not a.tab))
    return 0


if __name__ == "__main__":
    sys.exit(main())
