/**
 * Rules for keeping the doorway in the right place over a session: what counts as a loss
 * of tracking, when to ask the server again, and what to do with each answer. Pure
 * TypeScript without timers, so every rule is unit-tested; the provider supplies the
 * clock and the timers.
 *
 * Principles:
 *  - the doorway never moves or disappears without a line in the log and a status on
 *    the screen;
 *  - a pose that is already shown is replaced only by a better one that really differs -
 *    small disagreements between two answers are measurement noise, not a reason to move
 *    the door under the user's feet;
 *  - after tracking was lost the old pose is kept on screen but no longer trusted, and
 *    the room is looked for again.
 */

export type Tracking = 'unavailable' | 'limited' | 'normal';

/**
 * Tracking that is not NORMAL for less than this is a hiccup (switching the scan mode
 * restarts the AR engine's session configuration for about half a second, seen on a
 * Xiaomi 14 Ultra). Longer than this, the AR world frame can no longer be trusted.
 */
export const INTERRUPTION_GRACE_MS = 1500;

export type TrackingEvent =
  /** Tracking left NORMAL; nothing is concluded yet. */
  | { kind: 'left-normal' }
  /** NORMAL again after a short hiccup: carry on as if nothing happened. */
  | { kind: 'hiccup'; gapMs: number }
  /** NORMAL again after a real interruption: poses from before must be checked. */
  | { kind: 'recovered'; gapMs: number };

/** Follows the tracking state and tells hiccups from interruptions. */
export class TrackingWatch {
  private everNormal = false;
  private leftNormalAt: number | null = null;

  constructor(private readonly graceMs: number = INTERRUPTION_GRACE_MS) {}

  /** Call on every change of the tracking state. */
  onState(state: Tracking, nowMs: number): TrackingEvent | null {
    if (state === 'normal') {
      const leftAt = this.leftNormalAt;
      this.leftNormalAt = null;
      if (!this.everNormal) {
        this.everNormal = true;
        return null; // the first NORMAL of the session is a start, not a recovery
      }
      if (leftAt === null) {
        return null;
      }
      const gapMs = nowMs - leftAt;
      return gapMs >= this.graceMs ? { kind: 'recovered', gapMs } : { kind: 'hiccup', gapMs };
    }
    if (this.everNormal && this.leftNormalAt === null) {
      this.leftNormalAt = nowMs;
      return { kind: 'left-normal' };
    }
    return null;
  }

  /** True while tracking has been away for longer than the grace period. */
  isInterrupted(nowMs: number): boolean {
    return this.leftNormalAt !== null && nowMs - this.leftNormalAt >= this.graceMs;
  }

  /** True once tracking has been NORMAL at least once. */
  get hasTracked(): boolean {
    return this.everNormal;
  }
}

// ---- retries ------------------------------------------------------------------------------

/** Why the room is being looked for. */
export type EpisodeReason =
  /** First localisation of the session. */
  | 'start'
  /** Tracking came back after an interruption. */
  | 'recovery'
  /** The user pressed "Re-localize". */
  | 'manual'
  /** A weak answer was accepted and is being confirmed. */
  | 'confirm'
  /**
   * The user walked out of the space: the place of the door is checked once. While the
   * user was inside, ARCore may have corrected its map without announcing a loss of
   * tracking (second pass on a phone, 2026-11-22: the planes were dropped and found again,
   * the door - a point in ARCore's frame - stayed on the old numbers and stood off).
   */
  | 'exit';

/** Automatic attempts of one episode; after that the user is told what to do. */
export const MAX_ATTEMPTS: Record<EpisodeReason, number> = {
  start: 5,
  recovery: 5,
  manual: 3,
  confirm: 2,
  /** One look and one more: the door stays where it is when neither gives a good answer. */
  exit: 2,
};

/** Pause before attempt number `attempt` (1 = first). Later attempts wait longer. */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return 0;
  }
  return Math.min(1500 * 2 ** (attempt - 2), 10_000);
}

// ---- answers ------------------------------------------------------------------------------

/** A doorway pose with what is known about its reliability. */
export interface DoorCandidate {
  position: [number, number, number];
  /** Euler degrees [x, y, z]; a doorway only turns about Y. */
  rotation: [number, number, number];
  /** True for an answer the server itself calls reliable. */
  strong: boolean;
}

/** The part of a `/localize` answer the decision needs. */
export interface LocalizeAnswer {
  /** "good", "weak" or "failed". */
  quality: string;
  /** "ok" when the map could be placed in the current AR session. */
  alignmentStatus: string;
  /** Null when the map has no door opening (`source: "none"`). */
  door: { position: [number, number, number]; rotation: [number, number, number] } | null;
}

/** Two poses closer than this are the same doorway measured twice. */
export const SAME_POSE_DISTANCE_M = 0.15;
export const SAME_POSE_ANGLE_DEG = 6;

/**
 * Without an announced loss of tracking the door stands where it was believed; a strong
 * answer that would move it further than this is not taken. The room does not move: such
 * a jump comes from ARCore having rebuilt its map in the same session (fourth video of
 * the second pass, 2026-11-23: a good answer, 639 inliers, asked for 1.52 m and 53 deg,
 * the door had been right). The user is offered a new AR session instead ("Find again").
 */
export const MAX_JUMP_M = 0.5;
export const MAX_JUMP_DEG = 15;

export type Decision =
  /** No usable answer: try again (or give up when the attempts are used up). */
  | { action: 'retry'; why: string }
  /** The room was recognised, but its map has no door opening. Trying again cannot help. */
  | { action: 'no-doorway' }
  /** Nothing was shown yet: show this pose. */
  | { action: 'place'; door: DoorCandidate }
  /**
   * The answer agrees with what is shown: leave the door alone. A second look that lands
   * on the same spot confirms the pose, so it is trusted from now on even if both looks
   * were weak.
   */
  | { action: 'keep'; distanceM: number }
  /**
   * A strong answer far from a trusted door with no loss of tracking in between
   * (`MAX_JUMP_M`, `MAX_JUMP_DEG`): the door is not moved; the session is suspect.
   */
  | { action: 'suspect'; door: DoorCandidate; distanceM: number; angleDeg: number }
  /** The answer is better than what is shown and differs from it: move the door. */
  | { action: 'move'; door: DoorCandidate; distanceM: number; angleDeg: number }
  /** A weak answer contradicts a trusted pose: ignore the answer. */
  | { action: 'ignore'; distanceM: number };

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Where a doorway's +Z points on the floor plan, degrees. Not simply the middle Euler
 * angle: the server keeps that one within 90 degrees, so a heading of 110 arrives as
 * [180, 70, 180].
 */
export function headingDeg(rotation: readonly number[]): number {
  const rad = Math.PI / 180;
  const [x, y, z] = [rotation[0] * rad, rotation[1] * rad, rotation[2] * rad];
  const towardsX = Math.cos(x) * Math.sin(y) * Math.cos(z) + Math.sin(x) * Math.sin(z);
  const towardsZ = Math.cos(x) * Math.cos(y);
  return Math.atan2(towardsX, towardsZ) / rad;
}

/** Smallest angle between two headings, degrees. */
export function yawDifferenceDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * What to do with an answer of `/localize`.
 *
 * `shown` is the pose on screen, or null. `shownTrusted` is false for a pose that came
 * from a weak answer or that predates an interruption of tracking.
 */
export function decide(
  shown: DoorCandidate | null,
  shownTrusted: boolean,
  answer: LocalizeAnswer,
  /** `limitJump`: nobody asked for this look - a jump beyond `MAX_JUMP_*` is not taken. */
  options: { limitJump?: boolean } = {},
): Decision {
  if (answer.alignmentStatus !== 'ok' || answer.quality === 'failed') {
    const why =
      answer.quality === 'failed'
        ? 'the view was not recognised'
        : answer.alignmentStatus === 'scale_unknown'
          ? 'the scale of the map is not known yet - move the phone sideways'
          : `the room could not be placed (${answer.alignmentStatus})`;
    return { action: 'retry', why };
  }
  if (!answer.door) {
    return { action: 'no-doorway' };
  }
  const strong = answer.quality === 'good';
  const candidate: DoorCandidate = { ...answer.door, strong };
  if (!shown) {
    return { action: 'place', door: candidate };
  }
  const distanceM = distance(shown.position, candidate.position);
  const angleDeg = yawDifferenceDeg(headingDeg(shown.rotation), headingDeg(candidate.rotation));
  if (distanceM <= SAME_POSE_DISTANCE_M && angleDeg <= SAME_POSE_ANGLE_DEG) {
    return { action: 'keep', distanceM };
  }
  if (strong && shownTrusted && options.limitJump && (distanceM > MAX_JUMP_M || angleDeg > MAX_JUMP_DEG)) {
    return { action: 'suspect', door: candidate, distanceM, angleDeg };
  }
  if (strong || !shownTrusted) {
    // A strong answer always wins; so does any answer against a pose nobody trusts.
    return { action: 'move', door: candidate, distanceM, angleDeg };
  }
  return { action: 'ignore', distanceM };
}

/** Whether another attempt should follow this decision. */
export function wantsAnotherAttempt(decision: Decision): boolean {
  switch (decision.action) {
    case 'retry':
    case 'ignore':
      return true;
    case 'place':
    case 'move':
      return !decision.door.strong; // a weak pose is shown, and confirmed by another look
    case 'keep':
    case 'no-doorway':
    case 'suspect':
      return false;
  }
}

// ---- after the way out of the space -------------------------------------------------------

/**
 * What to check once the user is back in the room. After an announced loss of tracking the
 * door is no longer trusted and is looked for as after any loss (`recovery`); otherwise
 * its place is checked once (`exit`). Nothing without a door on screen.
 */
export function checkAfterExit(input: { doorShown: boolean; afterLoss: boolean }): 'recovery' | 'exit' | null {
  if (!input.doorShown) {
    return null;
  }
  return input.afterLoss ? 'recovery' : 'exit';
}

/**
 * A check after the way out moves the door only on a good answer: a weak one, or a
 * refusal, leaves the door where it is (no alarm, see `exitCheckGaveUp`). Null: the
 * answer may go on to the door layer.
 */
export function exitCheckGate(quality: string): Decision | null {
  return quality === 'good' ? null : { action: 'retry', why: `a ${quality || 'missing'} answer does not move the door after the way out` };
}

/** The log line of a check after the way out: how far the door was off and whether it was moved. */
export function describeExitCheck(decision: Decision): string {
  const cm = (metres: number) => `${Math.round(metres * 100)} cm`;
  switch (decision.action) {
    case 'keep':
      return `the doorway was in place (${cm(decision.distanceM)} off, within ${cm(SAME_POSE_DISTANCE_M)}) - not moved`;
    case 'move':
      return `the doorway was ${cm(decision.distanceM)} off (${decision.angleDeg.toFixed(1)} deg) - moved to the recognised place`;
    case 'ignore':
      return `a weak answer ${cm(decision.distanceM)} away - not moved`;
    case 'suspect':
      return (
        `a good answer asked for ${cm(decision.distanceM)} and ${decision.angleDeg.toFixed(1)} deg - ` +
        `NOT moved (more than ${cm(MAX_JUMP_M)} / ${MAX_JUMP_DEG} deg without a loss of tracking: the AR session is suspect)`
      );
    case 'place':
      return 'the doorway was placed';
    case 'no-doorway':
      return 'the room was recognised, but its map has no doorway - the doorway is kept';
    case 'retry':
      return `no good answer (${decision.why}) - not moved`;
  }
}

/** The checks after the way out are used up: the door stays, the screen says nothing alarming. */
export function exitCheckGaveUp(attempts: number): string {
  return `back in the room - no good answer in ${attempts} look(s), the doorway is kept where it was`;
}
