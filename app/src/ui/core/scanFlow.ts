/**
 * The guided scan (`docs/product/ui-spec.md`, 5.6): which step it is in, what the coach
 * says, what the one button does. Pure; the screen supplies the clock and the facts.
 *
 * What makes a scan good enough is where the phone has been and how it was tilted, not
 * how far it was carried: on the first real pass (2026-11-21) a scan made by turning on
 * one spot counted "7.9 m walked" from shuffling alone, and its map recognised the room
 * only from that spot. The thresholds are starting points taken from that one scan and
 * from the server's advice for a recording (60-120 s of walking); they are to be adjusted
 * after real scans.
 */
import type { TextKey } from '../../i18n';
import { type CoachLines, trackingWarning } from './arView';

export const SCAN = {
  /** Step 1 lasts at least this long. */
  minSeconds: 60,
  /**
   * ...and until the places the phone has been cover an area at least this long: the scan
   * made from one spot covered 1.0 x 1.0 m, a round along the walls of a small 3 x 4 m room
   * covers about 1 x 2 m. A shorter area is also what "made from one spot" means.
   */
  minAreaLongM: 1.5,
  /** ...and this wide: anything narrower is a walk to and fro along one line, not a round. */
  minAreaShortM: 0.5,
  /** Tilted down the way a phone is normally held: from this angle... (the bad scan stayed near -15). */
  downFromDeg: -25,
  /** ...to this one; steeper is the floor under the feet, which tells the map nothing. */
  downToDeg: -60,
  /** Tilted up, to the top of the walls: from this angle on (the bad scan never got above level). */
  upFromDeg: 20,
  /** Held level for this long: most of one round, even in a small room. */
  minLevelSeconds: 15,
  /** Tilted down for this long: half a round in a small room at a step a second. */
  minDownSeconds: 8,
  /** Tilted up for this long: two or three sweeps to the ceiling, about a second each. */
  minUpSeconds: 3,
  /** Still on one spot after this long: the coach says that turning is not enough. */
  spotSeconds: 20,
  /** The phone "stays in one place" while it is within this distance: a turn on the heel with the phone held out stays inside it. */
  stillRadiusM: 0.6,
  /** ...for this long: a sweep from floor to ceiling in a corner takes about five seconds. */
  stillSeconds: 8,
  /** ...and for this long while the place of the door is shown, which is done standing. */
  stillSecondsDoorway: 15,
  /** From here on the scan may be finished whatever the user has confirmed. */
  hintSeconds: 150,
  /** The scan finishes by itself. */
  maxSeconds: 180,
  /** The "walls found" counter is hidden if no wall has appeared by then. */
  wallsGraceSeconds: 20,
} as const;

type P3 = readonly [number, number, number] | readonly number[];

/** What the camera has covered since the recording started; made by `addToCoverage`. */
export interface ScanCoverage {
  /** The places the phone has been, on the floor plan: one cell of `CELL_M` each, as `[x, z]` cell numbers. */
  places: readonly (readonly [number, number])[];
  /** Sides of the smallest rectangle around those places, metres; `long` >= `short`. */
  long: number;
  short: number;
  /** Lowest and highest tilt seen, degrees (0 = level, -90 = straight down); null before the first sample. */
  tiltMin: number | null;
  tiltMax: number | null;
  /** Seconds spent tilted down, held level and tilted up (the bands of `SCAN`). */
  downSeconds: number;
  levelSeconds: number;
  upSeconds: number;
  /** The last sample: the step and the time are measured from it. */
  last: { x: number; z: number; t: number } | null;
  /** Where the phone has stayed, and since when (seconds of the scan). */
  still: { x: number; z: number; since: number } | null;
}

export const NO_COVERAGE: ScanCoverage = {
  places: [],
  long: 0,
  short: 0,
  tiltMin: null,
  tiltMax: null,
  downSeconds: 0,
  levelSeconds: 0,
  upSeconds: 0,
  last: null,
  still: null,
};

/** The floor plan is counted in cells of this size: hand shake stays inside one. */
const CELL_M = 0.1;
/** A step longer than this between two camera positions is a jump of tracking, not walking. */
const MAX_STEP_M = 1;
/** No more than this is counted between two samples: a gap (tracking lost, app put aside) is not time spent looking. */
const MAX_GAP_S = 1;
/** The rectangle around the places is tried at every this many degrees: rooms do not lie along the AR axes. */
const RECT_STEP_DEG = 5;

/** Tilt of the camera from its forward vector (+Y up), degrees: 0 = level, -90 = straight down. */
export function tiltDegrees(forward: P3): number | null {
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  if (!Number.isFinite(length) || length < 1e-6) {
    return null;
  }
  return (Math.asin(Math.max(-1, Math.min(1, forward[1] / length))) * 180) / Math.PI;
}

/** Sides of the smallest rectangle (at any turn) around the visited cells, metres. */
function areaSides(places: ScanCoverage['places']): { long: number; short: number } {
  let best = { long: 0, short: 0 };
  let bestArea = Number.POSITIVE_INFINITY;
  for (let deg = 0; deg < 90; deg += RECT_STEP_DEG) {
    const cos = Math.cos((deg * Math.PI) / 180);
    const sin = Math.sin((deg * Math.PI) / 180);
    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const [x, z] of places) {
      const u = x * cos + z * sin;
      const v = z * cos - x * sin;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const a = (maxU - minU) * CELL_M;
    const b = (maxV - minV) * CELL_M;
    if (a * b < bestArea) {
      bestArea = a * b;
      best = { long: Math.max(a, b), short: Math.min(a, b) };
    }
  }
  return best;
}

/**
 * Adds one camera sample to what the scan has covered: `position` and `forward` in the AR
 * world frame (+Y up; height does not count), `t` in seconds since the recording started.
 */
export function addToCoverage(coverage: ScanCoverage, position: P3, forward: P3 | null, t: number): ScanCoverage {
  const x = position[0];
  const z = position[2];
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(t)) {
    return coverage;
  }
  const { last } = coverage;
  const next: ScanCoverage = { ...coverage, last: { x, z, t } };
  // A jump of tracking: nothing is counted from it, the next sample is measured from here.
  if (last && Math.hypot(x - last.x, z - last.z) > MAX_STEP_M) {
    return next;
  }

  const cell: readonly [number, number] = [Math.round(x / CELL_M), Math.round(z / CELL_M)];
  if (!coverage.places.some((place) => place[0] === cell[0] && place[1] === cell[1])) {
    next.places = [...coverage.places, cell];
    const sides = areaSides(next.places);
    next.long = sides.long;
    next.short = sides.short;
  }

  const tilt = forward ? tiltDegrees(forward) : null;
  if (tilt !== null) {
    next.tiltMin = coverage.tiltMin === null ? tilt : Math.min(coverage.tiltMin, tilt);
    next.tiltMax = coverage.tiltMax === null ? tilt : Math.max(coverage.tiltMax, tilt);
    const dt = last ? Math.min(MAX_GAP_S, Math.max(0, t - last.t)) : 0;
    if (tilt >= SCAN.upFromDeg) {
      next.upSeconds = coverage.upSeconds + dt;
    } else if (tilt > SCAN.downFromDeg) {
      next.levelSeconds = coverage.levelSeconds + dt;
    } else if (tilt >= SCAN.downToDeg) {
      next.downSeconds = coverage.downSeconds + dt;
    }
  }

  const { still } = coverage;
  if (!still || Math.hypot(x - still.x, z - still.z) > SCAN.stillRadiusM) {
    next.still = { x, z, since: t };
  }
  return next;
}

/** The scan covers no more than one spot: its map would know the room from there only. */
export function madeFromOneSpot(coverage: ScanCoverage): boolean {
  return coverage.long < SCAN.minAreaLongM;
}

/** The numbers of a scan for the log: "area 1.0 x 1.0 m, tilt -32..+5 deg (down 12 s, level 80 s, up 0 s)". */
export function describeCoverage(coverage: ScanCoverage): string {
  const deg = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
  const tilt =
    coverage.tiltMin === null || coverage.tiltMax === null ? 'tilt not measured' : `tilt ${deg(coverage.tiltMin)}..${deg(coverage.tiltMax)} deg`;
  return (
    `area ${coverage.long.toFixed(1)} x ${coverage.short.toFixed(1)} m, ${tilt} ` +
    `(down ${coverage.downSeconds.toFixed(0)} s, level ${coverage.levelSeconds.toFixed(0)} s, up ${coverage.upSeconds.toFixed(0)} s)`
  );
}

export interface ScanInput {
  /** The recording is running. */
  recording: boolean;
  /** Seconds since the recording started. */
  seconds: number;
  /** A horizontal plane exists. */
  floorFound: boolean;
  /** Vertical planes found. */
  walls: number;
  /** Where the phone has been and how it was tilted since the recording started. */
  coverage: ScanCoverage;
  /** The user has pressed "I showed the doorway". */
  doorwayShown: boolean;
  tracking: 'unavailable' | 'limited' | 'normal';
  trackingReason: string;
}

export type ScanButton =
  /** Step 1: disabled, counting down; `secondsLeft` 0 = the time is up, but not the walking. */
  | { kind: 'wait'; secondsLeft: number }
  /** Step 2: "I showed the doorway". */
  | { kind: 'showed' }
  /** Step 3: "Finish scan". */
  | { kind: 'finish' };

export interface ScanView {
  step: 1 | 2 | 3;
  coach: CoachLines;
  button: ScanButton;
  /** Amber corner brackets in the middle of the view, as an aiming aid for the doorway. */
  brackets: boolean;
  /** Show the "walls found" counter. */
  showWalls: boolean;
  /** The area walked over is large enough. */
  areaEnough: boolean;
  /** The phone has been tilted down, held level and tilted up for long enough. */
  tilt: { down: boolean; level: boolean; up: boolean };
  /** The scan covers one spot only: ask before it is sent. */
  oneSpot: boolean;
  /** The time is up: finish the scan now. */
  finishNow: boolean;
}

const READY: CoachLines = { line1: 'ar.coach.ready.1', line2: 'ar.coach.ready.2' };

/** Step 1: the first thing still missing decides what the coach asks for. */
function walkCoach(input: ScanInput, areaEnough: boolean, tilt: ScanView['tilt']): CoachLines {
  if (!areaEnough) {
    return madeFromOneSpot(input.coverage) && input.seconds >= SCAN.spotSeconds
      ? { line1: 'scan.coach.spot.1', line2: 'scan.coach.spot.2' }
      : { line1: 'scan.coach.walls.1', line2: 'scan.coach.walls.2' };
  }
  if (!tilt.level) {
    return { line1: 'scan.coach.level.1', line2: 'scan.coach.level.2' };
  }
  if (!tilt.up) {
    return { line1: 'scan.coach.corners.1', line2: 'scan.coach.corners.2' };
  }
  if (!tilt.down) {
    return { line1: 'scan.coach.down.1', line2: 'scan.coach.down.2' };
  }
  if (!input.floorFound) {
    return { line1: 'scan.coach.floor.1', line2: 'scan.coach.floor.2' };
  }
  return { line1: 'scan.coach.keepWalking.1', line2: 'scan.coach.walls.2' };
}

export function scanView(input: ScanInput): ScanView {
  const { seconds, coverage } = input;
  const enoughTime = seconds >= SCAN.minSeconds;
  const areaEnough = coverage.long >= SCAN.minAreaLongM && coverage.short >= SCAN.minAreaShortM;
  const tilt = {
    down: coverage.downSeconds >= SCAN.minDownSeconds,
    level: coverage.levelSeconds >= SCAN.minLevelSeconds,
    up: coverage.upSeconds >= SCAN.minUpSeconds,
  };
  const enoughWalk = input.floorFound && areaEnough && tilt.down && tilt.level && tilt.up;
  let step: 1 | 2 | 3 = 1;
  if (input.recording && (input.doorwayShown || seconds >= SCAN.hintSeconds)) {
    step = 3;
  } else if (input.recording && enoughTime && enoughWalk) {
    step = 2;
  }

  let coach: CoachLines;
  let button: ScanButton;
  if (!input.recording) {
    coach = READY;
    button = { kind: 'wait', secondsLeft: SCAN.minSeconds };
  } else if (step === 1) {
    coach = walkCoach(input, areaEnough, tilt);
    button = { kind: 'wait', secondsLeft: Math.max(0, Math.ceil(SCAN.minSeconds - seconds)) };
  } else if (step === 2) {
    coach = { line1: 'scan.coach.doorway.1', line2: 'scan.coach.doorway.2' };
    button = { kind: 'showed' };
  } else {
    coach =
      seconds >= SCAN.hintSeconds
        ? { line1: 'scan.coach.finishNow.1', line2: 'scan.coach.enough.2' }
        : { line1: 'scan.coach.enough.1', line2: 'scan.coach.enough.2' };
    button = { kind: 'finish' };
  }
  // Standing in one place adds the same view again and again. Not said in step 3: the scan
  // is enough by then and the user is about to finish.
  const stillFor = coverage.still ? seconds - coverage.still.since : 0;
  const stillLimit = step === 1 ? SCAN.stillSeconds : step === 2 ? SCAN.stillSecondsDoorway : null;
  if (input.recording && stillLimit !== null && stillFor >= stillLimit) {
    coach = { line1: 'scan.coach.still.1', line2: 'scan.coach.still.2' };
  }
  // Warnings replace the step text while they apply.
  const warning = input.recording ? trackingWarning(input.tracking, input.trackingReason) : null;

  return {
    step,
    coach: warning ?? coach,
    button,
    brackets: step === 2,
    showWalls: input.walls > 0 || seconds < SCAN.wallsGraceSeconds,
    areaEnough,
    tilt,
    oneSpot: madeFromOneSpot(coverage),
    finishNow: input.recording && seconds >= SCAN.maxSeconds,
  };
}

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The label of the one button. */
export function buttonLabel(button: ScanButton): { key: TextKey; params: Record<string, number> } {
  switch (button.kind) {
    case 'wait':
      return button.secondsLeft > 0
        ? { key: 'scan.button.keepGoing', params: { s: button.secondsLeft } }
        : { key: 'scan.button.keepGoing.walk', params: {} };
    case 'showed':
      return { key: 'scan.button.showed', params: {} };
    case 'finish':
      return { key: 'scan.button.finish', params: {} };
  }
}
