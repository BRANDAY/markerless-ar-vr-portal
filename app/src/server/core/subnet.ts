/**
 * Which addresses "Find automatically" probes. Pure TypeScript, covered by `subnet.test.ts`.
 */
import { parseIPv4 } from './address';

export type SubnetResult = { ok: true; hosts: string[]; prefix: string } | { ok: false; error: string };

/**
 * All other hosts of the /24 network the given address belongs to (x.y.z.1 ... x.y.z.254
 * without the address itself): 253 candidates.
 *
 * A /24 is an assumption, not read from the network: it is what home routers, phone
 * hotspots and most small networks use. On a bigger network the server may be outside
 * this range; then the address has to be typed in.
 */
export function enumerateSubnet24(ownAddress: string): SubnetResult {
  const octets = parseIPv4(ownAddress.trim());
  if (!octets) {
    return { ok: false, error: `"${ownAddress}" is not an IPv4 address` };
  }
  const [a, b, c, d] = octets;
  if (a === 0 || a === 127) {
    return { ok: false, error: 'The phone has no local network address' };
  }
  if (a === 169 && b === 254) {
    return {
      ok: false,
      error: 'The phone has only a self-assigned address (no DHCP): check the Wi-Fi connection',
    };
  }
  const prefix = `${a}.${b}.${c}`;
  const hosts: string[] = [];
  for (let last = 1; last <= 254; last++) {
    if (last !== d) {
      hosts.push(`${prefix}.${last}`);
    }
  }
  return { ok: true, hosts, prefix };
}
