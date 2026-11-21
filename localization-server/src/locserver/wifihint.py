"""Wi-Fi as a hint for *which room* - nothing more.

Owner's decision (2026-11-21): the visible Wi-Fi networks tell only in which
room a phone probably is; where the phone stands is found from the picture
alone. So this module orders candidate rooms and does nothing else, and
everything works without it (rooms are then tried by visual similarity).

A room's fingerprint is the set of access points (BSSID) the staff phone saw
there, each with the strongest signal seen. Network names (SSID) are not kept:
they are not needed for the comparison and may be personal.

Kept free of FastAPI.
"""

from __future__ import annotations

import re

MAX_NETWORKS_PER_REQUEST = 200
MAX_NETWORKS_PER_ROOM = 64
_BSSID = re.compile(r"^[0-9a-f]{2}([:-]?)[0-9a-f]{2}(\1[0-9a-f]{2}){4}$")
RSSI_FLOOR, RSSI_TOP = -95.0, -45.0   # dBm: weakest signal that still counts, signal that counts fully
UNKNOWN_WEIGHT = 0.5                   # a network sent without rssi
MIN_SCORE = 0.02                       # below this a room with a fingerprint counts as "not here"


def _weight(rssi) -> float:
    if rssi is None:
        return UNKNOWN_WEIGHT
    x = (float(rssi) - RSSI_FLOOR) / (RSSI_TOP - RSSI_FLOOR)
    return min(1.0, max(0.05, x))


def parse(networks, what: str = "wifi") -> dict[str, float | None]:
    """``{bssid: rssi|None}`` from what a phone sends: a list of ``{"bssid": "..", "rssi": -52}`` (or of plain BSSIDs).

    Anything else in an entry (``ssid``, ``frequency``...) is ignored. Raises ``ValueError``.
    """
    if isinstance(networks, dict):
        networks = networks.get("networks")
    if not isinstance(networks, list):
        raise ValueError(f"{what}: a list of networks, each {{\"bssid\": \"aa:bb:cc:dd:ee:ff\", \"rssi\": -52}}")
    if len(networks) > MAX_NETWORKS_PER_REQUEST:
        raise ValueError(f"{what}: at most {MAX_NETWORKS_PER_REQUEST} networks")
    out: dict[str, float | None] = {}
    for i, n in enumerate(networks):
        bssid, rssi = (n.get("bssid"), n.get("rssi")) if isinstance(n, dict) else (n, None)
        if not isinstance(bssid, str) or not _BSSID.match(bssid.strip().lower()):
            raise ValueError(f"{what}[{i}].bssid: six pairs of hex digits, e.g. aa:bb:cc:dd:ee:ff")
        key = re.sub(r"[^0-9a-f]", "", bssid.lower())
        key = ":".join(key[j:j + 2] for j in range(0, 12, 2))
        if key in ("00:00:00:00:00:00", "02:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
            continue  # what Android reports when it hides the real address
        if rssi is not None:
            if isinstance(rssi, bool) or not isinstance(rssi, (int, float)) or not -130 <= rssi <= 0:
                raise ValueError(f"{what}[{i}].rssi: signal strength in dBm, a number from -130 to 0")
            rssi = float(rssi)
        old = out.get(key)
        out[key] = rssi if key not in out or (rssi is not None and (old is None or rssi > old)) else old
    return out


def merge(stored: dict | None, seen: dict[str, float | None], now: str, replace: bool = False) -> dict:
    """The room's fingerprint after one more scan of the staff phone (strongest signal per network wins)."""
    nets: dict[str, float | None] = {} if replace or not stored else dict(stored.get("networks") or {})
    for b, r in seen.items():
        old = nets.get(b)
        nets[b] = r if b not in nets or (r is not None and (old is None or r > old)) else old
    keep = sorted(nets.items(), key=lambda kv: -_weight(kv[1]))[:MAX_NETWORKS_PER_ROOM]
    scans = 1 if replace or not stored else int(stored.get("scans") or 0) + 1
    return {"networks": dict(keep), "scans": scans, "updated_utc": now}


def score(room: dict | None, seen: dict[str, float | None]) -> tuple[float | None, int]:
    """``(similarity 0..1, networks in common)``; ``(None, 0)`` when the room has no fingerprint or nothing was sent.

    Weighted Jaccard: a network both sides see strongly counts much, one that
    only one side sees counts against. Rooms of one building share access
    points; the signal strengths are what tells neighbours apart - roughly.
    """
    nets = (room or {}).get("networks") or {}
    if not nets or not seen:
        return None, 0
    common = set(nets) & set(seen)
    num = sum(min(_weight(nets[b]), _weight(seen[b])) for b in common)
    den = sum(max(_weight(nets.get(b)) if b in nets else 0.0, _weight(seen.get(b)) if b in seen else 0.0) for b in set(nets) | set(seen))
    return (round(num / den, 4) if den else 0.0), len(common)


def order(rooms: list[dict], seen: dict[str, float | None] | None) -> list[dict]:
    """Candidate rooms, most likely first. ``rooms``: ``{"map_id", "wifi": fingerprint|None, "visual": float|None}``.

    1. rooms whose fingerprint matches, by similarity;
    2. rooms without a fingerprint (nothing is known - they stay possible);
    3. rooms whose fingerprint does not match at all.
    Inside a group, and everywhere when no networks were sent, the visual similarity decides.
    """
    out = []
    for r in rooms:
        s, n = score(r.get("wifi"), seen or {})
        group = 1 if s is None else 0 if s >= MIN_SCORE else 2
        out.append({"map_id": r["map_id"], "wifi_score": s, "wifi_matched": n, "visual_score": r.get("visual"), "_group": group})
    out.sort(key=lambda c: (c["_group"], -(c["wifi_score"] or 0.0) if c["_group"] == 0 else 0.0, -(c["visual_score"] or 0.0), c["map_id"]))
    for c in out:
        del c["_group"]
    return out


def public(stored: dict | None) -> dict | None:
    """What the API tells about a room's fingerprint: how much there is, never the addresses."""
    if not stored or not stored.get("networks"):
        return None
    return {"networks": len(stored["networks"]), "scans": stored.get("scans"), "updated_utc": stored.get("updated_utc")}
