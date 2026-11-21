/**
 * What a visitor's phone settles BEFORE its camera opens (the owner's decision of
 * 2026-11-21): the server is reached, the connection to it is good enough, and the server
 * has a room with a saved door. Without that, looking around with the camera cannot give
 * a door, so the camera is not opened and no look for the room is made; the screen says
 * what is wrong and offers "Try again".
 *
 * The address saved after the last connection is tried first; the network is searched
 * only when it does not answer.
 */
import { getRoomsState, roomsActions } from '../room/roomsStore';
import { appActions } from '../state/appStore';
import { judgeLink, LINK, type LinkVerdict } from './core/linkQuality';
import { serverConnection } from './ServerConnection';
import { getPhoneNetworkState } from './wifiRoute';

export type CheckStep = 'connecting' | 'searching' | 'link' | 'door';
export type CheckFailure = 'noServer' | 'wifi' | 'version' | 'slow' | 'noDoor';
export type CheckResult = { ok: true; verdict: LinkVerdict } | { ok: false; why: CheckFailure; verdict?: LinkVerdict };

/** The saved address gets this long to answer before the network is searched. */
const SAVED_ADDRESS_PATIENCE_MS = 5000;

function log(text: string): void {
  appActions.log(`visitor check: ${text}`);
}

function connectionState(): string {
  return serverConnection.getView().connection.state;
}

/** Resolves when the connection has left `connecting`, or after `patienceMs`. */
function settled(patienceMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (connectionState() !== 'connecting') {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        off();
        resolve();
      }
    };
    const timer = setTimeout(finish, patienceMs);
    const off = serverConnection.subscribe((view) => {
      if (view.connection.state !== 'connecting') {
        finish();
      }
    });
  });
}

export async function checkBeforeCamera(onStep: (step: CheckStep) => void): Promise<CheckResult> {
  const started = Date.now();
  // 1. The saved address first.
  onStep('connecting');
  await serverConnection.ready;
  await settled(SAVED_ADDRESS_PATIENCE_MS);
  // 2. Only when it gave no server: the network.
  if (connectionState() !== 'connected' && connectionState() !== 'incompatible') {
    onStep('searching');
    log(`no server at the saved address (${connectionState()}) - searching the network`);
    await serverConnection.findAutomatically();
    await settled(SAVED_ADDRESS_PATIENCE_MS);
  }
  if (connectionState() === 'incompatible') {
    log('the server is another version');
    return { ok: false, why: 'version' };
  }
  if (connectionState() !== 'connected') {
    const onWifi = getPhoneNetworkState()?.wifiConnected !== false;
    log(onWifi ? 'no server found' : 'the phone is not on Wi-Fi');
    return { ok: false, why: onWifi ? 'noServer' : 'wifi' };
  }
  // 3. How good the connection is.
  onStep('link');
  const verdict = judgeLink(await serverConnection.measureLink(LINK.probes, LINK.gapMs, LINK.timeoutMs));
  log(
    `link ${verdict.good ? 'good' : 'BAD'}: median ${verdict.medianMs ?? '-'} ms, ${verdict.lost} of ${verdict.probes} unanswered ` +
      `(bad from ${LINK.maxLost + 1} unanswered or a median over ${LINK.maxMedianMs} ms)`,
  );
  if (!verdict.good) {
    return { ok: false, why: 'slow', verdict };
  }
  // 4. A room with a saved door.
  onStep('door');
  await roomsActions.refresh();
  const rooms = getRoomsState().rooms;
  const withDoor = rooms.filter((room) => room.portalConfirmed).length;
  log(`${rooms.length} room(s) on the server, ${withDoor} with a saved door; ${((Date.now() - started) / 1000).toFixed(1)} s in all`);
  if (withDoor === 0) {
    return { ok: false, why: 'noDoor', verdict };
  }
  return { ok: true, verdict };
}
