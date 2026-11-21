"""Wi-Fi tells only which room; the place is found from the picture, and everything works without Wi-Fi."""

from __future__ import annotations

import json

import numpy as np
import pytest

from locserver import geometry as g
from locserver import wifihint
from test_staff_door import build, jpeg, make_server

HALL = [{"bssid": "AA:BB:CC:00:00:01", "ssid": "museum", "rssi": -48}, {"bssid": "aa:bb:cc:00:00:02", "rssi": -60},
        {"bssid": "aa-bb-cc-00-00-03", "rssi": -75}]
SIDE = [{"bssid": "aa:bb:cc:00:00:03", "rssi": -50}, {"bssid": "aa:bb:cc:00:00:04", "rssi": -55},
        {"bssid": "aa:bb:cc:00:00:01", "rssi": -88}]
ELSEWHERE = [{"bssid": "11:22:33:00:00:01", "rssi": -50}]


# ------------------------------------------------------------------ the maths --- #
def test_networks_are_read_and_names_are_dropped():
    got = wifihint.parse(HALL)
    assert got == {"aa:bb:cc:00:00:01": -48.0, "aa:bb:cc:00:00:02": -60.0, "aa:bb:cc:00:00:03": -75.0}
    assert wifihint.parse({"networks": ["AABBCC000009"]}) == {"aa:bb:cc:00:00:09": None}
    # the address Android gives when it hides the real one says nothing
    assert wifihint.parse([{"bssid": "02:00:00:00:00:00", "rssi": -40}, {"bssid": "aa:bb:cc:00:00:01", "rssi": -70},
                           {"bssid": "aa:bb:cc:00:00:01", "rssi": -50}]) == {"aa:bb:cc:00:00:01": -50.0}
    for bad in ("x", [{"ssid": "no address"}], [{"bssid": "aa:bb:cc"}], [{"bssid": "aa:bb:cc:00:00:01", "rssi": 20}],
                [{"bssid": "aa:bb:cc:00:00:01", "rssi": "strong"}], ["zz:bb:cc:00:00:01"], [{"bssid": "aa:bb:cc:00:00:01"}] * 201):
        with pytest.raises(ValueError):
            wifihint.parse(bad)


def test_the_fingerprint_keeps_the_strongest_signal_and_no_names():
    fp = wifihint.merge(None, wifihint.parse(HALL), "t1")
    fp = wifihint.merge(fp, wifihint.parse([{"bssid": "aa:bb:cc:00:00:02", "rssi": -52}, {"bssid": "aa:bb:cc:00:00:07", "rssi": -80}]), "t2")
    assert fp["scans"] == 2 and fp["updated_utc"] == "t2" and fp["networks"]["aa:bb:cc:00:00:02"] == -52.0 and len(fp["networks"]) == 4
    assert "museum" not in json.dumps(fp)
    assert wifihint.public(fp) == {"networks": 4, "scans": 2, "updated_utc": "t2"} and wifihint.public(None) is None
    assert wifihint.merge(fp, wifihint.parse(ELSEWHERE), "t3", replace=True)["networks"] == {"11:22:33:00:00:01": -50.0}
    many = wifihint.parse([{"bssid": f"aa:bb:cc:00:01:{i:02x}", "rssi": -40 - i * 0.5} for i in range(100)])
    kept = wifihint.merge(None, many, "t")["networks"]
    assert len(kept) == wifihint.MAX_NETWORKS_PER_ROOM and "aa:bb:cc:00:01:00" in kept and "aa:bb:cc:00:01:63" not in kept


def test_rooms_are_ordered_by_what_the_phone_sees_and_unknown_rooms_stay_possible():
    hall, side = wifihint.merge(None, wifihint.parse(HALL), "t"), wifihint.merge(None, wifihint.parse(SIDE), "t")
    rooms = [{"map_id": "attic", "wifi": None, "visual": 0.9}, {"map_id": "side", "wifi": side, "visual": 0.2},
             {"map_id": "hall", "wifi": hall, "visual": 0.1}, {"map_id": "far", "wifi": wifihint.merge(None, wifihint.parse(ELSEWHERE), "t"), "visual": 0.95}]
    # a visitor standing in the hall sees about what the staff phone saw there
    seen = wifihint.parse([{"bssid": "aa:bb:cc:00:00:01", "rssi": -52}, {"bssid": "aa:bb:cc:00:00:02", "rssi": -63}, {"bssid": "aa:bb:cc:00:00:03", "rssi": -79}])
    got = wifihint.order(rooms, seen)
    assert [c["map_id"] for c in got] == ["hall", "side", "attic", "far"]
    assert got[0]["wifi_score"] > got[1]["wifi_score"] > 0 and got[0]["wifi_matched"] == 3
    assert got[2]["wifi_score"] is None and got[3]["wifi_score"] == 0.0  # no fingerprint: possible; another place: last
    # the same access points seen from the side room turn the order round
    assert [c["map_id"] for c in wifihint.order(rooms, wifihint.parse(SIDE))][:2] == ["side", "hall"]
    # nothing sent: the picture alone decides
    assert [c["map_id"] for c in wifihint.order(rooms, None)] == ["far", "attic", "side", "hall"]
    assert all(c["wifi_score"] is None for c in wifihint.order(rooms, {}))
