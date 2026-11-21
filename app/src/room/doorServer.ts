/**
 * The staff's door and the server (`docs/product/ui-spec.md`, 5.14;
 * `localization-server/docs/api-v2.md`, section 5): saving the door that was placed in
 * the running AR session, and removing a saved door.
 */
import { doorRecordBody } from '../door/core/placement';
import { quaternionFromYaw, toMap } from '../localization/core/vpsAlignment';
import { patchRoomVps, removeDoor, type RoomVpsBody, saveDoor } from '../server/core/client';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { type DoorDraft, sizeLabel } from '../ui/core/doorEdit';
import { noteDoorRecord } from '../door/doorRecords';
import { getRoomScanState } from './roomStore';
import { roomsActions, usesCloud, vpsOfRoom } from './roomsStore';

const log = (text: string) => appActions.log(`door: ${text}`);

export type DoorSaveResult =
  | { ok: true }
  /**
   * `no-room`: the room is not found in this AR session (any more); `refused`: the server
   * answered, but did not take the door; `no-answer`: it did not answer.
   */
  | { ok: false; why: 'no-room' | 'refused' | 'no-answer' };

/**
 * Whether the size of a door placed by hand is stored: by the venue's server when it
 * announces the capability `door_size`; always with ReactVision as the connection method,
 * whose door is stored with its size in the room's `vps` entry.
 */
export function serverKeepsDoorSize(): boolean {
  return usesCloud() || (serverConnection.getView().connection.info?.capabilities.includes('door_size') ?? false);
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The room's entry at ReactVision as the server takes it: location id, and the door if there is one. */
function vpsBody(locationId: string, door: RoomVpsBody['door'] | null): RoomVpsBody {
  const body: RoomVpsBody = { provider: 'reactvision', location_id: locationId };
  return door ? { ...body, door } : body;
}

/**
 * The same button for a room found through ReactVision: the door goes from the session
 * into the frame of that service's map (`core/vpsAlignment.ts`) and is stored with the
 * room's location id on the venue's server, which hands it to every phone
 * (`PATCH /maps/{id}`, api-v2 section 11). The service itself cannot store it.
 */
async function saveCloudDoor(
  baseUrl: string,
  mapId: string,
  vps: { locationId: string; map: Parameters<typeof toMap>[0] },
  draft: DoorDraft,
): Promise<DoorSaveResult> {
  const inMap = toMap(vps.map, { position: draft.position, yawDeg: draft.yaw });
  const answer = await patchRoomVps(
    baseUrl,
    mapId,
    vpsBody(vps.locationId, {
      position: [round(inMap.position[0], 3), round(inMap.position[1], 3), round(inMap.position[2], 3)],
      quaternion_xyzw: quaternionFromYaw(inMap.yawDeg).map((n) => round(n, 6)) as [number, number, number, number],
      width: draft.width,
      height: draft.height,
    }),
  );
  if (!answer.ok) {
    log(`not saved for ReactVision: ${answer.reason}`);
    return { ok: false, why: answer.status === null ? 'no-answer' : 'refused' };
  }
  log(
    `saved for ReactVision in "${mapId}", ${sizeLabel(draft)}; in the service's map at ` +
      `${inMap.position.map((n) => n.toFixed(2)).join(', ')}, heading ${inMap.yawDeg.toFixed(0)}`,
  );
  await roomsActions.refresh();
  return { ok: true };
}

/**
 * The room's location id at ReactVision, typed in by staff (Settings, Connection). An
 * empty id removes the entry. A changed id drops the door that was saved for the old one:
 * it stood in the frame of another map. False when the server did not take it.
 */
export async function saveRoomLocation(mapId: string, locationId: string): Promise<boolean> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    log('location id not saved: the server is not connected');
    return false;
  }
  const id = locationId.trim();
  const before = vpsOfRoom(mapId);
  const door =
    before && before.locationId === id && before.door
      ? {
          position: before.door.position,
          quaternion_xyzw: before.door.quaternion,
          ...(before.door.width !== null ? { width: before.door.width } : {}),
          ...(before.door.height !== null ? { height: before.door.height } : {}),
        }
      : null;
  const answer = await patchRoomVps(baseUrl, mapId, id ? vpsBody(id, door) : null);
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
  if (found.vps) {
    return saveCloudDoor(baseUrl, found.mapId, found.vps, draft);
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
  // With ReactVision the door to remove is the one kept for that way; the location id stays.
  const cloud = usesCloud() ? vpsOfRoom(mapId) : null;
  const answer = cloud ? await patchRoomVps(baseUrl, mapId, vpsBody(cloud.locationId, null)) : await removeDoor(baseUrl, mapId);
  if (!answer.ok) {
    log(`not removed: ${answer.reason}`);
    return false;
  }
  log(`removed from "${mapId}"`);
  await roomsActions.refresh();
  return true;
}
