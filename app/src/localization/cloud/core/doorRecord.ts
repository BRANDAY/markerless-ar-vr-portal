/**
 * What the phone keeps about a doorway that was saved in a cloud service: the id of the
 * cloud anchor, where the doorway stands relative to that anchor, how big the opening is
 * and until when the service keeps the anchor. Pure TypeScript: reading a saved file,
 * checking its values and the expiry arithmetic are unit-tested here; the file itself is
 * read and written by `doorRecordStore.ts`.
 *
 * The record holds no key and no secret. A cloud anchor id only lets a build of THIS app
 * (authorised in the service's project) look the anchor up, so the record may be copied
 * from one venue phone to another (`toShareText` / `fromShareText`).
 */
import type { RigidPose, Vec3 } from './anchorMath';

export const RECORD_VERSION = 1;

/**
 * The cloud anchor services ViroReact can talk to (its `provider` prop). The calls are
 * the same for both; which one a build uses is decided by the build configuration.
 */
export type CloudService = 'arcore' | 'reactvision';

export interface CloudDoorRecord {
  version: typeof RECORD_VERSION;
  service: CloudService;
  /** Id the service gave when the anchor was hosted. */
  cloudAnchorId: string;
  /** Room of the self-hosted server this doorway belongs to, when it came from there. */
  roomId: string | null;
  /** Doorway pose in the anchor's own frame (`anchorMath.relativeTo`). */
  doorInAnchor: RigidPose;
  /** Size of the real opening, metres, when it is known (found by the server). */
  opening: { width: number; height: number } | null;
  /** How the doorway pose was obtained when it was saved. */
  doorSource: 'server' | 'by-hand';
  /** `Date.now()` when the service confirmed the anchor. */
  hostedAtMs: number;
  /** Lifetime asked from the service, days. */
  ttlDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    return null;
  }
  return [value[0], value[1], value[2]];
}

function asPose(value: unknown): RigidPose | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { position, rotation } = value as Record<string, unknown>;
  const p = asVec3(position);
  const r = asVec3(rotation);
  return p && r ? { position: p, rotation: r } : null;
}

function asOpening(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { width, height } = value as Record<string, unknown>;
  // A door opening outside these bounds is a broken value, not a doorway.
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width < 0.3 || width > 6 || height < 0.5 || height > 6) {
    return null;
  }
  return { width, height };
}

/**
 * A record from parsed JSON, or null when anything needed is missing or of the wrong
 * kind. Unknown extra fields are dropped; a broken `opening` only loses the size.
 */
export function parseRecord(json: unknown): CloudDoorRecord | null {
  if (typeof json !== 'object' || json === null) {
    return null;
  }
  const raw = json as Record<string, unknown>;
  if (raw.version !== RECORD_VERSION) {
    return null;
  }
  if (raw.service !== 'arcore' && raw.service !== 'reactvision') {
    return null;
  }
  const id = typeof raw.cloudAnchorId === 'string' ? raw.cloudAnchorId.trim() : '';
  const doorInAnchor = asPose(raw.doorInAnchor);
  if (!id || id.length > 200 || !doorInAnchor) {
    return null;
  }
  if (!isFiniteNumber(raw.hostedAtMs) || raw.hostedAtMs <= 0) {
    return null;
  }
  if (!isFiniteNumber(raw.ttlDays) || raw.ttlDays < 1 || raw.ttlDays > 365) {
    return null;
  }
  return {
    version: RECORD_VERSION,
    service: raw.service,
    cloudAnchorId: id,
    roomId: typeof raw.roomId === 'string' && raw.roomId ? raw.roomId : null,
    doorInAnchor,
    opening: asOpening(raw.opening),
    doorSource: raw.doorSource === 'server' ? 'server' : 'by-hand',
    hostedAtMs: raw.hostedAtMs,
    ttlDays: Math.floor(raw.ttlDays),
  };
}

/** When the service stops keeping the anchor (as far as the phone knows). */
export function expiresAtMs(record: CloudDoorRecord): number {
  return record.hostedAtMs + record.ttlDays * DAY_MS;
}

/** Whole days until the anchor expires; 0 or less when it already has. */
export function daysLeft(record: CloudDoorRecord, nowMs: number): number {
  return Math.floor((expiresAtMs(record) - nowMs) / DAY_MS);
}

export type ExpiryState =
  /** Plenty of time. */
  | 'valid'
  /** Still works, but the staff should save the doorway again soon. */
  | 'expiring'
  /** The service has dropped the anchor: looking for it cannot succeed. */
  | 'expired';

/**
 * A warning starts this many days before the end - or at one fifth of the lifetime for
 * short-lived anchors (a 1-day test anchor would otherwise always be "expiring").
 */
export const EXPIRY_WARNING_DAYS = 30;

export function expiryState(record: CloudDoorRecord, nowMs: number): ExpiryState {
  const leftMs = expiresAtMs(record) - nowMs;
  if (leftMs <= 0) {
    return 'expired';
  }
  const warningMs = Math.min(EXPIRY_WARNING_DAYS, record.ttlDays / 5) * DAY_MS;
  return leftMs <= warningMs ? 'expiring' : 'valid';
}

// ---- moving a record to another phone -------------------------------------------------------

const SHARE_PREFIX = 'ARDOOR1:';

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * One line of text that carries the whole record (for a QR code, a message or the
 * self-hosted server). Numbers are rounded to 0.1 mm / 0.001 degrees to keep it short.
 */
export function toShareText(record: CloudDoorRecord): string {
  const compact = {
    s: record.service,
    id: record.cloudAnchorId,
    room: record.roomId,
    p: record.doorInAnchor.position.map((v) => round(v, 4)),
    r: record.doorInAnchor.rotation.map((v) => round(v, 3)),
    o: record.opening ? [round(record.opening.width, 3), round(record.opening.height, 3)] : null,
    src: record.doorSource,
    at: record.hostedAtMs,
    ttl: record.ttlDays,
  };
  return SHARE_PREFIX + JSON.stringify(compact);
}

/** The record carried by `toShareText`, or null when the text is something else. */
export function fromShareText(text: string): CloudDoorRecord | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SHARE_PREFIX)) {
    return null;
  }
  let compact: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(SHARE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    compact = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const o = compact.o;
  return parseRecord({
    version: RECORD_VERSION,
    service: compact.s,
    cloudAnchorId: compact.id,
    roomId: compact.room,
    doorInAnchor: { position: compact.p, rotation: compact.r },
    opening: Array.isArray(o) && o.length === 2 ? { width: o[0], height: o[1] } : null,
    doorSource: compact.src,
    hostedAtMs: compact.at,
    ttlDays: compact.ttl,
  });
}
