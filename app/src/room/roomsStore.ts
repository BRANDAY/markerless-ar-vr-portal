/**
 * The rooms the connected server has, and the plan and doorway of the room the app works
 * with, for the screens outside AR (Home, Rooms, Room and doorway). Everything here is in
 * the MAP frame of a room - unlike `roomStore.ts`, whose plan is in the frame of the
 * running AR session. Same store pattern as `appStore.ts`.
 */
import { useSyncExternalStore } from 'react';

import { getMaps, getPortal, getRoom } from '../server/core/client';
import type { RoomVps, ServerMapInfo, ServerPortal, ServerRoom } from '../server/core/roomPlan';
import { serverConnection } from '../server/ServerConnection';
import { getPrefs, prefsActions } from '../state/prefs';
import { pickRoom } from '../ui/core/homeView';
import { roomDisplayName } from './roomNames';

export interface RoomDetail {
  mapId: string;
  room: ServerRoom | null;
  portal: ServerPortal | null;
}

export interface RoomsState {
  /** Rooms of the connected server; kept (dimmed on screen) while the server is offline. */
  rooms: ServerMapInfo[];
  /** The room the app works with, or null when the server has none. */
  currentId: string | null;
  detail: RoomDetail | null;
  loading: boolean;
}

let state: RoomsState = { rooms: [], currentId: null, detail: null, loading: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<RoomsState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function getRoomsState(): RoomsState {
  return state;
}

export function useRooms<T>(selector: (s: RoomsState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => selector(state),
    () => selector(state),
  );
}

/** The name a room is shown under: its label from the scan, else made from its id. */
export function roomName(mapId: string | null): string {
  if (!mapId) {
    return '';
  }
  const label = state.rooms.find((room) => room.mapId === mapId)?.label;
  return label || roomDisplayName(mapId);
}

/** The connection method is ReactVision Advanced VPS (`ui-spec.md`, 5.15). */
export function usesCloud(): boolean {
  return getPrefs().connection === 'reactvision';
}

/** The copy of the rooms' ReactVision entries kept from the last time the venue's server answered. */
function keptVps(): Record<string, RoomVps> {
  const saved = getPrefs().vpsRooms;
  if (!saved) {
    return {};
  }
  try {
    const json = JSON.parse(saved) as Record<string, RoomVps>;
    const kept: Record<string, RoomVps> = {};
    for (const [mapId, entry] of Object.entries(json ?? {})) {
      if (entry && typeof entry.locationId === 'string' && entry.locationId) {
        kept[mapId] = entry;
      }
    }
    return kept;
  } catch {
    return {};
  }
}

/**
 * What the venue's server keeps about a room for ReactVision: the location id and the
 * door in that service's map. From the server's list of rooms; while the server has not
 * answered in this run, from the copy kept on the phone.
 */
export function vpsOfRoom(mapId: string | null): RoomVps | null {
  if (!mapId) {
    return null;
  }
  const listed = state.rooms.find((room) => room.mapId === mapId);
  return listed ? listed.vps : (keptVps()[mapId] ?? null);
}

/** Whether a room has a door for the connection method in use. */
export function roomHasDoor(room: ServerMapInfo): boolean {
  return usesCloud() ? room.vps?.door != null : room.portalConfirmed;
}

/**
 * The id of the room to find or to open: the one used last if the server still has it.
 * Reads the server's own list of rooms, so it also works before `refresh` has answered.
 *
 * In visitor mode only a room with a door that staff saved will do; once the list of
 * rooms is known, a server without such a room has no room for a visitor.
 *
 * With ReactVision as the connection method the venue's server is needed only for the
 * list of rooms and their doors: while it does not answer, the rooms kept on the phone
 * from the last time are used.
 */
export function currentRoomId(): string | null {
  const ids = serverConnection.getView().connection.info?.maps ?? [];
  const { visitorMode, lastRoomId } = getPrefs();
  if (usesCloud() && ids.length === 0 && state.rooms.length === 0) {
    const kept = keptVps();
    const usable = Object.keys(kept).filter((mapId) => !visitorMode || kept[mapId].door !== null);
    return pickRoom(usable, lastRoomId);
  }
  if (visitorMode && state.rooms.length > 0) {
    const withDoor = state.rooms.filter((room) => ids.includes(room.mapId) && roomHasDoor(room)).map((room) => room.mapId);
    return pickRoom(withDoor, lastRoomId);
  }
  return pickRoom(ids, lastRoomId);
}

let generation = 0;
let started = false;
let lastSeen = '';

export const roomsActions = {
  /** Follows the server connection: the list is read again whenever the server's rooms change. */
  start(): void {
    if (started) {
      return;
    }
    started = true;
    serverConnection.subscribe((view) => {
      const { state: connection, info } = view.connection;
      const seen = connection === 'connected' ? `${view.connection.address?.host}:${(info?.maps ?? []).join(',')}` : '';
      if (seen && seen !== lastSeen) {
        lastSeen = seen;
        void roomsActions.refresh();
      } else if (!seen) {
        lastSeen = '';
      }
    });
  },

  /** Reads the rooms, and the plan and doorway of the current one. Never throws. */
  async refresh(): Promise<void> {
    const baseUrl = serverConnection.getBaseUrl();
    if (!baseUrl) {
      return;
    }
    const mine = ++generation;
    setState({ loading: true });
    const maps = await getMaps(baseUrl);
    if (mine !== generation) {
      return;
    }
    if (!maps.ok) {
      setState({ loading: false });
      return;
    }
    const currentId = pickRoom(
      maps.value.map((room) => room.mapId),
      getPrefs().lastRoomId,
    );
    setState({ rooms: maps.value, currentId, detail: state.detail?.mapId === currentId ? state.detail : null });
    // Kept on the phone: with ReactVision a door can then be shown without the venue's server.
    const vps: Record<string, RoomVps> = {};
    for (const room of maps.value) {
      if (room.vps) {
        vps[room.mapId] = room.vps;
      }
    }
    const kept = Object.keys(vps).length > 0 ? JSON.stringify(vps) : null;
    if (kept !== getPrefs().vpsRooms) {
      prefsActions.set({ vpsRooms: kept });
    }
    if (currentId && currentId !== getPrefs().lastRoomId) {
      prefsActions.set({ lastRoomId: currentId });
    }
    if (!currentId) {
      setState({ loading: false });
      return;
    }
    const [room, portal] = await Promise.all([getRoom(baseUrl, currentId), getPortal(baseUrl, currentId)]);
    if (mine !== generation) {
      return;
    }
    setState({
      loading: false,
      detail: { mapId: currentId, room: room.ok ? room.value : null, portal: portal.ok ? portal.value : null },
    });
  },

  /** Makes another room the current one. */
  select(mapId: string): void {
    prefsActions.set({ lastRoomId: mapId });
    setState({ currentId: mapId, detail: null });
    void roomsActions.refresh();
  },
};
