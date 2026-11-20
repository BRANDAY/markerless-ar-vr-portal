/**
 * "Find automatically": probes a list of hosts for the localization server.
 * Pure TypeScript; the probe function is injected, so tests run it against a mock.
 *
 * The scan is slow on purpose. A connection attempt to an address nobody uses makes the
 * phone send three ARP broadcasts for it, and a /24 is almost entirely such addresses. A
 * fast scan (the first version: 24 requests in flight, about 48 addresses a second, so
 * about 145 broadcasts a second) was measured on a home Wi-Fi network to get ALL of the
 * phone's broadcasts dropped for a minute or two after the first 50 or so. From then on
 * the phone could not resolve any address it did not already know - including the
 * server's ("no route to host") and, once, the router's, at which point Android dropped
 * the Wi-Fi connection. At 5 and at 8 addresses a second every broadcast arrived; at 15
 * the blocking started. See the README, "Why the search is slow".
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
  /** Probed in this order. */
  hosts: string[];
  port: number;
  /**
   * Minimum time between the starts of two probes. This is what keeps the scan gentle:
   * the number of requests in flight follows from it (about `timeoutMs / startIntervalMs`).
   */
  startIntervalMs: number;
  timeoutMs: number;
  /** End the scan as soon as a compatible server has answered. */
  stopAtFirstCompatible?: boolean;
  probe: (baseUrl: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<ProbeResult>;
  onProgress?: (scanned: number, total: number, found: DiscoveredServer[]) => void;
  signal?: AbortSignal;
}

export interface ScanResult {
  found: DiscoveredServer[];
  /** Hosts that were probed and answered or timed out. */
  scanned: number;
  total: number;
  /** True when the caller's signal ended the scan. */
  cancelled: boolean;
  /** True when the scan ended early because of `stopAtFirstCompatible`. */
  stoppedEarly: boolean;
}

/** 5 addresses a second: at most about 15 ARP broadcasts a second. */
export const DEFAULT_SCAN_START_INTERVAL_MS = 200;
/** Generous, because the pace no longer depends on it; about 8 requests are in flight. */
export const DEFAULT_SCAN_TIMEOUT_MS = 1500;

/** Worst case for a whole scan, for the user interface. */
export function scanDurationSeconds(hostCount: number, startIntervalMs: number, timeoutMs: number): number {
  return Math.ceil((Math.max(0, hostCount - 1) * startIntervalMs + timeoutMs) / 1000);
}

/**
 * Probes the hosts one after another, a new one every `startIntervalMs`, without waiting
 * for the previous answers. A host is reported only when its `/health` identifies it as
 * our server (other web servers are ignored).
 */
export async function scanHosts(options: ScanOptions): Promise<ScanResult> {
  const { hosts, port, timeoutMs, probe, onProgress, signal, stopAtFirstCompatible } = options;
  const startIntervalMs = Math.max(0, options.startIntervalMs);
  const total = hosts.length;
  const found: DiscoveredServer[] = [];
  let scanned = 0;
  let stoppedEarly = false;

  // Ends the waiting and the requests in flight: on the caller's abort or on an early stop.
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  if (signal?.aborted) {
    inner.abort();
  } else {
    signal?.addEventListener('abort', onOuterAbort);
  }

  const probeOne = async (host: string) => {
    const address: ServerAddress = { scheme: 'http', host, port };
    const result = await probe(toBaseUrl(address), { timeoutMs, signal: inner.signal });
    if (inner.signal.aborted) {
      return;
    }
    scanned++;
    if (result.kind === 'ok' || result.kind === 'unhealthy') {
      found.push({ address, info: result.info, latencyMs: result.latencyMs, compatible: true });
      if (stopAtFirstCompatible) {
        stoppedEarly = true;
        onProgress?.(scanned, total, found);
        inner.abort();
        return;
      }
    } else if (result.kind === 'incompatible') {
      found.push({ address, info: result.info, latencyMs: result.latencyMs, compatible: false });
    }
    onProgress?.(scanned, total, found);
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || inner.signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        inner.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      inner.signal.addEventListener('abort', done);
    });

  const running: Promise<void>[] = [];
  for (let index = 0; index < total && !inner.signal.aborted; index++) {
    running.push(probeOne(hosts[index]));
    if (index < total - 1) {
      await pause(startIntervalMs);
    }
  }
  await Promise.all(running);
  signal?.removeEventListener('abort', onOuterAbort);

  // Compatible servers first, then by response time.
  found.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.latencyMs - b.latencyMs);
  return { found, scanned, total, cancelled: Boolean(signal?.aborted), stoppedEarly };
}
