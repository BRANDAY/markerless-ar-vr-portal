"""Stage "connectivity": server identity, start-up banner and the read-only doctor."""

import socket
import threading

import pytest

from conftest import StubLocalizer, StubPipe
from locserver import API_VERSION, SERVICE_ID, __version__, config, doctor, netinfo


# ------------------------------------------------------------------ health --- #
def test_health_identity_contract(api):
    h = api.get("/health").json()
    assert h["status"] == "ok"
    assert h["service"] == "arportal-localization-server" == SERVICE_ID
    assert h["api_version"] == 1 == API_VERSION and isinstance(h["api_version"], int)
    assert h["server_version"] == __version__
    assert isinstance(h["server_name"], str) and h["server_name"]
    for old in ("version", "device", "models", "maps", "sessions", "uptime_s"):  # fields from stage 1 are kept
        assert old in h


def test_health_works_without_any_map_and_with_custom_name(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from locserver.server import State, create_app

    state = State(tmp_path / "no_maps_here", pipe=StubPipe(), localizer=StubLocalizer(),
                  calibration_dir=tmp_path / "calib", server_name="Lab laptop", work_dir=tmp_path / "work")
    h = TestClient(create_app(state)).get("/health").json()
    assert h["status"] == "ok" and h["maps"] == [] and h["server_name"] == "Lab laptop"

    monkeypatch.setenv("LOCSERVER_NAME", "from-env")
    assert config.server_name() == "from-env"
    monkeypatch.delenv("LOCSERVER_NAME")
    assert config.server_name() == socket.gethostname()


def test_health_does_not_wait_for_a_running_localisation(api):
    """A subnet scan must get its answer even while the GPU lock is held."""
    with api.state_obj.gpu_lock:
        assert api.get("/health").json()["service"] == SERVICE_ID


def test_host_and_port_from_environment(monkeypatch):
    monkeypatch.setenv("LOCSERVER_PORT", "9123")
    monkeypatch.setenv("LOCSERVER_HOST", "127.0.0.1")
    assert config.port() == 9123 and config.host() == "127.0.0.1"
    monkeypatch.setenv("LOCSERVER_PORT", "not a number")
    assert config.port() == config.DEFAULT_PORT == 8077
    monkeypatch.delenv("LOCSERVER_HOST")
    assert config.host() == "0.0.0.0"


def test_default_paths_are_inside_the_project(monkeypatch):
    for var in ("LOCSERVER_MAPS_DIR", "LOCSERVER_CALIB_DIR", "LOCSERVER_WORK", "LOCSERVER_DATASETS"):
        monkeypatch.delenv(var, raising=False)
    for p in (config.maps_dir(), config.calibration_dir(), config.work_dir(), config.datasets_dir()):
        assert config.PROJECT_ROOT in p.parents
    monkeypatch.setenv("LOCSERVER_MAPS_DIR", "D:/elsewhere/maps")
    assert config.maps_dir().as_posix() == "D:/elsewhere/maps"


# ------------------------------------------------------------------ banner --- #
def test_filter_lan_drops_unusable_addresses_and_orders_them():
    got = netinfo.filter_lan(["127.0.0.1", "169.254.10.3", "10.0.0.5", "192.168.1.60", "0.0.0.0", "garbage",
                              "172.20.16.1", "192.168.1.60", "8.8.8.8"])
    assert got == ["192.168.1.60", "10.0.0.5", "172.20.16.1", "8.8.8.8"]


def test_lan_addresses_of_this_machine_are_well_formed():
    for a in netinfo.lan_ipv4_addresses():
        assert not a.startswith(("127.", "169.254.")) and len(a.split(".")) == 4


def test_banner_lists_every_lan_url():
    text = "\n".join(netinfo.banner_lines("0.0.0.0", 8077, ["192.168.1.50", "192.168.1.60"], "PC"))
    assert "http://192.168.1.50:8077" in text and "http://192.168.1.60:8077" in text
    assert "Find automatically" in text and "/health" in text and SERVICE_ID in text


def test_banner_for_a_specific_or_loopback_host_and_without_network():
    one = "\n".join(netinfo.banner_lines("10.0.0.5", 9000, ["192.168.1.50"], "PC"))
    assert "http://10.0.0.5:9000" in one and "192.168.1.50" not in one
    loop = "\n".join(netinfo.banner_lines("127.0.0.1", 8077, ["192.168.1.50"], "PC"))
    assert "this PC only" in loop and "--host 0.0.0.0" in loop and "192.168.1.50" not in loop
    none = "\n".join(netinfo.banner_lines("0.0.0.0", 8077, [], "PC"))
    assert "No LAN address" in none


def test_port_open_and_probe_against_a_local_socket():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]

    def answer():
        conn, _ = srv.accept()  # first connection: port_open
        conn.close()
        conn, _ = srv.accept()  # second: probe_health gets something that is not our service
        conn.recv(1024)
        body = b'{"status": "ok", "service": "something-else"}'
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        conn.close()

    t = threading.Thread(target=answer, daemon=True)
    t.start()
    assert netinfo.port_open("127.0.0.1", port)
    health = netinfo.probe_health("127.0.0.1", port)
    assert health == {"status": "ok", "service": "something-else"} and not netinfo.is_our_server(health)
    t.join(2)
    srv.close()
    assert not netinfo.port_open("127.0.0.1", port, timeout=0.3)
    assert netinfo.probe_health("127.0.0.1", port, timeout=0.3) is None
    assert netinfo.is_our_server({"service": SERVICE_ID}) and not netinfo.is_our_server(None)


# ------------------------------------------------------------------ doctor --- #
EXE = r"C:\Python313\python.exe"
OUR_HEALTH = {"service": SERVICE_ID, "api_version": 1, "server_version": "0.2.0", "server_name": "PC", "maps": ["room"]}


def facts(**over):
    base = {
        "platform": "Windows", "port": 8077, "python_exe": EXE, "addresses": ["192.168.1.50"],
        "listening_loopback": True, "listening_lan": {"192.168.1.50": True}, "health": OUR_HEALTH,
        "windows": {
            "rules_readable": True,
            "profiles": [{"interface": "Wi-Fi", "network": "HomeNet", "category": "Public"}],
            "addresses": [{"ip": "192.168.1.50", "interface": "Wi-Fi", "prefix": 24}],
            "fw_profiles": [{"name": "Domain", "enabled": True}, {"name": "Private", "enabled": True}, {"name": "Public", "enabled": True}],
            "rules": [],
        },
    }
    base.update(over)
    return base


def rule(**over):
    r = {"name": "{id}", "display": "some rule", "enabled": True, "action": "Allow", "profile": "Any",
         "protocol": "TCP", "local_port": "8077", "remote": "LocalSubnet", "program": "Any"}
    r.update(over)
    return r


def problems(fs):
    return [f for f in fs if f.level == "problem"]


def test_doctor_public_network_without_rule_recommends_profile_any_rule():
    fs = doctor.evaluate(facts())
    p = problems(fs)
    assert len(p) == 1 and "Public" in p[0].text
    assert p[0].fix == ('New-NetFirewallRule -DisplayName "AR Portal localization server (TCP 8077)" -Direction Inbound '
                        "-Protocol TCP -LocalPort 8077 -Action Allow -Profile Any -RemoteAddress LocalSubnet")
    assert "-Profile Private would not apply" in p[0].text
    assert any('Remove-NetFirewallRule -DisplayName "AR Portal localization server (TCP 8077)"' in f.text for f in fs)
    assert any(f.level == "ok" and "is running" in f.text for f in fs)
    assert any("http://192.168.1.50:8077/health" in f.text for f in fs)


def test_doctor_private_only_rule_does_not_help_on_a_public_network():
    w = facts()["windows"] | {"rules": [rule(profile="Private", display="old README rule")]}
    assert len(problems(doctor.evaluate(facts(windows=w)))) == 1
    w = facts()["windows"] | {"rules": [rule(profile="Private, Public")]}
    assert problems(doctor.evaluate(facts(windows=w))) == []
    w = facts()["windows"] | {"rules": [rule(profile="Private")], "profiles": [{"interface": "Wi-Fi", "network": "Home", "category": "Private"}]}
    assert problems(doctor.evaluate(facts(windows=w))) == []


def test_doctor_rule_matching_by_port_range_program_and_state():
    def ok(**r):
        return problems(doctor.evaluate(facts(windows=facts()["windows"] | {"rules": [rule(**r)]}))) == []

    assert ok(local_port="8000-8100") and ok(local_port="80,8077") and ok(local_port="Any", program=EXE.upper())
    assert not ok(local_port="8078") and not ok(local_port="9000-9100")
    assert not ok(enabled=False) and not ok(protocol="UDP")
    assert not ok(local_port="Any", program=r"C:\Other\python.exe")


def test_doctor_block_rule_for_python_wins_over_allow():
    rules = [rule(), rule(name="{blk}", display="python.exe", action="Block", local_port="Any", program=EXE, remote="Any")]
    fs = doctor.evaluate(facts(windows=facts()["windows"] | {"rules": rules}))
    p = problems(fs)
    assert len(p) == 1 and "BLOCKS" in p[0].text and p[0].fix == "Disable-NetFirewallRule -Name '{blk}'"


def test_doctor_firewall_off_unreadable_and_non_windows():
    w = facts()["windows"] | {"fw_profiles": [{"name": "Public", "enabled": False}]}
    fs = doctor.evaluate(facts(windows=w))
    assert problems(fs) == [] and any("switched off" in f.text for f in fs)
    fs = doctor.evaluate(facts(windows=None))
    assert problems(fs) == [] and any(f.level == "warn" and f.fix and "New-NetFirewallRule" in f.fix for f in fs)
    fs = doctor.evaluate(facts(windows=facts()["windows"] | {"rules_readable": False}))
    assert any(f.level == "warn" and "could not be listed" in f.text for f in fs)
    fs = doctor.evaluate(facts(platform="Linux", windows=None))
    assert any("firewall checks skipped" in f.text for f in fs)


def test_doctor_server_states():
    fs = doctor.evaluate(facts(listening_loopback=False, listening_lan={}, health=None))
    assert any(f.level == "warn" and f.fix == "uv run locserver-serve" for f in fs)
    fs = doctor.evaluate(facts(health={"service": "other"}))
    assert any(f.level == "problem" and "another program" in f.text for f in fs)
    fs = doctor.evaluate(facts(listening_lan={"192.168.1.50": False}))
    assert any(f.level == "problem" and f.fix == "uv run locserver-serve --host 0.0.0.0" for f in fs)
    fs = doctor.evaluate(facts(addresses=[], listening_lan={}))
    assert any(f.level == "problem" and "no LAN IPv4 address" in f.text for f in fs)


def test_doctor_report_and_no_mutating_commands():
    text = doctor.format_report(doctor.evaluate(facts()))
    assert "[FIX ]" in text and "1 problem(s) found. Nothing was changed on this PC." in text
    # the PowerShell the doctor itself runs must be read-only
    for verb in ("New-", "Set-", "Remove-", "Enable-", "Disable-", "netsh", "Start-", "Stop-"):
        assert verb not in doctor._PS_QUERY
    assert "Get-NetFirewallRule" in doctor._PS_QUERY and "Get-NetConnectionProfile" in doctor._PS_QUERY


@pytest.mark.skipif(not hasattr(socket, "AF_INET"), reason="no IPv4")
def test_doctor_gather_runs_without_admin_rights():
    f = doctor.gather(port=1)  # nothing listens on port 1
    assert f["listening_loopback"] is False and f["health"] is None and f["port"] == 1
    assert isinstance(f["addresses"], list) and isinstance(doctor.evaluate(f), list)
