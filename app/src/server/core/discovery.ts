/**
 * "Find automatically": probes a list of hosts for the localization server.
 * Pure TypeScript; the probe function is injected, so tests run it against a mock.
 */
import { type ServerAddress, toBaseUrl } from './address';
import type { ProbeResult } from './client';
import type { ServerInfo } from './health';

export interface DiscoveredServer {
  address: ServerAddress;
  info: ServerInfo;
  latencyMs: number;
  /** False when it is our server but speaks an unsupported API version. */
  compatible: boolean;
}

export interface ScanOptions {
  hosts: string[];
  port: number;
  /** Requests in flight at the same time. */
  concurrency: number;
  timeoutMs: number;
  probe: (baseUrl: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<ProbeResult>;
  onProgress?: (scanned: number, total: number, found: DiscoveredServer[]) => void;
  signal?: AbortSignal;
}

export interface ScanResult {
  found: DiscoveredServer[];
  scanned: number;
  total: number;
  cancelled: boolean;
}

export const DEFAULT_SCAN_CONCURRENCY = 24;
export const DEFAULT_SCAN_TIMEOUT_MS = 500;

/**
 * Probes every host with at most `concurrency` requests in flight. A host is reported
 * only when its `/health` identifies it as our server (other web servers are ignored).
 * With the defaults a /24 (253 hosts) takes about 253 / 24 * 0.5 s = 5-6 s at worst.
 */
export async function scanHosts(options: ScanOptions): Promise<ScanResult> {
  const { hosts, port, timeoutMs, probe, onProgress, signal } = options;
  const total = hosts.length;
  const found: DiscoveredServer[] = [];
  let next = 0;
  let scanned = 0;

  const worker = async () => {
    while (next < total && !signal?.aborted) {
      const host = hosts[next++];
      const address: ServerAddress = { scheme: 'http', host, port };
      const result = await probe(toBaseUrl(address), { timeoutMs, signal });
      if (signal?.aborted) {
        return;
      }
      scanned++;
      if (result.kind === 'ok' || result.kind === 'unhealthy') {
        found.push({ address, info: result.info, latencyMs: result.latencyMs, compatible: true });
      } else if (result.kind === 'incompatible') {
        found.push({ address, info: result.info, latencyMs: result.latencyMs, compatible: false });
      }
      onProgress?.(scanned, total, found);
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, total));
  await Promise.all(Array.from({ length: workers }, worker));
  // Compatible servers first, then by response time.
  found.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.latencyMs - b.latencyMs);
  return { found, scanned, total, cancelled: Boolean(signal?.aborted) };
}
