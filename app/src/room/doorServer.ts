/**
 * The staff's door and the server (`docs/product/ui-spec.md`, 5.14;
 * `localization-server/docs/api-v2.md`, section 5): saving the door that was placed in
 * the running AR session, and removing a saved door.
 */
import { removeDoor, saveDoor } from '../server/core/client';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { type DoorDraft, doorSaveBody, sizeLabel } from '../ui/core/doorEdit';
import { getRoomScanState, roomActions } from './roomStore';
import { roomsActions } from './roomsStore';

const log = (text: string) => appActions.log(`door: ${text}`);

export type DoorSaveResult =
  | { ok: true }
  /**
   * `no-room`: the room is not found in this AR session (any more); `refused`: the server
   * answered, but did not take the door; `no-answer`: it did not answer.
   */
  | { ok: false; why: 'no-room' | 'refused' | 'no-answer' };

/** Whether the connected server stores the size of a door placed by hand (capability `door_size`). */
export function serverKeepsDoorSize(): boolean {
  return serverConnection.getView().connection.info?.capabilities.includes('door_size') ?? false;
}

/**
 * "Save door": the door as it stands in this AR session, with the session id whose
 * `/localize` found the room - the server converts the place through that alignment.
 */
export async function saveDoorDraft(draft: DoorDraft): Promise<DoorSaveResult> {
  const baseUrl = serverConnection.getBaseUrl();
  const found = getRoomScanState().found;
  if (!found) {
    log('not saved: the room is not found in this AR session');
    return { ok: false, why: 'no-room' };
  }
  if (!baseUrl) {
    log('not saved: the server is not connected');
    return { ok: false, why: 'no-answer' };
  }
  const withSize = serverKeepsDoorSize();
  const answer = await saveDoor(baseUrl, found.mapId, doorSaveBody(draft, found.sessionId, withSize));
  if (!answer.ok) {
    log(`not saved: ${answer.reason}`);
    if (answer.status === 422) {
      // The server has no accepted alignment for this session (it was restarted, or the
      // session is not the one it knows): the room has to be found again before a new try.
      roomActions.setFound(null);
      appActions.requestRelocalize();
    }
    return { ok: false, why: answer.status === null ? 'no-answer' : answer.status === 422 ? 'no-room' : 'refused' };
  }
  const saved = answer.value.portal;
  log(
    `saved in "${found.mapId}" (${answer.value.alignmentUsed || 'alignment not named'}` +
      `${found.strong ? '' : ', weak match'}), ${withSize ? sizeLabel(draft) : 'size not stored by this server'}` +
      (saved && saved.position ? `; in the map at ${saved.position.map((n) => n.toFixed(2)).join(', ')}` : ''),
  );
  // Before the answer: what follows (Home, the visitor screen) asks which rooms have a door.
  await roomsActions.refresh();
  return { ok: true };
}

/** "Remove the door": the room then counts as having no door. False when the server did not do it. */
export async function removeSavedDoor(mapId: string): Promise<boolean> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    log('not removed: the server is not connected');
    return false;
  }
  const answer = await removeDoor(baseUrl, mapId);
  if (!answer.ok) {
    log(`not removed: ${answer.reason}`);
    return false;
  }
  log(`removed from "${mapId}"`);
  await roomsActions.refresh();
  return true;
}
