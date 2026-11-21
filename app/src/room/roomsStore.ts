/**
 * The rooms the connected server has, and the plan and doorway of the room the app works
 * with, for the screens outside AR (Home, Rooms, Room and doorway). Everything here is in
 * the MAP frame of a room - unlike `roomStore.ts`, whose plan is in the frame of the
 * running AR session. Same store pattern as `appStore.ts`.
 */
import { useSyncExternalStore } from 'react';

import { getMaps, getPortal, getRoom } from '../server/core/client';
import type { ServerMapInfo, ServerPortal, ServerRoom } from '../server/core/roomPlan';
import { serverConnection } from '../server/ServerConnection';
import { getPrefs, prefsActions } from '../state/prefs';
import { pickRoom } from '../ui/core/homeView';
import { doorMayBeShown } from '../ui/core/modes';
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

/**
 * The id of the room to find or to open: the one used last if the server still has it.
 * Reads the server's own list of rooms, so it also works before `refresh` has answered.
 *
 * In visitor mode only a room with a door that staff saved will do; once the list of
 * rooms is known, a server without such a room has no room for a visitor.
 */
export function currentRoomId(): string | null {
  const ids = serverConnection.getView().connection.info?.maps ?? [];
  const { visitorMode, lastRoomId } = getPrefs();
  if (visitorMode && state.rooms.length > 0) {
    const withDoor = state.rooms
      .filter((room) => ids.includes(room.mapId) && doorMayBeShown(room.portalSource, true))
      .map((room) => room.mapId);
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
