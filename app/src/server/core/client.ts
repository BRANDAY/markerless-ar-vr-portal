/**
 * ALL HTTP traffic to the localization server goes through this module: the health
 * check (stage 2a) and, for the room scan (stage 2b), the recording upload, build jobs,
 * the room plan, the portal, `/localize` and the device log.
 *
 * Every request carries the headers that tell the server which device is talking
 * (`setClientIdentity`), so that its monitoring panel can list the phones.
 *
 * Pure TypeScript on top of the standard `fetch` / `AbortController`, so it runs
 * unchanged in React Native and in Node (tests use a local mock server). Uploads use
 * `XMLHttpRequest` where it exists (React Native), because `fetch` reports no progress.
 */
import { type ClientIdentity, identityHeaders, type LogReceipt, parseLogReceipt } from './deviceLog';
import { type ServerInfo, validateHealth } from './health';
import {
  parseJob,
  parseJobs,
  parseLocalize,
  parseMaps,
  parsePortal,
  parseRoom,
  type LocalizeOutcome,
  type ServerJob,
  type ServerMapInfo,
  type ServerPortal,
  type ServerRoom,
} from './roomPlan';

let identity: Record<string, string> = {};

/** Who this client is; from now on sent as `X-Device-Id`, `X-Session-Id`... with every request. */
export function setClientIdentity(client: ClientIdentity | null): void {
  identity = identityHeaders(client);
}

/** Headers of every request: JSON answers wanted, and the identity of the device. */
function baseHeaders(): Record<string, string> {
  return { Accept: 'application/json', ...identity };
}

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
      headers: baseHeaders(),
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

// ---- room scan (api-v2) -----------------------------------------------------------------

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `status` is the HTTP status, or null when there was no HTTP answer at all. `code` is
   * the server's `X-Error-Code` header, where it sent one (a fixed word for the cause).
   */
  | { ok: false; status: number | null; reason: string; code?: string };

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface UploadOptions {
  signal?: AbortSignal;
  /** Bytes handed to the network so far, and the total. Only where the platform reports it. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
}

const JSON_TIMEOUT_MS = 8000;

/** The server reports errors as `{"detail": "text"}`. */
function errorReason(status: number, body: unknown): string {
  const detail = body && typeof body === 'object' ? (body as Record<string, unknown>).detail : undefined;
  return typeof detail === 'string' && detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

function parsed<T>(
  status: number,
  body: unknown,
  parse: (body: unknown) => T | null,
  errorCode?: string | null,
): ApiResult<T> {
  if (status < 200 || status >= 300) {
    const failure = { ok: false as const, status, reason: errorReason(status, body) };
    return errorCode ? { ...failure, code: errorCode } : failure;
  }
  const value = parse(body);
  return value === null
    ? { ok: false, status, reason: 'the answer does not have the expected shape' }
    : { ok: true, value };
}

const ERROR_CODE_HEADER = 'X-Error-Code';

function errorCodeOf(response: { headers?: { get?: (name: string) => string | null } }): string | null {
  try {
    return response.headers?.get?.(ERROR_CODE_HEADER) ?? null;
  } catch {
    return null;
  }
}

async function requestJson<T>(
  url: string,
  init: { method: string; body?: string },
  parse: (body: unknown) => T | null,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', onOuterAbort);
  }
  try {
    const headers = baseHeaders();
    if (init.body) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    return parsed(response.status, body, parse, errorCodeOf(response));
  } catch (error) {
    const reason = timedOut
      ? `no answer within ${timeoutMs} ms`
      : options.signal?.aborted
        ? 'cancelled'
        : (error instanceof Error ? error.message : String(error)) || 'network error';
    return { ok: false, status: null, reason };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** The part of `XMLHttpRequest` used here (the type is not available in the Node test build). */
interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  getResponseHeader?(name: string): string | null;
  status: number;
  responseText: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
  upload?: { onprogress: ((event: { loaded: number; total: number }) => void) | null };
}

/** `POST` of a multipart form; no timeout, because an upload takes as long as it takes. */
async function postMultipart<T>(
  url: string,
  form: unknown,
  parse: (body: unknown) => T | null,
  options: UploadOptions = {},
): Promise<ApiResult<T>> {
  const Xhr = (globalThis as { XMLHttpRequest?: new () => XhrLike }).XMLHttpRequest;
  if (!Xhr || options.fetchImpl) {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: baseHeaders(),
        body: form as FormData,
        signal: options.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      return parsed(response.status, body, parse, errorCodeOf(response));
    } catch (error) {
      const reason = options.signal?.aborted
        ? 'cancelled'
        : (error instanceof Error ? error.message : String(error)) || 'network error';
      return { ok: false, status: null, reason };
    }
  }
  return new Promise((resolve) => {
    const xhr = new Xhr();
    const onOuterAbort = () => xhr.abort();
    const finish = (result: ApiResult<T>) => {
      options.signal?.removeEventListener('abort', onOuterAbort);
      resolve(result);
    };
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(baseHeaders())) {
      xhr.setRequestHeader(name, value);
    }
    if (xhr.upload && options.onProgress) {
      const onProgress = options.onProgress;
      xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    }
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: `parsed` reports the status or the wrong shape
      }
      let errorCode: string | null = null;
      try {
        errorCode = xhr.getResponseHeader?.(ERROR_CODE_HEADER) ?? null;
      } catch {
        // no header, no code
      }
      finish(parsed(xhr.status, body, parse, errorCode));
    };
    xhr.onerror = () => finish({ ok: false, status: null, reason: 'network error during the upload' });
    xhr.ontimeout = () => finish({ ok: false, status: null, reason: 'the upload timed out' });
    xhr.onabort = () => finish({ ok: false, status: null, reason: 'cancelled' });
    if (options.signal?.aborted) {
      finish({ ok: false, status: null, reason: 'cancelled' });
      return;
    }
    options.signal?.addEventListener('abort', onOuterAbort);
    xhr.send(form);
  });
}

const enc = encodeURIComponent;

/** `POST /maps/{map_id}/recording`: the form carries `video`, `session_jsonl` and options. */
export function uploadRecording(
  baseUrl: string,
  mapId: string,
  form: unknown,
  options?: UploadOptions,
): Promise<ApiResult<ServerJob>> {
  return postMultipart(`${baseUrl}/maps/${enc(mapId)}/recording`, form, parseJob, options);
}

export function getJob(baseUrl: string, jobId: string, options?: RequestOptions): Promise<ApiResult<ServerJob>> {
  return requestJson(`${baseUrl}/jobs/${enc(jobId)}`, { method: 'GET' }, parseJob, options);
}

/** `GET /jobs?map_id=`: the jobs of a room, newest first. */
export function getJobs(baseUrl: string, mapId: string, options?: RequestOptions): Promise<ApiResult<ServerJob[]>> {
  return requestJson(`${baseUrl}/jobs?map_id=${enc(mapId)}`, { method: 'GET' }, parseJobs, options);
}

export function cancelJob(baseUrl: string, jobId: string, options?: RequestOptions): Promise<ApiResult<ServerJob>> {
  return requestJson(`${baseUrl}/jobs/${enc(jobId)}/cancel`, { method: 'POST' }, parseJob, options);
}

/** `GET /maps/{map_id}/room`: the plan in the map frame. */
export function getRoom(baseUrl: string, mapId: string, options?: RequestOptions): Promise<ApiResult<ServerRoom>> {
  return requestJson(`${baseUrl}/maps/${enc(mapId)}/room`, { method: 'GET' }, parseRoom, options);
}

/** `GET /maps/{map_id}/portal`: the doorway in the map frame (`source: "none"` = not found). */
export function getPortal(baseUrl: string, mapId: string, options?: RequestOptions): Promise<ApiResult<ServerPortal>> {
  return requestJson(`${baseUrl}/maps/${enc(mapId)}/portal`, { method: 'GET' }, parsePortal, options);
}

/** `POST /localize`: the form carries a clip with its `session.jsonl` (or an image with `ar_pose`). */
export function localize(baseUrl: string, form: unknown, options?: UploadOptions): Promise<ApiResult<LocalizeOutcome>> {
  return postMultipart(`${baseUrl}/localize`, form, parseLocalize, options);
}

/**
 * `POST /devices/{device_id}/log`: a batch of the app's log events and its current state.
 * A server without the capability `device_log` answers 404.
 */
export function postDeviceLog(
  baseUrl: string,
  deviceId: string,
  body: Record<string, unknown>,
  options?: RequestOptions,
): Promise<ApiResult<LogReceipt>> {
  return requestJson(
    `${baseUrl}/devices/${enc(deviceId)}/log`,
    { method: 'POST', body: JSON.stringify(body) },
    parseLogReceipt,
    { timeoutMs: 3000, ...options },
  );
}

/** `GET /maps`: the rooms the server has. */
export function getMaps(baseUrl: string, options?: RequestOptions): Promise<ApiResult<ServerMapInfo[]>> {
  return requestJson(`${baseUrl}/maps`, { method: 'GET' }, parseMaps, options);
}
