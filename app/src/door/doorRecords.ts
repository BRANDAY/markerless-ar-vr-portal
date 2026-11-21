/**
 * The door record of a room, as the door layer reads it: one record per room, kept by the
 * venue's server in the room's frame (`localization-server/docs/api-v2.md`, section 5),
 * whatever way the room is recognised through.
 */
import { getPortal, getRoom } from '../server/core/client';
import type { ServerPortal, ServerRoom } from '../server/core/roomPlan';
import { serverConnection } from '../server/ServerConnection';

/** The record is small and the server is next door: do not hold a door back for long. */
const READ_TIMEOUT_MS = 4000;

/** For a way that answers many times a minute, a record read this recently is not read again. */
export const RECORD_FRESH_MS = 15_000;

/** Records read in this app run: what is used when the server does not answer. */
const kept = new Map<string, ServerPortal>();
/** `Date.now()` when a room's record last came from the server in this app run. */
const readAt = new Map<string, number>();
const keptPlans = new Map<string, { frameId: string; room: ServerRoom }>();

export interface DoorRead {
  record: ServerPortal;
  /** `kept`: the server did not answer, this is the copy from the last time it did. */
  from: 'server' | 'kept';
}

/** Where a copy that outlives the app run is written (set by `rememberDoorsWith`). */
let persist: ((mapId: string, record: ServerPortal) => void) | null = null;

/** Lets another module keep the records on the phone, and hands it the copies it kept before. */
export function rememberDoorsWith(save: (mapId: string, record: ServerPortal) => void, earlier: Record<string, ServerPortal>): void {
  persist = save;
  for (const [mapId, record] of Object.entries(earlier)) {
    if (!kept.has(mapId)) {
      kept.set(mapId, record);
    }
  }
}

/** A record that just came from the server by another road (the list of rooms, a save). */
export function noteDoorRecord(mapId: string, record: ServerPortal): void {
  kept.set(mapId, record);
  readAt.set(mapId, Date.now());
  persist?.(mapId, record);
}

/** The copy of a room's door record, if there is one - without asking the server. */
export function keptDoorRecord(mapId: string): ServerPortal | null {
  return kept.get(mapId) ?? null;
}

/**
 * Where in the room's frame the door stands, as far as this phone knows: the point at
 * which a way of recognising the room should be at its most careful. Null: not known.
 */
export function keptDoorPosition(mapId: string): [number, number, number] | null {
  return kept.get(mapId)?.position ?? null;
}

/**
 * The door record of a room. Null when the server does not answer and nothing was kept.
 * `freshEnoughMs`: a record that came from the server less than this ago is not read again.
 */
export async function readDoorRecord(mapId: string, freshEnoughMs = 0): Promise<DoorRead | null> {
  const baseUrl = serverConnection.getBaseUrl();
  const recent = kept.get(mapId);
  if (recent && freshEnoughMs > 0 && Date.now() - (readAt.get(mapId) ?? 0) < freshEnoughMs) {
    return { record: recent, from: 'server' };
  }
  if (baseUrl) {
    const answer = await getPortal(baseUrl, mapId, { timeoutMs: READ_TIMEOUT_MS });
    if (answer.ok) {
      noteDoorRecord(mapId, answer.value);
      return { record: answer.value, from: 'server' };
    }
  }
  const copy = kept.get(mapId);
  return copy ? { record: copy, from: 'kept' } : null;
}

/**
 * The room plan in the room's frame, for a way of recognising the room that does not hand
 * the plan out with its answer. Null when there is none to be had: a door can stand
 * without it, only the walls are not drawn.
 */
export async function readRoomPlan(mapId: string, frameId: string): Promise<ServerRoom | null> {
  // The plan of a room changes only when the room is scanned again, and then its frame has another name.
  const copy = keptPlans.get(mapId);
  if (copy && copy.frameId === frameId) {
    return copy.room;
  }
  const baseUrl = serverConnection.getBaseUrl();
  if (baseUrl) {
    const answer = await getRoom(baseUrl, mapId, { timeoutMs: READ_TIMEOUT_MS });
    if (answer.ok) {
      keptPlans.set(mapId, { frameId, room: answer.value });
      return answer.value;
    }
  }
  return copy?.room ?? null;
}
