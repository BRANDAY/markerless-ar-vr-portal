/**
 * Measuring the bridge of a room (`localization-server/docs/api-v2.md`, section 11, way
 * A): the staff phone is located BOTH ways in one AR session - by the venue's server
 * (the running provider; the door layer writes the result into `roomStore.found`) and by
 * ReactVision (the library's tracker, asked through `vpsBridge`) - and the server is sent
 * where the service puts its map in that session. It works out how the service's map
 * lies in the room's frame and stores that with the room. From then on the room's one
 * door serves both ways.
 *
 * The server's alignment of the session is shared by all samples, so an error in it goes
 * into the bridge unseen (the server measured 11 cm at the door for a bridge that went
 * through one clip's alignment, against an estimate of 2.8 cm). The contract's advice is
 * to measure in the AR session that recorded the room, right after the build. This app
 * cannot: its AR view is closed while the map is built, and a new view is a new session.
 * So it does what the contract asks for "any other session": the server looks at the room
 * several times from different places first (`BRIDGE.looks`), and only then the service
 * is asked. The server's own warnings about the result are shown to the staff member.
 *
 * NOT RUN AT ALL: there is no ReactVision account yet. In particular it is not known
 * whether the library's tracker and the recording of a `/localize` clip can work in one
 * AR session; here the looks come first and the tracker is started after them.
 */
import { useSyncExternalStore } from 'react';

import { rowsFromMatrix } from '../door/core/roomFrame';
import { arCamera } from '../localization/arCamera';
import { cameraMatrix, mapInSession, parseRenderPose, SteadyAlignment } from '../localization/core/vpsAlignment';
import { vpsProblem } from '../localization/core/vpsStatus';
import { BRIDGE, BridgeSamples } from '../localization/core/ways';
import { vpsBridge, type VpsEvent } from '../localization/vpsBridge';
import { type BridgeBody, measureBridge } from '../server/core/client';
import type { RoomBridge } from '../server/core/roomPlan';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { getPrefs } from '../state/prefs';
import { type FoundRoom, getRoomScanState, subscribeRoomScan } from './roomStore';
import { roomsActions } from './roomsStore';

const log = (text: string) => appActions.log(`bridge: ${text}`);

export interface BridgeState {
  /**
   *  - `finding`: the venue's server is looking at the room, `looks` times from different places;
   *  - `walking`: both ways track, samples are being collected;
   *  - `sending`: the server is working the bridge out;
   *  - `done` / `failed`: see `result` / `failure`.
   */
  phase: 'idle' | 'finding' | 'walking' | 'sending' | 'done' | 'failed';
  mapId: string | null;
  /** Looks of the venue's server that counted so far. */
  looks: number;
  /** The staff member should go to another part of the room now; the next look follows by itself. */
  moveOn: boolean;
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

const IDLE: BridgeState = { phase: 'idle', mapId: null, looks: 0, moveOn: false, count: 0, enough: false, result: null, failure: null };

/** How often the phone's place is checked while the staff member walks to the next look. */
const MOVE_CHECK_MS = 700;

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
/** The answer of the venue's server the measurement rests on: the room in this session. */
let room: FoundRoom | null = null;
/** The answer that was counted last, and where the phone was at each look that counted. */
let countedAnswer: FoundRoom | null = null;
let lookSpots: number[][] = [];
const samples = new BridgeSamples();
const steady = new SteadyAlignment();
let offEvents: (() => void) | null = null;
let offStore: (() => void) | null = null;
let giveUp: ReturnType<typeof setTimeout> | null = null;
let moveTimer: ReturnType<typeof setInterval> | null = null;

function clearTimers(): void {
  if (giveUp !== null) {
    clearTimeout(giveUp);
    giveUp = null;
  }
  if (moveTimer !== null) {
    clearInterval(moveTimer);
    moveTimer = null;
  }
}

function release(): void {
  offEvents?.();
  offStore?.();
  offEvents = null;
  offStore = null;
  clearTimers();
  vpsBridge.stop();
}

function fail(failure: BridgeState['failure'], why: string): void {
  log(`not measured: ${why}`);
  release();
  setState({ phase: 'failed', failure });
}

const apart = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Waits until the phone is somewhere new, then has the venue's server look again. */
function waitForAnotherPlace(): void {
  if (moveTimer !== null) {
    return;
  }
  setState({ moveOn: true });
  moveTimer = setInterval(() => {
    const camera = arCamera.get();
    if (state.phase !== 'finding' || !camera) {
      return;
    }
    if (lookSpots.every((spot) => apart(spot, camera.position) >= BRIDGE.lookApartM)) {
      if (moveTimer !== null) {
        clearInterval(moveTimer);
        moveTimer = null;
      }
      setState({ moveOn: false });
      appActions.requestRelocalize();
    }
  }, MOVE_CHECK_MS);
}

/** Both ways are needed from here on: the service is asked for the place. */
function startWalking(found: FoundRoom): void {
  room = found;
  samples.reset();
  steady.reset();
  clearTimers();
  setState({ phase: 'walking', moveOn: false, count: 0, enough: false });
  log(`the server has looked at the room ${lookSpots.length} times - asking ReactVision for the place`);
  vpsBridge.track(locationId, getPrefs().vpsServerMode ? 'server' : 'device');
  giveUp = setTimeout(() => {
    if (state.phase === 'walking' && samples.count === 0) {
      fail('cloud', `ReactVision did not recognise the place within ${BRIDGE.giveUpS} s`);
    }
  }, BRIDGE.giveUpS * 1000);
}

/** Follows whether the room is found: looks and samples are only worth something within one frame of the session. */
function followRoom(): void {
  const found = getRoomScanState().found;
  if (state.phase !== 'finding' && state.phase !== 'walking') {
    return;
  }
  if (!found) {
    if (state.phase === 'walking' || lookSpots.length > 0) {
      // Tracking was interrupted: the session's frame may have changed under what was collected.
      log('the room was lost - starting over');
      vpsBridge.stop();
      clearTimers();
      room = null;
      countedAnswer = null;
      lookSpots = [];
      samples.reset();
      setState({ phase: 'finding', looks: 0, moveOn: false, count: 0, enough: false });
      appActions.requestRelocalize();
    }
    return;
  }
  if (found.mapId !== state.mapId) {
    return;
  }
  if (state.phase === 'walking') {
    room = found; // a later answer of the server in the same frame: its alignment has only got better
    return;
  }
  // `finding`: every new good answer taken from a new place is a look.
  if (found.strong && found !== countedAnswer) {
    countedAnswer = found;
    const camera = arCamera.get();
    const here = camera ? [...camera.position] : null;
    if (!here || lookSpots.every((spot) => apart(spot, here) >= BRIDGE.lookApartM)) {
      lookSpots.push(here ?? [0, 0, 0]);
      setState({ looks: lookSpots.length });
      log(`look ${lookSpots.length} of ${BRIDGE.looks} by the server`);
    }
  }
  if (lookSpots.length >= BRIDGE.looks) {
    startWalking(found);
  } else if (lookSpots.length > 0) {
    waitForAnotherPlace();
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
  room = null;
  countedAnswer = null;
  lookSpots = [];
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
  if (state.phase !== 'walking' || !samples.enough || !room || !state.mapId) {
    return;
  }
  const mapId = state.mapId;
  // The server knows its own alignment of this session best; without its id, the last answer is sent along.
  const body: BridgeBody = room.serverSession
    ? { session_id: room.serverSession, location_id: locationId, samples: samples.body() }
    : { T_arworld_from_map: rowsFromMatrix(room.transform), location_id: locationId, samples: samples.body() };
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
  bridge.warnings.forEach((line) => log(`the server warns: ${line}`));
  await roomsActions.refresh();
  setState({ phase: 'done', result: bridge });
}

/** The screen was left: nothing is sent. */
export function stopBridgeMeasure(): void {
  release();
  room = null;
  countedAnswer = null;
  lookSpots = [];
  samples.reset();
  state = IDLE;
  listeners.forEach((listener) => listener());
}

/** A bridge is being measured: the library's tracker has to be in the scene. */
export function bridgeMeasuring(s: BridgeState): boolean {
  return s.phase === 'finding' || s.phase === 'walking';
}
