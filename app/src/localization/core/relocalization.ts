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
  | 'confirm';

/** Automatic attempts of one episode; after that the user is told what to do. */
export const MAX_ATTEMPTS: Record<EpisodeReason, number> = {
  start: 5,
  recovery: 5,
  manual: 3,
  confirm: 2,
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
  /** The answer is better than what is shown and differs from it: move the door. */
  | { action: 'move'; door: DoorCandidate; distanceM: number; angleDeg: number }
  /** A weak answer contradicts a trusted pose: ignore the answer. */
  | { action: 'ignore'; distanceM: number };

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
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
  const angleDeg = yawDifferenceDeg(shown.rotation[1], candidate.rotation[1]);
  if (distanceM <= SAME_POSE_DISTANCE_M && angleDeg <= SAME_POSE_ANGLE_DEG) {
    return { action: 'keep', distanceM };
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
      return false;
  }
}
