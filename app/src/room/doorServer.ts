/**
 * The staff's door and the server (`docs/product/ui-spec.md`, 5.14;
 * `localization-server/docs/api-v2.md`, section 5): saving the door that was placed in
 * the running AR session, and removing a saved door.
 */
import { doorRecordBody } from '../door/core/placement';
import { patchRoomVps, removeDoor, saveDoor } from '../server/core/client';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { type DoorDraft, sizeLabel } from '../ui/core/doorEdit';
import { noteDoorRecord } from '../door/doorRecords';
import { getRoomScanState } from './roomStore';
import { roomsActions } from './roomsStore';

const log = (text: string) => appActions.log(`door: ${text}`);

export type DoorSaveResult =
  | { ok: true }
  /**
   * `no-room`: the room is not found in this AR session (any more); `refused`: the server
   * answered, but did not take the door; `no-answer`: it did not answer.
   */
  | { ok: false; why: 'no-room' | 'refused' | 'no-answer' };

/** Whether the server stores the size of a door placed by hand (capability `door_size`). */
export function serverKeepsDoorSize(): boolean {
  return serverConnection.getView().connection.info?.capabilities.includes('door_size') ?? false;
}

/**
 * The room's location id at ReactVision, typed in by staff (Settings, Connection). An
 * empty id removes the entry. The server keeps a measured bridge as long as the id stays
 * the same and drops it for another id. False when the server did not take it.
 */
export async function saveRoomLocation(mapId: string, locationId: string): Promise<boolean> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    log('location id not saved: the server is not connected');
    return false;
  }
  const id = locationId.trim();
  const answer = await patchRoomVps(baseUrl, mapId, id ? { provider: 'reactvision', location_id: id } : null);
  if (!answer.ok) {
    log(`location id not saved: ${answer.reason}`);
    return false;
  }
  log(id ? `ReactVision location id of "${mapId}" saved` : `ReactVision entry of "${mapId}" removed`);
  await roomsActions.refresh();
  return true;
}

/**
 * "Save door": the door as it stands in this AR session goes into the room's frame through
 * the transform the room was recognised with (`roomStore.found`), and becomes the room's
 * one door record on the server. The same for every way of recognising the room.
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
  const answer = await saveDoor(baseUrl, found.mapId, doorRecordBody(found.transform, draft, withSize));
  if (!answer.ok) {
    log(`not saved: ${answer.reason}`);
    return { ok: false, why: answer.status === null ? 'no-answer' : 'refused' };
  }
  const saved = answer.value.portal;
  if (saved) {
    noteDoorRecord(found.mapId, saved); // what every phone gets from now on
  }
  log(
    `saved in "${found.mapId}"${found.strong ? '' : ' (weak match)'}, ` +
      `${withSize ? sizeLabel(draft) : 'size not stored by this server'}` +
      (saved && saved.position ? `; in the room's frame at ${saved.position.map((n) => n.toFixed(2)).join(', ')}` : ''),
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
  await roomsActions.refresh(); // reads the record anew, for the door layer's copy too
  return true;
}
