/**
 * The space behind the door follows the room (`docs/product/ui-spec.md`, 5.10: "The chosen
 * space is stored per room"). The rule is in `core/choice.ts`; here it is tied to the
 * stores: the choice is kept in the phone's preferences, and what the scene draws is
 * `appStore.environment`.
 *
 * KEPT ON THIS PHONE ONLY: the server has no place for a room's space yet (spec section
 * 9, S5), so another phone shows the first space of the list until it does.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { currentRoomId, useRooms } from '../room/roomsStore';
import { getRoomScanState, useRoomScan } from '../room/roomStore';
import { serverConnection } from '../server/ServerConnection';
import { appActions, type EnvironmentId } from '../state/appStore';
import { getPrefs, prefsActions, usePrefs } from '../state/prefs';
import { chosenSpaceId, listedSpaces, withChoice } from './core/choice';
import { SPACES } from './spaces';

/** The room whose door is meant: the one found in this AR session, else the one the app works with. */
export function roomOfSpace(): string | null {
  return getRoomScanState().found?.mapId ?? currentRoomId();
}

/** The space chosen while the app had no room to keep it for: it holds for this run. */
let chosenWithoutRoom: EnvironmentId | null = null;
const NO_ROOM = '';

export function spaceOfRoom(roomId: string | null): EnvironmentId {
  const { spaceByRoom, developerOptions } = getPrefs();
  const id =
    roomId === null
      ? chosenSpaceId(SPACES, chosenWithoutRoom ? { [NO_ROOM]: chosenWithoutRoom } : {}, NO_ROOM, developerOptions)
      : chosenSpaceId(SPACES, spaceByRoom, roomId, developerOptions);
  return SPACES.find((space) => space.id === id)?.id ?? SPACES[0].id;
}

/** "Put behind my door": the space of the room from now on, and what the door shows at once. */
export function putBehindDoor(id: EnvironmentId): void {
  const roomId = roomOfSpace();
  if (roomId) {
    prefsActions.set({ spaceByRoom: withChoice(getPrefs().spaceByRoom, roomId, id) });
  } else {
    chosenWithoutRoom = id;
  }
  appActions.setEnvironment(id);
  appActions.log(`space: "${id}" behind the door of ${roomId ? `room "${roomId}"` : 'no room (this run only)'}`);
}

/** Developer switch "Test room": the test room behind the door, or the first space a staff member is offered. */
export function putTestRoom(on: boolean): void {
  putBehindDoor(on ? 'test-room' : (listedSpaces(SPACES, false)[0]?.id ?? SPACES[0].id));
}

/** Keeps the scene's space the one chosen for the room. Mounted once, at the root. */
export function useSpaceOfRoom(): void {
  const loaded = usePrefs((s) => s.loaded);
  const byRoom = usePrefs((s) => s.spaceByRoom);
  const developer = usePrefs((s) => s.developerOptions);
  const lastRoomId = usePrefs((s) => s.lastRoomId);
  const visitorMode = usePrefs((s) => s.visitorMode);
  const rooms = useRooms((s) => s.rooms);
  const found = useRoomScan((s) => s.found?.mapId ?? null);
  // The rooms the server itself reports: `currentRoomId` goes by them.
  const serverRooms = useSyncExternalStore(
    (listener) => serverConnection.subscribe(() => listener()),
    () => (serverConnection.getView().connection.info?.maps ?? []).join('\n'),
  );
  useEffect(() => {
    if (loaded) {
      appActions.setEnvironment(spaceOfRoom(roomOfSpace()));
    }
    // The room depends on the lists of rooms, the mode and the room used last; the choice on the rest.
  }, [loaded, byRoom, developer, lastRoomId, visitorMode, rooms, serverRooms, found]);
}
