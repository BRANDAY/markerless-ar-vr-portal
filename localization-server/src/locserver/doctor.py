"""CLI: read-only connectivity check for "the phone cannot reach the server".

    uv run locserver-doctor            # port 8077
    uv run locserver-doctor --port 9000

It lists this PC's LAN addresses, tells whether the server is listening, shows
the Windows network profile of each active connection and whether the Windows
firewall lets the port in, and prints the exact command for whatever is
missing. It never changes a system setting: the commands are for you to run.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from dataclasses import dataclass

from . import SERVICE_ID, config, netinfo

RULE_NAME = "AR Portal localization server (TCP {port})"
ADD_RULE = (
    'New-NetFirewallRule -DisplayName "' + RULE_NAME + '" -Direction Inbound -Protocol TCP '
    "-LocalPort {port} -Action Allow -Profile Any -RemoteAddress LocalSubnet"
)
REMOVE_RULE = 'Remove-NetFirewallRule -DisplayName "' + RULE_NAME + '"'

# One read-only PowerShell call that returns everything as JSON. Only Get-* cmdlets.
_PS_QUERY = r"""
$ErrorActionPreference = 'SilentlyContinue'
$port = __PORT__
$exe = '__EXE__'
function Test-Port($lp) {
  foreach ($p in @($lp)) {
    if ("$p" -eq "$port") { return $true }
    if ("$p" -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le $port -and [int]$Matches[2] -ge $port) { return $true }
  }
  return $false
}
$r = @{ rules_readable = $true }
$r.profiles = @(Get-NetConnectionProfile | ForEach-Object { @{ interface = $_.InterfaceAlias; network = $_.Name; category = "$($_.NetworkCategory)" } })
$r.addresses = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { @{ ip = $_.IPAddress; interface = $_.InterfaceAlias; prefix = $_.PrefixLength } })
$r.fw_profiles = @(Get-NetFirewallProfile | ForEach-Object { @{ name = "$($_.Name)"; enabled = ("$($_.Enabled)" -eq 'True') } })
$ids = @{}
$pfs = Get-NetFirewallPortFilter
if ($null -eq $pfs) { $r.rules_readable = $false }
foreach ($pf in $pfs) { if ("$($pf.Protocol)" -eq 'TCP' -and (Test-Port $pf.LocalPort)) { $ids[$pf.InstanceID] = 1 } }
foreach ($af in Get-NetFirewallApplicationFilter) { if ("$($af.Program)" -ieq $exe) { $ids[$af.InstanceID] = 1 } }
$r.rules = @()
foreach ($id in $ids.Keys) {
  $rule = Get-NetFirewallRule -Name $id
  if ($null -eq $rule -or "$($rule.Direction)" -ne 'Inbound') { continue }
  $pf = $rule | Get-NetFirewallPortFilter
  $adf = $rule | Get-NetFirewallAddressFilter
  $apf = $rule | Get-NetFirewallApplicationFilter
  $r.rules += @{ name = $rule.Name; display = $rule.DisplayName; enabled = ("$($rule.Enabled)" -eq 'True');
                 action = "$($rule.Action)"; profile = "$($rule.Profile)"; protocol = "$($pf.Protocol)";
                 local_port = (@($pf.LocalPort) -join ','); remote = (@($adf.RemoteAddress) -join ','); program = "$($apf.Program)" }
}
$r | ConvertTo-Json -Depth 5 -Compress
"""


@dataclass
class Finding:
    level: str  # "ok" | "info" | "warn" | "problem"
    text: str
    fix: str | None = None  # a command for the user to run (never run by the doctor)


def query_windows(port: int, exe: str, timeout: float = 90.0) -> dict | None:
    """Network profile and firewall facts from PowerShell; None if they cannot be read."""
    script = _PS_QUERY.replace("__PORT__", str(int(port))).replace("__EXE__", exe.replace("'", "''"))
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, text=True, timeout=timeout,
        )
        start = p.stdout.find("{")
        return json.loads(p.stdout[start:]) if start >= 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def gather(port: int) -> dict:
    """All facts the verdict is based on. Nothing here modifies the system."""
    exe = getattr(sys, "_base_executable", None) or sys.executable  # the process Windows sees
    addresses = netinfo.lan_ipv4_addresses()
    loopback = netinfo.port_open("127.0.0.1", port)
    facts = {
        "platform": platform.system(),
        "port": port,
        "python_exe": exe,
        "addresses": addresses,
        "listening_loopback": loopback,
        "listening_lan": {a: netinfo.port_open(a, port) for a in addresses} if loopback else {},
        "health": netinfo.probe_health("127.0.0.1", port) if loopback else None,
        "windows": query_windows(port, exe) if platform.system() == "Windows" else None,
    }
    return facts


def _rule_applies(rule: dict, port: int, exe: str) -> bool:
    if not rule.get("enabled", True):
        return False
    if rule.get("protocol", "Any") not in ("TCP", "Any", ""):
        return False
    lp = rule.get("local_port") or "Any"
    if lp != "Any":
        hit = False
        for part in lp.split(","):
            part = part.strip()
            if part == str(port):
                hit = True
            elif "-" in part:
                a, _, b = part.partition("-")
                hit = hit or (a.isdigit() and b.isdigit() and int(a) <= port <= int(b))
        if not hit:
            return False
    prog = rule.get("program") or "Any"
    return prog == "Any" or prog.lower() == exe.lower()


def _in_profile(rule_profile: str, category: str) -> bool:
    name = "Domain" if category.lower().startswith("domain") else category
    return rule_profile in ("Any", "") or name.lower() in [p.strip().lower() for p in rule_profile.split(",")]


def evaluate(facts: dict) -> list[Finding]:
    """Turn the facts into findings. Pure function: this is what the tests cover."""
    port = facts["port"]
    out: list[Finding] = []
    advised_rule = False
    add_rule, remove_rule = ADD_RULE.format(port=port), REMOVE_RULE.format(port=port)

    # 1. addresses -------------------------------------------------------- #
    addrs = facts.get("addresses") or []
    win = facts.get("windows")
    alias = {a["ip"]: a.get("interface") for a in (win or {}).get("addresses", [])}
    if not addrs:
        out.append(Finding("problem", "This PC has no LAN IPv4 address. Connect it to the same Wi-Fi as the phone."))
    for a in addrs:
        out.append(Finding("info", f"LAN address: http://{a}:{port}" + (f"   ({alias[a]})" if alias.get(a) else "")))

    # 2. is the server there? --------------------------------------------- #
    health = facts.get("health")
    if not facts.get("listening_loopback"):
        out.append(Finding("warn", f"Nothing is listening on port {port}: the server is not running.", "uv run locserver-serve"))
    elif not netinfo.is_our_server(health):
        out.append(Finding("problem", f"Port {port} is used by another program (its /health does not report "
                                      f"service \"{SERVICE_ID}\"). Stop it or pick another port.",
                           "uv run locserver-serve --port 8078"))
    else:
        out.append(Finding("ok", f"Server \"{health.get('server_name')}\" is running on port {port} "
                                 f"(version {health.get('server_version')}, API v{health.get('api_version')}, "
                                 f"maps: {', '.join(health.get('maps') or []) or 'none'})."))
        lan = facts.get("listening_lan") or {}
        if lan and not any(lan.values()):
            out.append(Finding("problem", "The server only listens on 127.0.0.1, so no other device can reach it.",
                               "uv run locserver-serve --host 0.0.0.0"))

    # 3. Windows network profile and firewall ------------------------------ #
    if facts.get("platform") != "Windows":
        out.append(Finding("info", "Not Windows: firewall checks skipped. Make sure inbound TCP "
                                   f"{port} from the local subnet is allowed."))
    elif not win:
        out.append(Finding("warn", "Could not read the Windows network profile / firewall rules. If the phone cannot "
                                   "connect, add the rule below from an administrator PowerShell.", add_rule))
    else:
        cats = sorted({p["category"] for p in win.get("profiles", []) if p.get("category")})
        for p in win.get("profiles", []):
            out.append(Finding("info", f"Network \"{p.get('network')}\" on {p.get('interface')}: profile {p.get('category')}"))
        fw_on = {f["name"].lower(): f.get("enabled", True) for f in win.get("fw_profiles", [])}
        rules = [r for r in win.get("rules", []) if _rule_applies(r, port, facts.get("python_exe", ""))]
        if not win.get("rules_readable", True):
            out.append(Finding("warn", "Firewall rules could not be listed (no permission). If the phone cannot "
                                       "connect, add the rule below from an administrator PowerShell.", add_rule))
        else:
            for cat in cats or ["Public"]:
                key = "domain" if cat.lower().startswith("domain") else cat.lower()
                if fw_on.get(key) is False:
                    out.append(Finding("ok", f"Windows Firewall is switched off for the {cat} profile: nothing blocks port {port}."))
                    continue
                blocks = [r for r in rules if r["action"] == "Block" and _in_profile(r.get("profile", "Any"), cat)]
                allows = [r for r in rules if r["action"] == "Allow" and _in_profile(r.get("profile", "Any"), cat)]
                for r in blocks:
                    out.append(Finding(
                        "problem",
                        f"Firewall rule \"{r.get('display')}\" BLOCKS inbound connections to Python on {cat} networks "
                        "(Windows creates it when its \"allow access?\" prompt is cancelled). A block rule wins over any "
                        "allow rule. Disable it from an administrator PowerShell:",
                        f"Disable-NetFirewallRule -Name '{r.get('name')}'",
                    ))
                if allows:
                    r = allows[0]
                    scope = r.get("remote") or "Any"
                    out.append(Finding("ok" if not blocks else "info",
                                       f"Firewall rule \"{r.get('display')}\" allows inbound TCP {port} on {cat} "
                                       f"networks (remote addresses: {scope})."))
                    if (r.get("program") or "Any") != "Any" and scope == "Any":
                        out.append(Finding("info", "That rule was created for the Python program as a whole: it admits any "
                                                   "address to any port Python listens on. The port rule printed by this "
                                                   "tool when nothing is allowed is narrower (one port, local subnet)."))
                elif not blocks:
                    extra = (" The connection is classified as Public, where Windows blocks all unsolicited inbound "
                             "traffic; a rule limited to -Profile Private would not apply here." if cat == "Public" else "")
                    out.append(Finding(
                        "problem",
                        f"No firewall rule lets inbound TCP {port} through on {cat} networks, so the phone's requests "
                        f"are dropped.{extra} Add this rule from an administrator PowerShell (it is limited to the "
                        "local subnet):",
                        add_rule,
                    ))
                    advised_rule = True
        ours = RULE_NAME.format(port=port)
        if advised_rule or any(r.get("display") == ours for r in win.get("rules", [])):
            out.append(Finding("info", f"To remove that rule again: {remove_rule}"))

    # 4. what the doctor cannot see ---------------------------------------- #
    if addrs:
        out.append(Finding("info", f"Final check from the phone's browser: http://{addrs[0]}:{port}/health must show "
                                   f"\"service\": \"{SERVICE_ID}\"."))
    out.append(Finding("info", "Not visible from here: a third-party firewall/antivirus, and Wi-Fi \"client isolation\" "
                               "(guest and university networks often forbid device-to-device traffic). If everything above "
                               "is ok and the phone still cannot connect, put the PC on the phone's own hotspot."))
    return out


def format_report(findings: list[Finding]) -> str:
    tag = {"ok": "[ OK ]", "info": "[info]", "warn": "[warn]", "problem": "[FIX ]"}
    lines = []
    for f in findings:
        lines.append(f"{tag.get(f.level, '[    ]')} {f.text}")
        if f.fix:
            lines.append(f"           {f.fix}")
    n = sum(f.level == "problem" for f in findings)
    lines.append("")
    lines.append(f"{n} problem(s) found. Nothing was changed on this PC." if n else "No problem found. Nothing was changed on this PC.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=config.port())
    ap.add_argument("--json", action="store_true", help="print the raw facts and findings as JSON")
    a = ap.parse_args(argv)
    facts = gather(a.port)
    findings = evaluate(facts)
    if a.json:
        print(json.dumps({"facts": facts, "findings": [f.__dict__ for f in findings]}, indent=2))
    else:
        print(format_report(findings))
    return 1 if any(f.level == "problem" for f in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
