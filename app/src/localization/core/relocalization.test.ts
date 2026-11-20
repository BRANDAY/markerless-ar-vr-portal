import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decide,
  type DoorCandidate,
  INTERRUPTION_GRACE_MS,
  type LocalizeAnswer,
  MAX_ATTEMPTS,
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
  assert.equal((turned as { angleDeg: number }).angleDeg, 20);

  const ignored = decide(SHOWN, true, answer({ at: [1.5, 0, -2], quality: 'weak' }));
  assert.equal(ignored.action, 'ignore');
  assert.ok(wantsAnotherAttempt(ignored));
});

test('decision: after tracking loss even a weak answer corrects the door', () => {
  const decision = decide(SHOWN, false, answer({ at: [1.5, 0, -2], quality: 'weak' }));
  assert.equal(decision.action, 'move');
  assert.ok(wantsAnotherAttempt(decision), 'the weak correction is checked once more');
});
