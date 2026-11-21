/**
 * Device identity and device log for the server's monitoring panel (`api-v2.md`,
 * section 9). Pure TypeScript: who this client is (HTTP headers), the queue of log events
 * waiting to be sent, when to send them, and where the device is in the usage scenario.
 * The HTTP call is in `client.ts`; timers and app state are in `server/deviceLogger.ts`.
 */

/** Who is talking to the server. Sent as HTTP headers with every request. */
export interface ClientIdentity {
  /** Stable id of this installation. */
  deviceId: string;
  /** Name for the panel, e.g. "Xiaomi 14 Ultra". */
  deviceName: string;
  /** Id of the current app run. */
  sessionId: string;
  appVersion: string;
}

const ID_MAX = 64;
const NAME_MAX = 64;
const VERSION_MAX = 32;

/** Letters, digits, `_`, `-`, `.`; everything else becomes `-`. Never empty. */
export function sanitizeId(text: string, fallback = 'unknown'): string {
  const cleaned = text.replace(/[^0-9A-Za-z_.-]/g, '-').slice(0, ID_MAX);
  return cleaned || fallback;
}

/** ASCII only: other characters are percent-encoded as in a URL, and the result is cut at a whole escape. */
function headerText(text: string, max: number): string {
  let out = '';
  for (const char of text.trim()) {
    const code = char.codePointAt(0) ?? 0;
    const piece = code >= 0x20 && code < 0x7f && char !== '%' ? char : encodeURIComponent(char);
    if (out.length + piece.length > max) {
      break;
    }
    out += piece;
  }
  return out;
}

/** The identification headers of section 9.1; empty values are left out. */
export function identityHeaders(identity: ClientIdentity | null): Record<string, string> {
  if (!identity) {
    return {};
  }
  const headers: Record<string, string> = {
    'X-Device-Id': sanitizeId(identity.deviceId),
    'X-Session-Id': sanitizeId(identity.sessionId),
  };
  const name = headerText(identity.deviceName, NAME_MAX);
  if (name) {
    headers['X-Device-Name'] = name;
  }
  const version = headerText(identity.appVersion, VERSION_MAX);
  if (version) {
    headers['X-App-Version'] = version;
  }
  return headers;
}

/** A new installation id: `arportal-` and 10 characters. */
export function newDeviceId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'arportal-';
  for (let i = 0; i < 10; i++) {
    id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  }
  return id;
}

// ---- events -------------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogType = 'app' | 'connect' | 'tracking' | 'scan' | 'upload' | 'job' | 'localize' | 'portal' | 'error';

export interface DeviceLogEvent {
  seq: number;
  t_ms: number;
  level: LogLevel;
  type: LogType;
  message: string;
}

const MESSAGE_MAX = 500;

/**
 * Category and level of a line of the app's event log, from its text. The app writes its
 * log as plain lines with a topic prefix ("tracking: NORMAL", "server: connected ...").
 */
export function classifyLogLine(text: string): { type: LogType; level: LogLevel } {
  const lower = text.toLowerCase();
  if (lower.startsWith('measure')) {
    // Lines of the measurement mode: their wording ("not-found", "outside the tolerance")
    // describes a test result, not a fault of the app.
    if (lower.startsWith('measure-data')) {
      return { type: 'portal', level: 'debug' };
    }
    const attention = /outside the tolerance| not-found| no-doorway|cannot mark|could not save|interrupted/.test(lower);
    return { type: 'portal', level: attention ? 'warn' : 'info' };
  }
  let type: LogType = 'app';
  if (lower.startsWith('tracking')) {
    type = 'tracking';
  } else if (lower.startsWith('server search') || /^server: (trying|connecting|connected|unreachable|incompatible|no address|could not)/.test(lower)) {
    type = 'connect';
  } else if (lower.startsWith('server: localize') || lower.includes('looking for the room')) {
    type = 'localize';
  } else if (lower.startsWith('server: upload') || lower.startsWith('server: sending')) {
    type = 'upload';
  } else if (lower.startsWith('server: map') || lower.startsWith('server: build') || lower.startsWith('server: job')) {
    type = 'job';
  } else if (lower.startsWith('scan') || lower.startsWith('recording') || lower.startsWith('capture') || lower.startsWith('mesh')) {
    type = 'scan';
  } else if (lower.startsWith('portal') || lower.startsWith('door') || lower.startsWith('provider') || lower.startsWith('environment')) {
    type = 'portal';
  }
  let level: LogLevel = 'info';
  if (/\berror\b|\bfailed\b|exception|could not/.test(lower)) {
    level = 'error';
  } else if (/unreachable|not found|no door opening|unavailable|limited|cancelled|not available/.test(lower)) {
    level = 'warn';
  }
  return { type: level === 'error' && type === 'app' ? 'error' : type, level };
}

/** Send when this many events are waiting. */
export const BATCH_SIZE = 20;
/** The server accepts at most this many events per request. */
export const MAX_EVENTS_PER_REQUEST = 200;
/** Events kept while the server cannot be reached; the oldest are dropped. */
export const MAX_QUEUED_EVENTS = 500;
/** With events waiting, send at least this often. */
export const FLUSH_INTERVAL_MS = 2000;
/** With nothing new, send an empty batch this often so that `state` stays current. */
export const KEEPALIVE_INTERVAL_MS = 5000;

/** Events of one app run waiting for the server, numbered 1, 2, 3... */
export class DeviceLogQueue {
  private events: DeviceLogEvent[] = [];
  private nextSeq = 1;
  private dropped = 0;
  private urgent = false;

  add(message: string, nowMs: number, kind?: { type: LogType; level: LogLevel }): DeviceLogEvent {
    const { type, level } = kind ?? classifyLogLine(message);
    const event: DeviceLogEvent = {
      seq: this.nextSeq++,
      t_ms: Math.round(nowMs),
      level,
      type,
      message: message.replace(/\s+/g, ' ').slice(0, MESSAGE_MAX),
    };
    this.events.push(event);
    if (this.events.length > MAX_QUEUED_EVENTS) {
      this.dropped += this.events.length - MAX_QUEUED_EVENTS;
      this.events = this.events.slice(-MAX_QUEUED_EVENTS);
    }
    if (level === 'error') {
      this.urgent = true;
    }
    return event;
  }

  get size(): number {
    return this.events.length;
  }

  /** How many events were dropped because the queue was full. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** The next events to send, oldest first. They stay queued until `acknowledge`. */
  nextBatch(): DeviceLogEvent[] {
    return this.events.slice(0, MAX_EVENTS_PER_REQUEST);
  }

  /** The server holds every event up to `lastSeq`. */
  acknowledge(lastSeq: number): void {
    this.events = this.events.filter((event) => event.seq > lastSeq);
    if (!this.events.some((event) => event.level === 'error')) {
      this.urgent = false;
    }
  }

  /**
   * Whether a request is due: at once for an error or a full batch, otherwise on the
   * regular beat, and an empty batch as a keep-alive.
   */
  isDue(nowMs: number, lastSentMs: number): boolean {
    if (this.urgent || this.events.length >= BATCH_SIZE) {
      return true;
    }
    const since = nowMs - lastSentMs;
    return this.events.length > 0 ? since >= FLUSH_INTERVAL_MS : since >= KEEPALIVE_INTERVAL_MS;
  }

  /** After a failed request the error events wait for the regular beat like the others. */
  deferUrgent(): void {
    this.urgent = false;
  }
}

// ---- state --------------------------------------------------------------------------------

export type ScenarioStep =
  | 'connecting'
  | 'connected'
  | 'scanning'
  | 'uploading'
  | 'building'
  | 'ready'
  | 'localizing'
  | 'portal_placed'
  | 'inside'
  | 'error';

/** What the step is derived from; plain values so that the rule can be tested. */
export interface ScenarioFacts {
  serverConnected: boolean;
  recording: boolean;
  uploadPhase: 'idle' | 'uploading' | 'building' | 'done' | 'failed' | string;
  uploadText: string;
  /** The user is on the virtual side of the portal. */
  inside: boolean;
  doorPlaced: boolean;
  providerId: string;
  providerStatus: string;
  providerDetail: string;
  /** A room plan is known in this session, or the server lists the map. */
  mapAvailable: boolean;
}

/** Where the device is in the usage scenario, and one line of detail. */
export function scenarioStep(facts: ScenarioFacts): { step: ScenarioStep; detail: string } {
  const provider = `provider ${facts.providerId}`;
  if (facts.inside) {
    return { step: 'inside', detail: provider };
  }
  if (facts.recording) {
    return { step: 'scanning', detail: 'recording the room' };
  }
  if (facts.uploadPhase === 'uploading') {
    return { step: 'uploading', detail: facts.uploadText };
  }
  if (facts.uploadPhase === 'building') {
    return { step: 'building', detail: facts.uploadText };
  }
  if (!facts.serverConnected) {
    // A door placed by hand needs no server; say so instead of only "connecting".
    return { step: 'connecting', detail: facts.doorPlaced ? `${provider}, door placed` : '' };
  }
  if (facts.providerStatus === 'localizing') {
    return { step: 'localizing', detail: facts.providerDetail };
  }
  if (facts.doorPlaced) {
    return { step: 'portal_placed', detail: `${provider}: ${facts.providerDetail}` };
  }
  if (facts.uploadPhase === 'failed') {
    return { step: 'error', detail: facts.uploadText };
  }
  if (facts.providerStatus === 'error' || facts.providerStatus === 'lost') {
    return { step: 'error', detail: facts.providerDetail };
  }
  if (facts.mapAvailable) {
    return { step: 'ready', detail: provider };
  }
  return { step: 'connected', detail: provider };
}

export interface DeviceLogState {
  step: ScenarioStep;
  tracking: string;
  map_id: string;
  detail: string;
}

/** The JSON body of `POST /devices/{device_id}/log`. */
export function buildLogBody(
  identity: ClientIdentity,
  events: DeviceLogEvent[],
  state: DeviceLogState,
  nowMs: number,
  rttMs: number | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    session_id: sanitizeId(identity.sessionId),
    device_name: identity.deviceName.slice(0, NAME_MAX),
    app_version: identity.appVersion.slice(0, VERSION_MAX),
    sent_at_ms: Math.round(nowMs),
    state: { ...state, detail: state.detail.slice(0, 200) },
    events,
  };
  if (rttMs !== null) {
    body.rtt_ms = Math.round(rttMs);
  }
  return body;
}

/** The server's answer to a log batch. */
export interface LogReceipt {
  accepted: number;
  duplicates: number;
  lastSeq: number;
}

export function parseLogReceipt(body: unknown): LogReceipt | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const json = body as Record<string, unknown>;
  if (typeof json.last_seq !== 'number') {
    return null;
  }
  return {
    accepted: typeof json.accepted === 'number' ? json.accepted : 0,
    duplicates: typeof json.duplicates === 'number' ? json.duplicates : 0,
    lastSeq: json.last_seq,
  };
}
