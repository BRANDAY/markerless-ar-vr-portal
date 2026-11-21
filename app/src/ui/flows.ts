/**
 * The paths that lead from one screen to another and change more than the screen
 * (`docs/product/ui-spec.md`, section 4).
 */
import { t } from '../i18n';
import { newRoomId, nextRoomNumber } from '../room/roomNames';
import { sendCapture } from '../room/roomServer';
import { currentRoomId, getRoomsState, roomName } from '../room/roomsStore';
import { getRoomScanState, isBuilding, roomActions, type ScanTarget } from '../room/roomStore';
import { type CaptureSummary, scanController } from '../room/scanController';
import { serverConnection } from '../server/ServerConnection';
import { appActions, getAppState } from '../state/appStore';
import { getPrefs } from '../state/prefs';

/**
 * Opens the AR screen. The app chooses how the door is placed: `room` = in the doorway
 * of the scanned room, found with the server's help; `free` = two metres in front of the
 * user, without a server ("Try a door without a server").
 */
export function openDoor(source: 'room' | 'free'): void {
  if (warnAboutDevice()) {
    return;
  }
  appActions.setProvider(source === 'room' ? 'self-hosted' : 'manual');
  appActions.go('ar');
}

/** The ids and the names of the rooms the server has. */
function knownRooms(): { ids: string[]; names: string[] } {
  const ids = serverConnection.getView().connection.info?.maps ?? [];
  return { ids, names: getRoomsState().rooms.map((room) => room.label).filter(Boolean) };
}

/**
 * The guided scan (`ui-spec.md`, 5.5-5.7). `new` = a room the server does not have yet
 * ("Scan this room", "Scan another room"); `again` = a new scan of a room, which replaces
 * its map: `target` if given (a scan that failed), else the room the app works with.
 */
export function openGuidedScan(kind: 'new' | 'again', target?: ScanTarget | null): void {
  if (isBuilding(getRoomScanState().build)) {
    appActions.go('build'); // one scan at a time: show the one that is under way
    return;
  }
  if (warnAboutDevice()) {
    return;
  }
  if (serverConnection.getView().connection.state !== 'connected') {
    appActions.showProblem('server');
    return;
  }
  const current = currentRoomId();
  let scanTarget: ScanTarget;
  if (kind === 'again' && target) {
    scanTarget = target;
  } else if (kind === 'again' && current) {
    scanTarget = { mapId: current, label: roomName(current), replace: true };
  } else {
    const { ids, names } = knownRooms();
    const label = t('scanPrepare.name.default', { n: nextRoomNumber(ids, names, (n) => t('scanPrepare.name.default', { n })) });
    scanTarget = { mapId: newRoomId(label, ids), label, replace: false };
  }
  roomActions.setScanTarget(scanTarget);
  appActions.go('scanPrepare');
}

/**
 * "Start scanning". `name` is what the user typed for a new room; it becomes the room's
 * label and, made safe, its id.
 */
export function startScanning(name: string): void {
  const target = getRoomScanState().scanTarget;
  if (!target) {
    appActions.resetTo(homeScreen());
    return;
  }
  if (!target.replace) {
    const label = name.trim() || target.label;
    roomActions.setScanTarget({ mapId: newRoomId(label, knownRooms().ids), label, replace: false });
  }
  // On before the AR view exists: switching the room mesh on later drops the planes found so far.
  scanController.setScanning(true);
  appActions.replace('scan');
}

/** The scan screen is left without a scan. */
export function leaveScan(): void {
  scanController.setScanning(false);
  roomActions.setScanTarget(null);
  appActions.resetTo(homeScreen());
}

/** "Finish scan": the recording is saved; the build screen sends it at once. */
export function beginBuild(capture: CaptureSummary | null): void {
  const target = getRoomScanState().scanTarget;
  scanController.setScanning(false);
  roomActions.setScanTarget(null);
  if (!target) {
    appActions.resetTo(homeScreen());
    return;
  }
  appActions.resetTo('build');
  if (capture) {
    void sendCapture(target, capture.dir);
  } else {
    // The recording could not be saved: there is nothing to send.
    roomActions.resetBuild();
    roomActions.setBuild({ phase: 'failed', failure: 'bad_recording', target });
  }
}

/** "See the room", after a build: the room is the current one now. */
export function seeRoom(): void {
  roomActions.resetBuild();
  appActions.resetTo(homeScreen());
}

let deviceWarningShown = false;

/**
 * "This phone can't show AR", when the AR engine said so. Shown once per app run and
 * not enforced: the engine's answer has not been checked on a device yet, and a wrong
 * "no" must not lock the user out of the camera screens.
 */
function warnAboutDevice(): boolean {
  if (getAppState().arSupported === false && !deviceWarningShown) {
    deviceWarningShown = true;
    appActions.showProblem('device');
    return true;
  }
  return false;
}

/** Where "close" on the AR screen and the end of a path lead: Home, or the visitor welcome. */
export function homeScreen(): 'home' | 'visitor' {
  return getPrefs().visitorMode ? 'visitor' : 'home';
}

/** Starts a search for a server on the Wi-Fi unless one is already running. */
export function searchForServer(): void {
  if (serverConnection.getView().connection.state !== 'searching') {
    void serverConnection.findAutomatically();
  }
}
