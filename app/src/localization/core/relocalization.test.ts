import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkAfterExit,
  decide,
  describeExitCheck,
  exitCheckGate,
  exitCheckGaveUp,
  type DoorCandidate,
  INTERRUPTION_GRACE_MS,
  type LocalizeAnswer,
  MAX_ATTEMPTS,
  MAX_JUMP_DEG,
  MAX_JUMP_M,
  retryDelayMs,
  TrackingWatch,
  wantsAnotherAttempt,
  yawDifferenceDeg,
} from './relocalization';

test('tracking: the first NORMAL of a session is not a recovery', () => {
  const watch = new TrackingWatch();
  assert.equal(watch.onState('unavailable', 0), null);
  assert.equal(watch.onState('limited', 500), null);
  assert.equal(watch.hasTracked, false);
  assert.equal(watch.onState('normal', 9000), null);
  assert.equal(watch.hasTracked, true);
  assert.equal(watch.isInterrupted(9000), false);
});

test('tracking: a short gap is a hiccup, a long one an interruption', () => {
  const watch = new TrackingWatch();
  watch.onState('normal', 0);
  assert.deepEqual(watch.onState('unavailable', 1000), { kind: 'left-normal' });
  assert.equal(watch.onState('limited', 1200), null, 'still away: nothing new');
  assert.equal(watch.isInterrupted(1000 + INTERRUPTION_GRACE_MS - 1), false);
  assert.deepEqual(watch.onState('normal', 1600), { kind: 'hiccup', gapMs: 600 });

  assert.deepEqual(watch.onState('limited', 5000), { kind: 'left-normal' });
  assert.equal(watch.isInterrupted(5000 + INTERRUPTION_GRACE_MS), true);
  assert.deepEqual(watch.onState('normal', 9000), { kind: 'recovered', gapMs: 4000 });
  assert.equal(watch.isInterrupted(9001), false);
  assert.equal(watch.onState('normal', 9500), null, 'NORMAL twice in a row');
});

test('retries: growing pauses, limited attempts', () => {
  assert.equal(retryDelayMs(1), 0);
  assert.equal(retryDelayMs(2), 1500);
  assert.equal(retryDelayMs(3), 3000);
  assert.equal(retryDelayMs(4), 6000);
  assert.equal(retryDelayMs(5), 10000);
  assert.equal(retryDelayMs(9), 10000);
  for (const count of Object.values(MAX_ATTEMPTS)) {
    assert.ok(count >= 2 && count <= 6);
  }
});

test('yaw difference wraps around', () => {
  assert.equal(yawDifferenceDeg(10, 350), 20);
  assert.equal(yawDifferenceDeg(-170, 170), 20);
  assert.equal(yawDifferenceDeg(90, 90), 0);
  assert.equal(yawDifferenceDeg(0, 540), 180);
});

const SHOWN: DoorCandidate = { position: [1, 0, -2], rotation: [0, 30, 0], strong: true };
const answer = (patch: Partial<LocalizeAnswer> & { at?: [number, number, number]; yaw?: number }): LocalizeAnswer => ({
  quality: 'good',
  alignmentStatus: 'ok',
  door: { position: patch.at ?? [1, 0, -2], rotation: [0, patch.yaw ?? 30, 0] },
  ...patch,
});

test('decision: no usable answer means another attempt', () => {
  const failed = decide(null, false, answer({ quality: 'failed' }));
  assert.equal(failed.action, 'retry');
  assert.ok(wantsAnotherAttempt(failed));
  const noScale = decide(SHOWN, true, answer({ alignmentStatus: 'scale_unknown' }));
  assert.equal(noScale.action, 'retry');
  assert.match((noScale as { why: string }).why, /sideways/);
  assert.equal(decide(null, false, answer({ alignmentStatus: 'none' })).action, 'retry');
});

test('decision: a recognised room without a door opening ends the search', () => {
  const decision = decide(null, false, answer({ door: null }));
  assert.equal(decision.action, 'no-doorway');
  assert.equal(wantsAnotherAttempt(decision), false);
});

test('decision: the first pose is placed; a weak one is confirmed by another look', () => {
  const good = decide(null, false, answer({}));
  assert.equal(good.action, 'place');
  assert.equal(wantsAnotherAttempt(good), false);
  const weak = decide(null, false, answer({ quality: 'weak' }));
  assert.equal(weak.action, 'place');
  assert.equal((weak as { door: DoorCandidate }).door.strong, false);
  assert.ok(wantsAnotherAttempt(weak));
});

test('decision: an answer that agrees with the door shown leaves it alone', () => {
  const near = decide(SHOWN, false, answer({ at: [1.1, 0, -2.05], yaw: 33, quality: 'weak' }));
  assert.equal(near.action, 'keep');
  assert.ok(Math.abs((near as { distanceM: number }).distanceM - 0.1118) < 1e-3);
  assert.equal(wantsAnotherAttempt(near), false, 'two looks on the same spot are a confirmation');
});

test('decision: a good answer elsewhere moves the door, a weak one does not move a trusted door', () => {
  const moved = decide(SHOWN, true, answer({ at: [1.5, 0, -2] }));
  assert.equal(moved.action, 'move');
  assert.ok(Math.abs((moved as { distanceM: number }).distanceM - 0.5) < 1e-9);
  assert.equal(wantsAnotherAttempt(moved), false);

  const turned = decide(SHOWN, true, answer({ yaw: 50 }));
  assert.equal(turned.action, 'move', 'same place, other heading');
  assert.ok(Math.abs((turned as { angleDeg: number }).angleDeg - 20) < 1e-9);
  // the server keeps the middle Euler angle within 90 degrees: headings of 100 and 80
  // arrive as [180, 80, 180] and [0, 80, 0] - 20 degrees apart, not the same door
  const flipped = decide({ position: [0, 0, 0], rotation: [0, 80, 0], strong: true }, true, {
    quality: 'good',
    alignmentStatus: 'ok',
    door: { position: [0, 0, 0], rotation: [180, 80, 180] },
  });
  assert.equal(flipped.action, 'move');
  assert.ok(Math.abs((flipped as { angleDeg: number }).angleDeg - 20) < 1e-9);

  const ignored = decide(SHOWN, true, answer({ at: [1.5, 0, -2], quality: 'weak' }));
  assert.equal(ignored.action, 'ignore');
  assert.ok(wantsAnotherAttempt(ignored));
});

test('decision: after tracking loss even a weak answer corrects the door', () => {
  const decision = decide(SHOWN, false, answer({ at: [1.5, 0, -2], quality: 'weak' }));
  assert.equal(decision.action, 'move');
  assert.ok(wantsAnotherAttempt(decision), 'the weak correction is checked once more');
});

test('after the way out: the door is checked every time, after a loss as before', () => {
  assert.equal(checkAfterExit({ doorShown: true, afterLoss: false }), 'exit');
  assert.equal(checkAfterExit({ doorShown: true, afterLoss: true }), 'recovery');
  assert.equal(checkAfterExit({ doorShown: false, afterLoss: false }), null);
  assert.equal(checkAfterExit({ doorShown: false, afterLoss: true }), null);
  // one look and one more, no loop
  assert.equal(MAX_ATTEMPTS.exit, 2);
});

test('after the way out: only a good answer may move the door', () => {
  assert.equal(exitCheckGate('good'), null);
  for (const quality of ['weak', 'failed', '']) {
    const gate = exitCheckGate(quality);
    assert.equal(gate?.action, 'retry', quality);
    assert.ok(gate && wantsAnotherAttempt(gate));
  }
  // a good answer: the door shown 40 cm off is moved, 8 cm off is kept
  const moved = decide(SHOWN, true, answer({ at: [1.4, 0, -2] }));
  assert.equal(moved.action, 'move');
  assert.match(describeExitCheck(moved), /^the doorway was 40 cm off \(0\.0 deg\) - moved/);
  const kept = decide(SHOWN, true, answer({ at: [1.08, 0, -2] }));
  assert.equal(kept.action, 'keep');
  assert.match(describeExitCheck(kept), /^the doorway was in place \(8 cm off, within 15 cm\) - not moved/);
  assert.match(describeExitCheck({ action: 'retry', why: 'the view was not recognised' }), /not moved/);
  assert.match(exitCheckGaveUp(2), /no good answer in 2 look\(s\), the doorway is kept/);
});

test('a jump without a loss of tracking: 1.52 m / 53 deg is not taken, 0.3 m / 5 deg is', () => {
  // the fourth video: the door shown was right, a good answer asked for 1.52 m and 53 deg
  const far = answer({ at: [1 + 1.52 * Math.cos(0.3), 0, -2 + 1.52 * Math.sin(0.3)], yaw: 30 + 53 });
  const suspect = decide(SHOWN, true, far, { limitJump: true });
  assert.equal(suspect.action, 'suspect');
  assert.ok(!wantsAnotherAttempt(suspect), 'no loop: the user is offered a new session');
  assert.match(describeExitCheck(suspect), /NOT moved/);
  // a correction within the limit is still made
  const near = decide(SHOWN, true, answer({ at: [1.3, 0, -2], yaw: 35 }), { limitJump: true });
  assert.equal(near.action, 'move');
  // the limit is on distance or turn alone
  assert.equal(decide(SHOWN, true, answer({ at: [1.6, 0, -2] }), { limitJump: true }).action, 'suspect');
  assert.equal(decide(SHOWN, true, answer({ yaw: 30 + 20 }), { limitJump: true }).action, 'suspect');
  // after an announced loss (the door is not trusted) and on request the old rule stands
  assert.equal(decide(SHOWN, false, far, { limitJump: true }).action, 'move');
  assert.equal(decide(SHOWN, true, far).action, 'move');
  assert.equal(MAX_JUMP_M, 0.5);
  assert.equal(MAX_JUMP_DEG, 15);
});
