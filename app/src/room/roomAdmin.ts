/**
 * What a staff member does with a room as a whole (`docs/product/ui-spec.md`, 5.11;
 * `localization-server/docs/api-v2.md`, section 10): rename it, delete it - and the count
 * of AR sessions in a row in which a room was not found, which is what turns its row red.
 */
import { useEffect, useRef } from 'react';

import { deleteRoom, renameRoom } from '../server/core/client';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { getPrefs, prefsActions } from '../state/prefs';
import { afterSession, onlyRooms, roomLabel } from '../ui/core/roomsView';
import { currentRoomId, getRoomsState, roomsActions } from './roomsStore';
import { useRoomScan } from './roomStore';

/** `building`: the server refuses while a map is being built for the room. */
export type AdminOutcome = 'ok' | 'building' | 'failed';

function log(message: string): void {
  appActions.log(`rooms: ${message}`);
}

/** Whether the connected server can rename and delete rooms (capability `rooms_admin`). */
export function serverAdministersRooms(): boolean {
  return serverConnection.getView().connection.info?.capabilities.includes('rooms_admin') ?? false;
}

/** "Rename": the room's name on the server; its id stays. A name of spaces only is no name. */
export async function renameRoomTo(mapId: string, typed: string): Promise<AdminOutcome> {
  const baseUrl = serverConnection.getBaseUrl();
  const label = roomLabel(typed);
  if (!baseUrl || label === null) {
    return 'failed';
  }
  const answer = await renameRoom(baseUrl, mapId, label);
  if (!answer.ok) {
    log(`"${mapId}" not renamed: ${answer.reason}`);
    return 'failed';
  }
  log(`"${mapId}" is now called "${label}"`);
  await roomsActions.refresh();
  return 'ok';
}

/**
 * "Delete": the server takes the room out of use. What is kept on this phone about the
 * room (its space, its count of failed searches) goes with it.
 */
export async function deleteRoomNow(mapId: string): Promise<AdminOutcome> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    return 'failed';
  }
  const answer = await deleteRoom(baseUrl, mapId);
  if (!answer.ok) {
    log(`"${mapId}" not deleted: ${answer.reason}`);
    return answer.status === 409 ? 'building' : 'failed';
  }
  log(`"${mapId}" deleted`);
  // The server's own list of rooms (its health answer) is what the search goes by.
  await serverConnection.checkNow();
  await roomsActions.refresh();
  const left = getRoomsState().rooms.map((room) => room.mapId).filter((id) => id !== mapId);
  const { spaceByRoom, missedByRoom } = getPrefs();
  prefsActions.set({ spaceByRoom: onlyRooms<string>(spaceByRoom, left), missedByRoom: onlyRooms<number>(missedByRoom, left) });
  return 'ok';
}

/** One more AR session with this room: found, or not found after all the attempts. */
export function noteSession(mapId: string, found: boolean): void {
  const before = getPrefs().missedByRoom;
  const after = afterSession(before, mapId, found);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    prefsActions.set({ missedByRoom: after });
    log(found ? `"${mapId}" found again` : `"${mapId}" not found in ${after[mapId]} session(s) in a row`);
  }
}

/**
 * For the screens over the camera. `notFound`: the screen has given up for now ("This
 * doesn't look like ..."). Counted once per stay on the screen; a room that is found
 * starts its count anew.
 */
export function useRoomHealth(notFound: boolean): void {
  const found = useRoomScan((s) => s.found?.mapId ?? null);
  const counted = useRef(false);
  useEffect(() => {
    if (found) {
      noteSession(found, true);
    }
  }, [found]);
  useEffect(() => {
    if (notFound && !counted.current) {
      counted.current = true;
      const mapId = currentRoomId();
      if (mapId) {
        noteSession(mapId, false);
      }
    }
  }, [notFound]);
}
