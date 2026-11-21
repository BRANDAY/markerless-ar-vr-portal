/**
 * The guided scan (`docs/product/ui-spec.md`, 5.6): which step it is in, what the coach
 * says, what the one button does. Pure; the screen supplies the clock and the facts.
 *
 * The thresholds are starting points taken from the server's advice for a recording
 * (60-120 s of walking); they are to be adjusted after real scans.
 */
import type { TextKey } from '../../i18n';
import { type CoachLines, trackingWarning } from './arView';

export const SCAN = {
  /** Step 1 lasts at least this long. */
  minSeconds: 60,
  /** ...and until this much has been walked. */
  minMetres: 6,
  /** From here on the scan may be finished whatever the user has confirmed. */
  hintSeconds: 150,
  /** The scan finishes by itself. */
  maxSeconds: 180,
  /** The "walls found" counter is hidden if no wall has appeared by then. */
  wallsGraceSeconds: 20,
} as const;

export interface ScanInput {
  /** The recording is running. */
  recording: boolean;
  /** Seconds since the recording started. */
  seconds: number;
  /** A horizontal plane exists. */
  floorFound: boolean;
  /** Vertical planes found. */
  walls: number;
  /** Path length walked since the recording started. */
  metres: number;
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
  /** The time is up: finish the scan now. */
  finishNow: boolean;
}

const READY: CoachLines = { line1: 'ar.coach.ready.1', line2: 'ar.coach.ready.2' };

export function scanView(input: ScanInput): ScanView {
  const { seconds } = input;
  const enoughTime = seconds >= SCAN.minSeconds;
  const enoughWalk = input.floorFound && input.metres >= SCAN.minMetres;
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
    coach = enoughTime
      ? { line1: 'scan.coach.keepWalking.1', line2: 'scan.coach.walls.2' }
      : { line1: 'scan.coach.walls.1', line2: 'scan.coach.walls.2' };
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
  // Warnings replace the step text while they apply.
  const warning = input.recording ? trackingWarning(input.tracking, input.trackingReason) : null;

  return {
    step,
    coach: warning ?? coach,
    button,
    brackets: step === 2,
    showWalls: input.walls > 0 || seconds < SCAN.wallsGraceSeconds,
    finishNow: input.recording && seconds >= SCAN.maxSeconds,
  };
}

type P3 = readonly [number, number, number] | readonly number[];

/** A step longer than this between two camera positions is a jump of tracking, not walking. */
const MAX_STEP_M = 1;
/** Shorter than this is the hand shaking. */
const MIN_STEP_M = 0.03;

/**
 * Adds the way from the last counted position to `next` to the path walked (horizontal
 * distance only). Returns the new total and the position to measure from next time.
 */
export function addToPath(total: number, from: P3 | null, next: P3): { total: number; from: P3 } {
  if (!from) {
    return { total, from: next };
  }
  const step = Math.hypot(next[0] - from[0], next[2] - from[2]);
  if (step < MIN_STEP_M) {
    return { total, from };
  }
  if (step > MAX_STEP_M) {
    return { total, from: next };
  }
  return { total: total + step, from: next };
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
