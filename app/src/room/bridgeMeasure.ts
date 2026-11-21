/**
 * Measuring the bridge of a room (`localization-server/docs/api-v2.md`, section 11, way
 * A): the staff phone is located BOTH ways in one AR session - by the venue's server
 * (the running provider; the door layer writes the result into `roomStore.found`) and by
 * ReactVision (the library's tracker, asked through `vpsBridge`) - and the server is sent
 * where each of them puts its map in that session. It works out how the service's map
 * lies in the room's frame and stores that with the room. From then on the room's one
 * door serves both ways.
 *
 * NOT RUN AT ALL: there is no ReactVision account yet. In particular it is not known
 * whether the library's tracker and the recording of a `/localize` clip can work in one
 * AR session at the same time; here the room is found first and the tracker started after.
 */
import { useSyncExternalStore } from 'react';

import { arCamera } from '../localization/arCamera';
import { cameraMatrix, mapInSession, parseRenderPose, SteadyAlignment } from '../localization/core/vpsAlignment';
import { vpsProblem } from '../localization/core/vpsStatus';
import { BRIDGE, BridgeSamples } from '../localization/core/ways';
import { vpsBridge, type VpsEvent } from '../localization/vpsBridge';
import { rowsFromMatrix } from '../door/core/roomFrame';
import { measureBridge } from '../server/core/client';
import type { RoomBridge } from '../server/core/roomPlan';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { getPrefs } from '../state/prefs';
import { getRoomScanState, subscribeRoomScan } from './roomStore';
import { roomsActions } from './roomsStore';

const log = (text: string) => appActions.log(`bridge: ${text}`);

export interface BridgeState {
  /**
   *  - `finding`: the room is being found through the venue's server;
   *  - `walking`: both ways track, samples are being collected;
   *  - `sending`: the server is working the bridge out;
   *  - `done` / `failed`: see `result` / `failure`.
   */
  phase: 'idle' | 'finding' | 'walking' | 'sending' | 'done' | 'failed';
  mapId: string | null;
  count: number;
  /** The measurement may be ended by hand now. */
  enough: boolean;
  result: RoomBridge | null;
  /**
   * `cloud`: the service did not recognise the place, or refused; `server`: the venue's
   * server did not answer; `disagree`: it answered that the samples do not fit together.
   */
  failure: 'cloud' | 'server' | 'disagree' | null;
}

const IDLE: BridgeState = { phase: 'idle', mapId: null, count: 0, enough: false, result: null, failure: null };

let state: BridgeState = IDLE;
const listeners = new Set<() => void>();

function setState(patch: Partial<BridgeState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function getBridgeState(): BridgeState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBridge<T>(selector: (s: BridgeState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

let locationId = '';
/** The room's frame in the session the samples were taken in (16 numbers), or null. */
let roomTransform: number[] | null = null;
const samples = new BridgeSamples();
const steady = new SteadyAlignment();
let offEvents: (() => void) | null = null;
let offStore: (() => void) | null = null;
let giveUp: ReturnType<typeof setTimeout> | null = null;

function release(): void {
  offEvents?.();
  offStore?.();
  offEvents = null;
  offStore = null;
  if (giveUp !== null) {
    clearTimeout(giveUp);
    giveUp = null;
  }
  vpsBridge.stop();
}

function fail(failure: BridgeState['failure'], why: string): void {
  log(`not measured: ${why}`);
  release();
  setState({ phase: 'failed', failure });
}

/** Follows whether the room is found: the samples are only worth something within one frame of the session. */
function followRoom(): void {
  const found = getRoomScanState().found;
  if (state.phase !== 'finding' && state.phase !== 'walking') {
    return;
  }
  const usable = found !== null && found.mapId === state.mapId && found.strong;
  if (usable && state.phase === 'finding') {
    roomTransform = found.transform;
    samples.reset();
    steady.reset();
    setState({ phase: 'walking', count: 0, enough: false });
    log('the room is found through the server - asking ReactVision for the place');
    vpsBridge.track(locationId, getPrefs().vpsServerMode ? 'server' : 'device');
    giveUp = setTimeout(() => {
      if (state.phase === 'walking' && samples.count === 0) {
        fail('cloud', `ReactVision did not recognise the place within ${BRIDGE.giveUpS} s`);
      }
    }, BRIDGE.giveUpS * 1000);
  } else if (!found && state.phase === 'walking') {
    // Tracking was interrupted: the session's frame may have changed under the samples.
    log('the room was lost - starting over');
    vpsBridge.stop();
    if (giveUp !== null) {
      clearTimeout(giveUp);
      giveUp = null;
    }
    roomTransform = null;
    samples.reset();
    setState({ phase: 'finding', count: 0, enough: false });
    appActions.requestRelocalize();
  }
}

function onVps(event: VpsEvent): void {
  if (state.phase !== 'walking') {
    return;
  }
  if (event.kind === 'started' && !event.success) {
    if (vpsProblem(event.code) !== null) {
      fail('cloud', event.message || event.code || 'the place could not be loaded');
    }
    return;
  }
  if (event.kind === 'state') {
    if ((event.state === 'error' || event.state === 'unsupported') && vpsProblem(event.code || 'UNKNOWN') !== null) {
      fail('cloud', event.message || event.state);
    }
    return;
  }
  if (event.kind !== 'localized') {
    return;
  }
  const camera = arCamera.get();
  if (!camera) {
    return;
  }
  const reading = mapInSession(cameraMatrix(camera.position, camera.forward, camera.up), parseRenderPose(event.renderPose));
  const map = reading ? steady.add(reading, Date.now()) : null;
  if (map && samples.offer(map, camera.position, Date.now())) {
    setState({ count: samples.count, enough: samples.enough });
    log(`sample ${samples.count} of ${BRIDGE.samples}`);
    if (samples.complete) {
      void finishBridgeMeasure();
    }
  }
}

/**
 * Starts a measurement for a room that has a place at ReactVision. The AR view has to be
 * open with the venue's server as the way (`flows.openBridge` sees to that).
 */
export function startBridgeMeasure(mapId: string, place: string): void {
  release();
  locationId = place;
  roomTransform = null;
  samples.reset();
  steady.reset();
  state = { ...IDLE, phase: 'finding', mapId };
  listeners.forEach((listener) => listener());
  offEvents = vpsBridge.onEvent(onVps);
  offStore = subscribeRoomScan(followRoom);
  followRoom();
}

/** Sends what was collected. Called when the samples are complete, or by "Finish". */
export async function finishBridgeMeasure(): Promise<void> {
  if (state.phase !== 'walking' || !samples.enough || !roomTransform || !state.mapId) {
    return;
  }
  const mapId = state.mapId;
  const body = { T_arworld_from_map: rowsFromMatrix(roomTransform), location_id: locationId, samples: samples.body() };
  release();
  setState({ phase: 'sending' });
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    fail('server', 'the server is not connected');
    return;
  }
  const answer = await measureBridge(baseUrl, mapId, body);
  const now = getBridgeState();
  if (now.phase !== 'sending' || now.mapId !== mapId) {
    return; // closed meanwhile
  }
  if (!answer.ok) {
    fail(answer.status === 422 ? 'disagree' : 'server', answer.reason);
    return;
  }
  const bridge = answer.value.vps?.bridge ?? null;
  if (!bridge) {
    fail('server', 'the server stored no bridge');
    return;
  }
  log(
    `measured for "${mapId}" from ${bridge.samples ?? samples.count} samples` +
      (bridge.positionErrorM === null ? '' : `, error about ${(bridge.positionErrorM * 100).toFixed(1)} cm`) +
      (bridge.rotationErrorDeg === null ? '' : ` and ${bridge.rotationErrorDeg.toFixed(1)} deg`),
  );
  await roomsActions.refresh();
  setState({ phase: 'done', result: bridge });
}

/** The screen was left: nothing is sent. */
export function stopBridgeMeasure(): void {
  release();
  roomTransform = null;
  samples.reset();
  state = IDLE;
  listeners.forEach((listener) => listener());
}

/** A bridge is being measured: the library's tracker has to be in the scene. */
export function bridgeMeasuring(s: BridgeState): boolean {
  return s.phase === 'finding' || s.phase === 'walking';
}
