/**
 * The Rooms list (`docs/product/ui-spec.md`, 5.11): one row per room of the server, with
 * its state. Pure: what the server lists, what is being built and how the last searches
 * went come in from outside.
 */

/** The state of a row, as the table of 5.11 names them. */
export type RoomRowState = 'ready' | 'no-door' | 'building' | 'changed';

export interface RoomRow {
  mapId: string;
  /** The name the server keeps for the room; empty when it has none. */
  label: string;
  state: RoomRowState;
  /** For `building`: 0..100. */
  percent: number;
  /** The server does not list this room yet: it is being built for the first time. */
  unbuilt: boolean;
}

/** A room is "changed" once it was not found in this many AR sessions in a row. */
export const MISSED_SESSIONS = 3;

export interface RoomsInput {
  rooms: readonly { mapId: string; label: string; portalConfirmed: boolean }[];
  /** The build under way, if any. */
  building: { mapId: string; label: string; percent: number } | null;
  /** Per room: in how many AR sessions in a row it was not found. Anything, as read from the phone's file. */
  missed: unknown;
}

function missedOf(missed: unknown, mapId: string): number {
  if (missed === null || typeof missed !== 'object' || Array.isArray(missed)) {
    return 0;
  }
  const value = (missed as Record<string, unknown>)[mapId];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The rows, in the server's order. A build shows on its room's row; a room that is being
 * built for the first time gets a row of its own at the end. A room that keeps not being
 * found says so even when it has a door: that door is of no use there.
 */
export function roomRows(input: RoomsInput): RoomRow[] {
  const { building } = input;
  const rows: RoomRow[] = input.rooms.map((room) => {
    const beingBuilt = building !== null && building.mapId === room.mapId;
    const state: RoomRowState = beingBuilt
      ? 'building'
      : missedOf(input.missed, room.mapId) >= MISSED_SESSIONS
        ? 'changed'
        : room.portalConfirmed
          ? 'ready'
          : 'no-door';
    return { mapId: room.mapId, label: room.label, state, percent: beingBuilt ? clampPercent(building.percent) : 0, unbuilt: false };
  });
  if (building && !input.rooms.some((room) => room.mapId === building.mapId)) {
    rows.push({ mapId: building.mapId, label: building.label, state: 'building', percent: clampPercent(building.percent), unbuilt: true });
  }
  return rows;
}

function clampPercent(percent: number): number {
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
}

/** The colour of the row's tile. */
export function rowTone(state: RoomRowState): 'teal' | 'amber' | 'danger' {
  return state === 'ready' ? 'teal' : state === 'changed' ? 'danger' : 'amber';
}

/** What the row's menu offers. Rename and Delete only where the server can do them. */
export interface RoomMenu {
  /** `move` when the room has a door, `place` when it has none. */
  door: 'move' | 'place';
  removeDoor: boolean;
  changeSpace: boolean;
  scanAgain: boolean;
  rename: boolean;
  remove: boolean;
}

/** Null for a room that is being built: there is nothing to do with it until the map is there. */
export function roomMenu(row: RoomRow, hasDoor: boolean, serverCanAdminister: boolean): RoomMenu | null {
  if (row.state === 'building') {
    return null;
  }
  return {
    door: hasDoor ? 'move' : 'place',
    removeDoor: hasDoor,
    changeSpace: true,
    scanAgain: true,
    rename: serverCanAdminister,
    remove: serverCanAdminister,
  };
}

/**
 * The count of AR sessions in a row in which a room was not found, after one more
 * session: found = the count starts anew, not found = one more. The same record is
 * returned when nothing changes.
 */
export function afterSession(missed: unknown, mapId: string, found: boolean): Record<string, number> {
  const kept: Record<string, number> = {};
  if (missed !== null && typeof missed === 'object' && !Array.isArray(missed)) {
    for (const key of Object.keys(missed as Record<string, unknown>)) {
      const count = missedOf(missed, key);
      if (count > 0) {
        kept[key] = count;
      }
    }
  }
  if (found) {
    delete kept[mapId];
  } else {
    kept[mapId] = (kept[mapId] ?? 0) + 1;
  }
  return kept;
}

/**
 * Whether a stay on a camera screen counts as "the room was not found": the search gave
 * up after its attempts, and the server did compare what the camera saw with the room.
 * A search without one answer (no clip recorded, requests failed) says nothing about the
 * room, and neither does any other trouble.
 */
export function sessionMissed(status: string, meta: { code?: string; unanswered?: boolean }): boolean {
  return status === 'lost' && meta.code === 'not-recognised' && meta.unanswered !== true;
}

/**
 * What is kept per room, without this one room. The other entries stay as they are: they
 * may belong to the rooms of another server this phone connects to.
 */
export function withoutRoom<T>(record: unknown, mapId: string): Record<string, T> {
  const kept: Record<string, T> = {};
  if (record !== null && typeof record === 'object' && !Array.isArray(record)) {
    for (const [key, value] of Object.entries(record as Record<string, T>)) {
      if (key !== mapId) {
        kept[key] = value;
      }
    }
  }
  return kept;
}

/** A room name as typed: trimmed, at most 80 characters (the server's limit); null when nothing is left. */
export function roomLabel(typed: string): string | null {
  const label = typed.replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return label ? label : null;
}
