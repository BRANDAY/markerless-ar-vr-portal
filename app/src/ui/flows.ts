/**
 * The paths that lead from one screen to another and change more than the screen
 * (`docs/product/ui-spec.md`, section 4).
 */
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { getPrefs } from '../state/prefs';

/**
 * Opens the AR screen. The app chooses how the door is placed: `room` = in the doorway
 * of the scanned room, found with the server's help; `free` = two metres in front of the
 * user, without a server ("Try a door without a server").
 */
export function openDoor(source: 'room' | 'free'): void {
  appActions.setProvider(source === 'room' ? 'self-hosted' : 'manual');
  appActions.go('ar');
}

/**
 * "Scan this room". Until the guided scan (step 4 of the spec) exists, this opens the AR
 * screen with the developer tools, whose scan panel records and uploads a room.
 */
export function openGuidedScan(): void {
  appActions.setProvider('self-hosted');
  appActions.go('ar');
  appActions.setOverlayVisible(true);
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
