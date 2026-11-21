/**
 * Measurement mode: a record of where the doorway stood after every localisation, and a
 * comparison of the door with the real door opening, whose two bottom corners the user
 * marks in the current session. For the persistence tests of assignment task 5; the
 * procedure is in `docs/test-protocol.md`, the geometry and the record format in
 * `core/measurement.ts`.
 *
 * Every record goes to three places:
 *  - a readable line in the event log (and so to the server's monitoring panel);
 *  - a `measure-data {...}` line in the device log only (kept by the server in
 *    `work/device-logs/<device>.jsonl`);
 *  - the file `measurements/<run>.jsonl` in the app's documents directory.
 *
 * Records of localisations are written always, whether the panel is open or not.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { DOOR } from '../ar/doorGeometry';
import { TrackingWatch } from '../localization/core/relocalization';
import type { LocalizationContext, LocalizationReport, Unsubscribe } from '../localization/types';
import { getDeviceId, SESSION_ID } from '../server/identity';
import { APP_STARTED_AT_MS, appActions, getAppState } from '../state/appStore';
import {
  aimPointOnFloor,
  compactLine,
  compareDoor,
  type Condition,
  describeComparison,
  describeRecord,
  horizontalDistance,
  isCondition,
  type MeasureEvent,
  type MeasurementRecord,
  nextCondition,
  phonePointOnFloor,
  type Placement,
  referenceFrame,
  type V3,
} from './core/measurement';

export type MarkMethod = 'aim' | 'phone';
export type Side = 'left' | 'right';

/** A marked bottom corner of the real door opening, in the AR world frame of this session. */
export interface Mark {
  point: V3;
  method: MarkMethod;
  /** Number of tracking interruptions before the mark was made. */
  epoch: number;
}

export interface MeasureState {
  /** Measurement panel, crosshair and corner posts shown. */
  visible: boolean;
  /** The test the next records belong to. */
  condition: Condition;
  method: MarkMethod;
  left: Mark | null;
  right: Mark | null;
  /** A mark was made before tracking was interrupted: the AR frame may have shifted since. */
  stale: boolean;
  /** Records written in this app run, and how many of them are presses of "Measure". */
  records: number;
  checks: number;
  /** The newest result in words, and whether it is inside the tolerance (null: nothing compared). */
  last: string;
  lastPass: boolean | null;
  /** Where the records are saved, or why they are not. */
  file: string;
  /** How the latest search for the doorway ended (for the developer line of the AR screen). */
  placement: Placement | null;
}

const SETTINGS_FILE = 'measure-settings.json';
const FOLDER = 'measurements';

let state: MeasureState = {
  visible: false,
  condition: 'baseline',
  method: 'aim',
  left: null,
  right: null,
  stale: false,
  records: 0,
  checks: 0,
  last: '',
  lastPass: null,
  file: '',
  placement: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<MeasureState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMeasureState(): MeasureState {
  return state;
}

/** Subscribe a component to one slice of the state. Selectors must return stored values. */
export function useMeasure<T>(selector: (s: MeasureState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

let context: LocalizationContext | null = null;
let watch = new TrackingWatch();
/** Interruptions of tracking so far in this app run. */
let epoch = 0;
const records: MeasurementRecord[] = [];
let lastPlacement: Placement | null = null;
/** `Date.now()` when the door on screen was put where it stands. */
let doorPutAtMs: number | null = null;
let writing: Promise<void> = Promise.resolve();
let saveFailureLogged = false;

const log = (text: string) => appActions.log(`measure: ${text}`);
const fmt = (p: V3) => `[${p.map((v) => v.toFixed(2)).join(', ')}]`;

function saveSettings(): void {
  const { visible, condition, method } = state;
  void (async () => {
    try {
      const file = new File(Paths.document, SETTINGS_FILE);
      if (!file.exists) {
        file.create();
      }
      await file.write(JSON.stringify({ version: 1, visible, condition, method }));
    } catch {
      // Not worth a line in the log: the buttons work without the saved choice.
    }
  })();
}

function saveRecords(): void {
  const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writing = writing.then(async () => {
    try {
      const dir = new Directory(Paths.document, FOLDER);
      dir.create({ intermediates: true, idempotent: true });
      const file = new File(dir, `${SESSION_ID}.jsonl`);
      if (!file.exists) {
        file.create();
      }
      await file.write(text);
      setState({ file: `${FOLDER}/${SESSION_ID}.jsonl` });
    } catch (error) {
      setState({ file: `not saved (${String(error)})` });
      if (!saveFailureLogged) {
        saveFailureLogged = true;
        log(`could not save the records to a file: ${String(error)} - they are still in the log`);
      }
    }
  });
}

function isStale(left: Mark | null, right: Mark | null): boolean {
  return (left !== null && left.epoch < epoch) || (right !== null && right.epoch < epoch);
}

function write(event: MeasureEvent, placement: Placement | null, held: boolean): void {
  const app = getAppState();
  const shown = app.door;
  const door = shown
    ? {
        position: shown.pose.position,
        yawDeg: shown.pose.rotation[1],
        widthM: shown.opening?.width ?? DOOR.openingWidth,
        heightM: shown.opening?.height ?? DOOR.openingHeight,
        sizeFromServer: shown.opening !== undefined,
      }
    : null;
  const anyMark = state.left ?? state.right;
  const reference = anyMark
    ? {
        left: state.left?.point ?? null,
        right: state.right?.point ?? null,
        method: anyMark.method,
        beforeInterruption: state.stale,
      }
    : null;
  const record: MeasurementRecord = {
    v: 1,
    kind: 'door-measurement',
    run: SESSION_ID,
    device: getDeviceId(),
    seq: records.length + 1,
    time: new Date().toISOString(),
    condition: state.condition,
    event,
    provider: app.providerId,
    tracking: app.trackingState,
    placement,
    door,
    reference,
    comparison: door && reference ? compareDoor(door, reference) : null,
    held,
  };
  records.push(record);
  appActions.log(describeRecord(record));
  appActions.logData(compactLine(record));
  const c = record.comparison;
  setState({
    records: records.length,
    checks: state.checks + (event === 'check' ? 1 : 0),
    last: c
      ? `${event}: ${describeComparison(c)}`
      : door
        ? `${event}: door on screen, no marks to compare it with`
        : `${event}: no door on screen`,
    lastPass: c ? c.pass : null,
  });
  saveRecords();
}

export const measureController = {
  /** Reads the choices of the previous run (the test condition survives a restart of the app). */
  async start(): Promise<void> {
    try {
      const file = new File(Paths.document, SETTINGS_FILE);
      if (!file.exists) {
        return;
      }
      const json = JSON.parse(await file.text()) as Record<string, unknown>;
      setState({
        visible: json.visible === true,
        condition: isCondition(json.condition) ? json.condition : state.condition,
        method: json.method === 'phone' ? 'phone' : 'aim',
      });
      if (state.visible) {
        log(`mode on, test "${state.condition}" (as in the previous run)`);
      }
    } catch {
      // A broken settings file only means the defaults.
    }
  },

  /** Called by the AR scene: gives access to the camera pose, the floor and the tracking state. */
  attach(next: LocalizationContext): Unsubscribe {
    context = next;
    watch = new TrackingWatch();
    watch.onState(next.getTrackingState(), Date.now());
    const off = next.onTrackingState((tracking) => {
      const event = watch.onState(tracking, Date.now());
      if (event?.kind !== 'recovered') {
        return;
      }
      epoch++;
      if (state.left || state.right) {
        setState({ stale: true });
        log(
          `tracking was interrupted for ${(event.gapMs / 1000).toFixed(1)} s - check that the corner posts still stand ` +
            'on the real corners, and mark the corners again if they do not',
        );
      }
    });
    return () => {
      off();
      if (context === next) {
        context = null;
      }
    };
  },

  /** A search for the doorway ended (reported by the active provider). */
  onLocalization(report: LocalizationReport, held: boolean): void {
    const now = Date.now();
    // "App start to door" means the moment the door shown was put on screen: a later
    // answer that only confirms it does not make the door any later.
    let doorAt = now;
    if (report.event === 'placed' || report.event === 'moved') {
      doorPutAtMs = now;
    } else if (report.event === 'confirmed' || report.event === 'kept') {
      doorAt = doorPutAtMs ?? now;
    }
    const placement: Placement = {
      event: report.event,
      reason: report.reason,
      attempts: report.attempts,
      elapsedMs: report.elapsedMs,
      sinceStartMs: doorAt - APP_STARTED_AT_MS,
      trusted: report.trusted,
      quality: report.server?.quality ?? null,
      inliers: report.server?.inliers ?? null,
      source: report.server?.source ?? null,
      confidence: report.server?.confidence ?? null,
    };
    lastPlacement = placement;
    setState({ placement });
    write(report.event, placement, held);
  },

  /** "Measure": the result of one trial - the door on screen against the marks. */
  measureNow(): void {
    write('check', lastPlacement, false);
  },

  toggleVisible(): void {
    setState({ visible: !state.visible });
    saveSettings();
  },

  nextCondition(): void {
    setState({ condition: nextCondition(state.condition) });
    saveSettings();
  },

  toggleMethod(): void {
    setState({ method: state.method === 'aim' ? 'phone' : 'aim' });
    saveSettings();
  },

  /**
   * Marks a bottom corner of the real opening: the point of the floor under the crosshair
   * ("aim"), or the point of the floor straight below the phone ("phone").
   */
  mark(side: Side): void {
    if (!context) {
      return;
    }
    if (context.getTrackingState() !== 'normal') {
      log('cannot mark a corner: tracking is not NORMAL');
      return;
    }
    const camera = context.getCameraPose();
    if (!camera) {
      log('cannot mark a corner: no camera pose yet');
      return;
    }
    const plane = context.getFloorY();
    const doorY = getAppState().door?.pose.position[1] ?? null;
    const floorY = plane ?? doorY;
    if (floorY === null) {
      log('cannot mark a corner: no floor found yet - move the phone so that it sees the floor');
      return;
    }
    const floorFrom = plane !== null ? 'floor from a detected plane' : 'floor at the height of the door';
    let point: V3;
    let how: string;
    if (state.method === 'aim') {
      const aim = aimPointOnFloor(camera.position, camera.forward, floorY);
      if (!aim.ok) {
        log(`cannot mark a corner: ${aim.reason}`);
        return;
      }
      point = aim.point;
      how = `aimed from ${aim.distanceM.toFixed(2)} m, ${aim.pitchDeg.toFixed(0)} deg down, phone ${(camera.position[1] - floorY).toFixed(2)} m above the floor`;
    } else {
      point = phonePointOnFloor(camera.position, floorY);
      how = `below the phone, ${(camera.position[1] - floorY).toFixed(2)} m above the floor`;
    }
    const previous = state[side];
    const mark: Mark = { point, method: state.method, epoch };
    const left = side === 'left' ? mark : state.left;
    const right = side === 'right' ? mark : state.right;
    setState({ left, right, stale: isStale(left, right) });
    let text = `${side} corner marked at ${fmt(point)} (${how}, ${floorFrom})`;
    if (previous) {
      // Marking the same corner twice shows how repeatable the marking is - or, after an
      // interruption of tracking, how far the AR frame has shifted.
      text += ` - ${(horizontalDistance(previous.point, point) * 100).toFixed(1)} cm from the previous ${side} mark`;
    }
    log(text);
    const frame = referenceFrame({ left: left?.point ?? null, right: right?.point ?? null });
    if (frame) {
      log(`real opening by the marks: ${frame.widthM.toFixed(2)} m wide`);
    } else if (left && right) {
      log('the two marks are too close together to be the corners of a doorway - mark again');
    }
  },

  clearMarks(): void {
    setState({ left: null, right: null, stale: false });
    log('marks cleared');
  },
};
