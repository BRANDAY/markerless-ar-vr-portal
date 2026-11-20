/**
 * ALL HTTP traffic to the localization server goes through this module.
 * Stage 2a has one request (`GET /health`); stage 2b adds `POST /localize` here.
 *
 * Pure TypeScript on top of the standard `fetch` / `AbortController`, so it runs
 * unchanged in React Native and in Node (tests use a local mock server).
 */
import { type ServerInfo, validateHealth } from './health';

export type ProbeResult =
  | { kind: 'ok'; info: ServerInfo; latencyMs: number }
  | { kind: 'incompatible'; info: ServerInfo; reason: string; latencyMs: number }
  | { kind: 'unhealthy'; info: ServerInfo; reason: string; latencyMs: number }
  | { kind: 'not-our-server'; reason: string }
  /** No usable HTTP answer: timeout, connection refused, no route, HTTP error status. */
  | { kind: 'unreachable'; reason: string };

export interface ProbeOptions {
  timeoutMs: number;
  /** Cancels the request from outside (e.g. "Cancel" during the automatic search). */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** `GET {baseUrl}/health`, validated against the contract. Never throws. */
export async function probeHealth(baseUrl: string, options: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onOuterAbort);
    }
  }

  const startedAt = now();
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { kind: 'unreachable', reason: `HTTP ${response.status}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'not-our-server', reason: 'the answer is not JSON' };
    }
    const latencyMs = Math.max(0, Math.round(now() - startedAt));
    const verdict = validateHealth(body);
    if (verdict.kind === 'not-our-server') {
      return verdict;
    }
    return { ...verdict, latencyMs };
  } catch (error) {
    if (timedOut) {
      return { kind: 'unreachable', reason: `no answer within ${options.timeoutMs} ms` };
    }
    if (options.signal?.aborted) {
      return { kind: 'unreachable', reason: 'cancelled' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'unreachable', reason: message || 'network error' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
