"""What the monitoring panel shows: connected devices, their logs, the request log, localisations.

Everything is kept in memory in bounded ring buffers (the panel is for watching
a session, not an archive); device log events are also appended to
``<work>/device-logs/<device_id>.jsonl`` so that they can be read afterwards.
The API is described in docs/api-v2.md, section 9.
"""

from __future__ import annotations

import asyncio
import faulthandler
import json
import logging
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import unquote

from .mapstore import check_id

log = logging.getLogger(__name__)

ONLINE_WITHIN_S = 10.0
MAX_BATCH_EVENTS = 200
MAX_BATCH_BYTES = 256 * 1024
MAX_MESSAGE = 500
MAX_DATA_BYTES = 4096
LEVELS = ("debug", "info", "warn", "error")
STEPS = ("connecting", "connected", "scanning", "uploading", "building", "ready", "localizing", "portal_placed", "inside", "error")


def _iso(t: float | None) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None


def _clean(text, limit: int) -> str | None:
    if text is None:
        return None
    text = "".join(ch if ch.isprintable() else " " for ch in str(text)).strip()
    return text[:limit] or None


class BatchTooLarge(Exception):
    pass


class LoopWatchdog:
    """Notices when the server's event loop stops turning and writes down what every thread was doing.

    The event loop answers `/health` and all other light requests; if anything
    blocks it, the server looks dead to the phone although it is running. A task
    on the loop updates a time stamp four times a second; a plain thread checks
    it and, when it is older than ``limit_s``, appends the stack of every thread
    to ``<work>/stalls.log``. The panel shows the count and the longest stall.
    """

    def __init__(self, work_dir: Path | None = None, limit_s: float = 2.0, clock=time.monotonic):
        self.limit_s, self.clock = limit_s, clock
        self.dump_file = Path(work_dir) / "stalls.log" if work_dir else None
        self.beat = clock()
        self.count = 0
        self.longest_s = 0.0
        self.last_utc: str | None = None
        self.last_s: float | None = None
        self._since: float | None = None  # start of the stall that is going on
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    async def heart(self, interval: float = 0.25) -> None:
        while True:
            self.beat = self.clock()
            await asyncio.sleep(interval)

    def check(self) -> None:
        """One look at the time stamp (called twice a second by the thread; directly by tests)."""
        now = self.clock()
        gap = now - self.beat
        if gap > self.limit_s and self._since is None:
            self._since = self.beat
            self.count += 1
            self.last_utc = _iso(time.time())
            log.warning("the server has not answered for %.1f s - thread stacks go to %s", gap, self.dump_file or "stderr")
            self._dump(gap)
        if self._since is not None:
            self.last_s = round(now - self._since if gap > self.limit_s else self.beat - self._since, 1)
            self.longest_s = max(self.longest_s, self.last_s)
            if gap <= self.limit_s:
                log.warning("the server answers again after a stall of %.1f s", self.last_s)
                self._since = None

    def _dump(self, gap: float) -> None:
        try:
            if self.dump_file is None:
                faulthandler.dump_traceback(all_threads=True)
                return
            self.dump_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.dump_file, "a", encoding="utf-8") as fh:
                fh.write(f"\n===== {_iso(time.time())}: event loop silent for {gap:.1f} s - what every thread was doing =====\n")
                fh.flush()
                faulthandler.dump_traceback(file=fh, all_threads=True)
        except Exception:  # the watchdog must never make things worse
            log.exception("could not write the stall report")

    def start(self) -> None:
        if self._thread is None:
            self.beat = self.clock()
            self._thread = threading.Thread(target=self._run, name="loop-watchdog", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(0.5):
            self.check()

    def stop(self) -> None:
        self._stop.set()

    def public(self) -> dict:
        return {"count": self.count, "longest_s": round(self.longest_s, 1), "last_s": self.last_s, "last_utc": self.last_utc,
                "limit_s": self.limit_s, "report": str(self.dump_file) if self.dump_file else None}


class Monitor:
    def __init__(self, work_dir: Path | None = None, max_events: int = 2000, max_feed: int = 4000, max_localizations: int = 200,
                 clock=time.time):
        self.clock = clock
        self.log_dir = Path(work_dir) / "device-logs" if work_dir else None
        self.max_events = max_events
        self._lock = threading.RLock()
        self._next_id = 1
        self.devices: dict[str, dict] = {}
        self.device_events: dict[str, deque] = {}
        self.feed: deque = deque(maxlen=max_feed)  # device events and requests, in arrival order
        self.localizations: deque = deque(maxlen=max_localizations)

    # ------------------------------------------------------------ devices --- #
    def _device(self, device_id: str, address: str | None) -> dict:
        d = self.devices.get(device_id)
        now = self.clock()
        if d is None:
            d = self.devices[device_id] = {
                "device_id": device_id, "name": None, "address": address, "app_version": None, "session_id": None,
                "first_seen": now, "last_seen": now, "requests": 0, "last_request": None, "server_ms": None, "rtt_ms": None,
                "clock_offset_ms": None, "state": {}, "errors": 0, "identified": not device_id.startswith("ip-"),
                "_seq": {},
            }
        d["last_seen"] = now
        if address:
            d["address"] = address
        return d

    @staticmethod
    def resolve_id(header_id: str | None, address: str | None) -> str:
        """The device id of a request: the ``X-Device-Id`` header if valid, else one made from the address."""
        if header_id:
            try:
                return check_id(header_id.strip(), "device id")
            except ValueError:
                pass
        safe = "".join(ch if ch.isalnum() else "-" for ch in (address or "unknown"))
        return f"ip-{safe}"[:64]

    def touch(self, header_id: str | None, address: str | None, method: str, path: str, status: int, ms: float,
              name: str | None = None, session_id: str | None = None, app_version: str | None = None) -> str:
        """Record one handled HTTP request. Returns the device id it was booked on."""
        device_id = self.resolve_id(header_id, address)
        with self._lock:
            d = self._device(device_id, address)
            d["requests"] += 1
            d["last_request"] = f"{method} {path}"
            d["server_ms"] = round(ms, 1)
            self._identity(d, name, session_id, app_version)
            entry = {"id": self._next_id, "kind": "request", "device_id": device_id, "server_time_ms": int(self.clock() * 1000),
                     "method": method, "path": path, "status": int(status), "ms": round(ms, 1)}
            self._next_id += 1
            self.feed.append(entry)
        return device_id

    @staticmethod
    def _identity(d: dict, name, session_id, app_version) -> None:
        if name:
            d["name"] = _clean(unquote(str(name)), 64) or d["name"]
        if app_version:
            d["app_version"] = _clean(app_version, 32) or d["app_version"]
        if session_id:
            try:
                d["session_id"] = check_id(str(session_id).strip(), "session id")
            except ValueError:
                pass

    def public_device(self, d: dict) -> dict:
        now = self.clock()
        out = {k: v for k, v in d.items() if not k.startswith("_") and k not in ("first_seen", "last_seen")}
        out.update(online=(now - d["last_seen"]) <= ONLINE_WITHIN_S, last_seen_utc=_iso(d["last_seen"]),
                   last_seen_age_s=round(now - d["last_seen"], 1), first_seen_utc=_iso(d["first_seen"]))
        return out

    def list_devices(self) -> list[dict]:
        with self._lock:
            return [self.public_device(d) for d in sorted(self.devices.values(), key=lambda d: -d["last_seen"])]

    def forget(self, device_id: str) -> bool:
        with self._lock:
            self.device_events.pop(device_id, None)
            return self.devices.pop(device_id, None) is not None

    # ---------------------------------------------------------------- log --- #
    def ingest(self, device_id: str, body: dict, address: str | None = None) -> dict:
        """Accept one log batch (docs/api-v2.md 9.2). Raises ValueError (422) or BatchTooLarge (413)."""
        check_id(device_id, "device id")
        if not isinstance(body, dict):
            raise ValueError("the body must be a JSON object")
        session = body.get("session_id")
        if not isinstance(session, str) or not session.strip():
            raise ValueError("session_id is required")
        session = check_id(session.strip(), "session_id")
        events = body.get("events")
        if not isinstance(events, list):
            raise ValueError("events must be a list (it may be empty)")
        if len(events) > MAX_BATCH_EVENTS:
            raise BatchTooLarge(f"more than {MAX_BATCH_EVENTS} events in one batch")
        now_ms = int(self.clock() * 1000)
        accepted = duplicates = skipped = 0
        lines = []
        with self._lock:
            d = self._device(device_id, address)
            d["identified"] = True
            self._identity(d, body.get("device_name"), session, body.get("app_version"))
            sent = body.get("sent_at_ms")
            if isinstance(sent, (int, float)) and not isinstance(sent, bool):
                d["clock_offset_ms"] = int(now_ms - sent)
            offset = d["clock_offset_ms"] or 0
            rtt = body.get("rtt_ms")
            if isinstance(rtt, (int, float)) and not isinstance(rtt, bool) and 0 <= rtt < 600_000:
                d["rtt_ms"] = round(float(rtt), 1)
            state = body.get("state")
            if isinstance(state, dict):
                state = {str(k)[:32]: (v if isinstance(v, (int, float, bool)) or v is None else _clean(v, 200)) for k, v in list(state.items())[:16]}
                d["state"] = state
            seqs = d["_seq"]
            last = seqs.get(session, 0)
            ring = self.device_events.setdefault(device_id, deque(maxlen=self.max_events))
            for ev in events:
                if not isinstance(ev, dict) or isinstance(ev.get("seq"), bool) or not isinstance(ev.get("seq"), int) \
                        or not isinstance(ev.get("t_ms"), (int, float)) or _clean(ev.get("message"), MAX_MESSAGE) is None:
                    skipped += 1
                    continue
                if ev["seq"] <= last:
                    duplicates += 1
                    continue
                last = ev["seq"]
                level = ev.get("level") if ev.get("level") in LEVELS else "info"
                data = ev.get("data") if isinstance(ev.get("data"), dict) else None
                if data is not None and len(json.dumps(data, default=str)) > MAX_DATA_BYTES:
                    data = {"dropped": "data larger than 4 kB"}
                entry = {"id": self._next_id, "kind": "device", "device_id": device_id, "session_id": session, "seq": ev["seq"],
                         "t_ms": int(ev["t_ms"]), "server_time_ms": int(ev["t_ms"] + offset), "level": level,
                         "type": _clean(ev.get("type"), 24) or "app", "message": _clean(ev["message"], MAX_MESSAGE), "data": data}
                self._next_id += 1
                ring.append(entry)
                self.feed.append(entry)
                lines.append(entry)
                accepted += 1
                d["errors"] += level == "error"
            seqs[session] = last
            while len(seqs) > 8:
                seqs.pop(next(iter(seqs)))
        if lines and self.log_dir is not None:
            try:
                self.log_dir.mkdir(parents=True, exist_ok=True)
                with open(self.log_dir / f"{device_id}.jsonl", "a", encoding="utf-8") as fh:
                    fh.writelines(json.dumps(e, ensure_ascii=False) + "\n" for e in lines)
            except OSError:
                pass
        return {"accepted": accepted, "duplicates": duplicates, "skipped": skipped, "last_seq": last, "server_time_ms": now_ms}

    def device_log(self, device_id: str, after: int = 0, limit: int = 500) -> dict:
        with self._lock:
            ring = self.device_events.get(device_id, ())
            ev = [e for e in ring if e["id"] > after][-max(1, min(limit, self.max_events)):]
            return {"device_id": device_id, "events": ev, "last_id": ev[-1]["id"] if ev else after}

    def feed_after(self, after: int = 0, limit: int = 500) -> dict:
        """Device events and requests newer than ``after``, oldest first."""
        with self._lock:
            ev = [e for e in self.feed if e["id"] > after][-max(1, min(limit, 2000)):]
            return {"entries": ev, "last_id": self._next_id - 1}

    # ------------------------------------------------------ localisations --- #
    def record_localization(self, rec: dict) -> None:
        with self._lock:
            self.localizations.append({"id": self._next_id, "server_time_ms": int(self.clock() * 1000), **rec})
            self._next_id += 1

    def recent_localizations(self, n: int = 30) -> list[dict]:
        with self._lock:
            return list(self.localizations)[-n:][::-1]

    def last_localization(self, map_id: str | None = None, device_id: str | None = None, success_only: bool = False) -> dict | None:
        with self._lock:
            for rec in reversed(self.localizations):
                if (map_id is None or rec.get("map_id") == map_id) and (device_id is None or rec.get("device_id") == device_id) \
                        and (rec.get("success") or not success_only):
                    return rec
        return None


# ------------------------------------------------------------------ flow --- #
def pick_device(devices: list[dict], prefer: str | None = None) -> dict | None:
    """The device the flow strip follows: the one asked for, else the most telling one that is online."""
    chosen = next((d for d in devices if d["device_id"] == prefer), None) if prefer else None
    if chosen is None and devices:  # `devices` is ordered newest first; a stable sort keeps that within a rank
        chosen = min(devices, key=lambda d: (not d["online"], not (d.get("state") or {}).get("step"), not d.get("identified")))
    return chosen


def usage_flow(devices: list[dict], maps: list[dict], jobs: list[dict], monitor: Monitor, prefer_device: str | None = None) -> dict:
    """Where the scenario stands (connect -> scan -> build -> doorway -> localise -> portal) and what to do next.

    Derived from what the server knows itself (requests, jobs, maps, localisations)
    plus the ``state.step`` the device reports.
    """
    dev = pick_device(devices, prefer_device)
    step = (dev or {}).get("state", {}).get("step")
    running = next((j for j in jobs if j["state"] in ("running", "queued")), None)
    last_build = next((j for j in jobs if j["kind"] == "build_map"), None)
    map_id = (dev or {}).get("state", {}).get("map_id") or (running or {}).get("map_id") or (last_build or {}).get("map_id")
    by_id = {m["map_id"]: m for m in maps}
    if map_id not in by_id:
        newest = sorted(maps, key=lambda m: (m.get("room_status", "unavailable") != "unavailable", str(m.get("created_utc") or "")))
        map_id = newest[-1].get("map_id") if newest and not running else map_id
    m = by_id.get(map_id)
    loc = monitor.last_localization(map_id, (dev or {}).get("device_id")) if m else None
    after_scan = ("uploading", "building", "ready", "localizing", "portal_placed", "inside")

    def item(key, title, status, detail):
        return {"key": key, "title": title, "status": status, "detail": detail}

    steps = []
    if dev is None:
        steps.append(item("connect", "Connect the phone", "active", "no device has contacted the server yet"))
    elif dev["online"]:
        steps.append(item("connect", "Connect the phone", "done", f"{dev.get('name') or dev['device_id']} at {dev.get('address')}"))
    else:
        steps.append(item("connect", "Connect the phone", "problem", f"{dev.get('name') or dev['device_id']} was last seen {dev['last_seen_age_s']:.0f} s ago"))
    scanned = bool(m) or bool(running) or step in after_scan
    steps.append(item("scan", "Scan the room", "done" if scanned else "active" if step == "scanning" else "todo",
                      (dev or {}).get("state", {}).get("detail") if step == "scanning" else "recording uploaded" if scanned else "walk through the room while recording"))
    if running:
        pct = f"{running['progress'] * 100:.0f} %"
        steps.append(item("build", "Build the map", "active", f"{running.get('stage') or 'queued'} - {pct}" + (f", about {running['eta_s']} s left" if running.get("eta_s") else "")))
    elif last_build and last_build["state"] == "failed" and not m:
        steps.append(item("build", "Build the map", "problem", (last_build.get("error") or {}).get("message", "the build failed")))
    else:
        steps.append(item("build", "Build the map", "done" if m else "todo", f"map {map_id}: {m.get('num_images')} images" if m else "starts after the upload"))
    if m and not running:
        src = m.get("portal_source", "none")
        if src != "none":
            steps.append(item("doorway", "Find the doorway", "done", f"portal from: {src}"))
        else:
            steps.append(item("doorway", "Find the doorway", "problem", "no doorway found - place the portal by hand in the app, or scan again with the whole door in view"))
    else:
        steps.append(item("doorway", "Find the doorway", "todo", "computed at the end of the build"))
    placed = step in ("portal_placed", "inside")
    if loc and loc.get("success"):
        steps.append(item("localize", "Localise the phone", "done", f"{loc.get('quality')}, {loc.get('num_inliers')} inliers"))
    elif loc or step == "localizing":
        steps.append(item("localize", "Localise the phone", "active" if not loc else "problem", (loc or {}).get("reason") or "waiting for an accepted result"))
    else:
        steps.append(item("localize", "Localise the phone", "done" if placed else "todo", "the app sends camera frames with AR poses"))
    steps.append(item("portal", "Portal in place", "done" if placed else "todo",
                      "the user is inside the virtual room" if step == "inside" else "doorway shown in AR" if placed else "reported by the app"))
    nxt = next((s for s in steps if s["status"] != "done"), None)
    hints = {
        "connect": "Start the app on the phone (same Wi-Fi) and enter one of the addresses above, or use Find automatically.",
        "scan": "In the app, record the room: walk slowly in an arc, show every wall, the floor edges and the whole door.",
        "build": "Wait for the build to finish - progress is shown under Jobs.",
        "doorway": "Check the room plan below. If the door is missing, scan again or place the portal by hand.",
        "localize": "Point the phone at a part of the room that was scanned; hold still for a moment.",
        "portal": "Walk to the doorway shown in AR.",
    }
    return {"device_id": (dev or {}).get("device_id"), "map_id": map_id, "steps": steps,
            "next": hints[nxt["key"]] if nxt else "Everything is in place - walk through the portal.",
            "device_step": step}
