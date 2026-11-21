/**
 * What Home shows (`docs/product/ui-spec.md`, 5.4), and which room the app works with.
 * Pure.
 */

export type HomeSituation =
  /** A room on the server can be opened. */
  | 'room-ready'
  /** Connected, but the server has no room. */
  | 'no-room'
  /** A map of a room is being sent or built. */
  | 'building'
  /** The server does not answer; a room is known from before. */
  | 'offline'
  /** The server does not answer and nothing is known about rooms. */
  | 'offline-unknown'
  /** The first connection of a launch is still being made. */
  | 'connecting'
  /** No server has ever been set up. */
  | 'no-server';

export interface HomeInput {
  /** State of the server connection (`connectionMachine.ts`). */
  connection: string;
  /** Ids of the rooms the server reports; empty when not connected. */
  rooms: string[];
  /** The room remembered from an earlier session, if any. */
  lastRoomId: string | null;
  /** A scan is being sent or its map is being built. */
  building: boolean;
}

export function homeSituation(input: HomeInput): HomeSituation {
  if (input.building) {
    return 'building';
  }
  switch (input.connection) {
    case 'connected':
      return input.rooms.length > 0 ? 'room-ready' : 'no-room';
    case 'not-configured':
      return 'no-server';
    case 'searching':
    case 'connecting':
      return 'connecting';
    default:
      // unreachable, incompatible
      return input.lastRoomId ? 'offline' : 'offline-unknown';
  }
}

/**
 * The room to work with: the one used last if the server still has it, else the room
 * called "room" (the id of the first versions of the app), else the first one listed.
 */
export function pickRoom(rooms: string[], lastRoomId: string | null): string | null {
  if (lastRoomId && rooms.includes(lastRoomId)) {
    return lastRoomId;
  }
  if (rooms.includes('room')) {
    return 'room';
  }
  return rooms[0] ?? null;
}

export type ChipState = 'connected' | 'connecting' | 'offline' | 'none';

/** The server chip of Home: a dot and a few words. */
export function chipState(connection: string): ChipState {
  switch (connection) {
    case 'connected':
      return 'connected';
    case 'searching':
    case 'connecting':
      return 'connecting';
    case 'not-configured':
      return 'none';
    default:
      return 'offline';
  }
}
