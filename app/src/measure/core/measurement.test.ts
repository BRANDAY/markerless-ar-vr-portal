import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aimPointOnFloor,
  compactLine,
  compareDoor,
  describeRecord,
  doorCorners,
  formatSummary,
  type MeasurementRecord,
  nextCondition,
  parseTrials,
  phonePointOnFloor,
  referenceFrame,
  signedYawDifferenceDeg,
  summarize,
  type V3,
} from './measurement';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not ${expected}`);

test('aim: the viewing ray is cut with the floor plane', () => {
  // 1.5 m above the floor, looking 45 degrees down along -Z: the point is 1.5 m ahead.
  const s = Math.SQRT1_2;
  const hit = aimPointOnFloor([1, 0.5, 2], [0, -s, -s], -1);
  assert.ok(hit.ok);
  if (hit.ok) {
    near(hit.point[0], 1);
    near(hit.point[1], -1);
    near(hit.point[2], 0.5);
    near(hit.pitchDeg, 45);
    near(hit.distanceM, 1.5 / s);
  }
});

test('aim: a flat look, a look up and a phone below the floor are refused with a reason', () => {
  const flat = aimPointOnFloor([0, 1.4, 0], [0, -0.2, -0.98], 0);
  assert.ok(!flat.ok && flat.reason.includes('steeply'));
  assert.ok(!aimPointOnFloor([0, 1.4, 0], [0, 0.5, -0.87], 0).ok);
  assert.ok(!aimPointOnFloor([0, 0, 0], [0, -1, 0], 0.5).ok);
  assert.ok(!aimPointOnFloor([0, 1, 0], [0, 0, 0], 0).ok);
});

test('aim: an unnormalised direction gives the same point', () => {
  const a = aimPointOnFloor([0, 1, 0], [0, -1, -1], 0);
  const b = aimPointOnFloor([0, 1, 0], [0, -5, -5], 0);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    near(a.point[2], b.point[2]);
    near(a.point[2], -1);
  }
});

test('phone mark: straight below the phone', () => {
  assert.deepEqual(phonePointOnFloor([1, 1.2, -3], -0.1), [1, -0.1, -3]);
});

test('heading difference is signed and wraps', () => {
  near(signedYawDifferenceDeg(10, 350), 20);
  near(signedYawDifferenceDeg(350, 10), -20);
  near(signedYawDifferenceDeg(180, 0), 180);
  near(signedYawDifferenceDeg(-180, 0), 180);
});

test('door corners: left and right as seen from the AR side', () => {
  // Yaw 0: the AR side is +Z, so the right hand of somebody looking at the door is +X.
  const c = doorCorners({ position: [0, 0, 0], yawDeg: 0, widthM: 1 });
  assert.deepEqual(c.left, [-0.5, 0, 0]);
  assert.deepEqual(c.right, [0.5, 0, 0]);
  // Yaw 90: the AR side is +X, right is -Z.
  const d = doorCorners({ position: [2, 0, 2], yawDeg: 90, widthM: 1 });
  near(d.right[0], 2);
  near(d.right[2], 1.5);
  near(d.left[2], 2.5);
});

test('reference frame: the marks of a door give back its pose', () => {
  for (const yawDeg of [0, 37, 90, 135, -120, 179]) {
    const door = { position: [1, -1.2, -3] as V3, yawDeg, widthM: 0.86 };
    const frame = referenceFrame(doorCorners(door));
    assert.ok(frame);
    if (frame) {
      near(signedYawDifferenceDeg(frame.yawDeg, yawDeg), 0, 1e-6);
      near(frame.widthM, 0.86);
      near(frame.middle[0], 1);
      near(frame.middle[2], -3);
    }
  }
  assert.equal(referenceFrame({ left: [0, 0, 0], right: null }), null);
  assert.equal(referenceFrame({ left: [0, 0, 0], right: [0.1, 0, 0] }), null);
});

test('compare: a door exactly on the marks has no error', () => {
  const door = { position: [1, 0, -2] as V3, yawDeg: 30, widthM: 0.9 };
  const c = compareDoor(door, doorCorners(door));
  assert.ok(c);
  if (c) {
    assert.equal(c.basis, 'both-corners');
    near(c.positionCm, 0, 0.05);
    near(c.headingDeg ?? 99, 0, 0.05);
    near(c.widthCm ?? 99, 0, 0.05);
    assert.equal(c.pass, true);
  }
});

test('compare: offsets are given along and across the real wall', () => {
  // Real opening: yaw 0 at the origin, 1 m wide. Door: 6 cm to the right, 8 cm towards the
  // AR side, 2 cm up, turned by 3 degrees, 0.9 m wide.
  const real = doorCorners({ position: [0, 0, 0], yawDeg: 0, widthM: 1 });
  const c = compareDoor({ position: [0.06, 0.02, 0.08], yawDeg: 3, widthM: 0.9 }, real);
  assert.ok(c);
  if (c) {
    near(c.alongCm, 6, 0.05);
    near(c.acrossCm, 8, 0.05);
    near(c.heightCm, 2, 0.05);
    near(c.positionCm, 10, 0.05);
    near(c.headingDeg ?? 0, 3, 0.05);
    near(c.widthCm ?? 0, -10, 0.05);
    assert.equal(c.pass, true);
  }
  // The same in a session whose frame is turned: the numbers do not depend on the frame.
  const turned = doorCorners({ position: [5, 1, 5], yawDeg: 90, widthM: 1 });
  // Along the wall is now -Z, towards the AR side is +X.
  const d = compareDoor({ position: [5.08, 1.02, 4.94], yawDeg: 93, widthM: 0.9 }, turned);
  assert.ok(d);
  if (d) {
    near(d.alongCm, 6, 0.05);
    near(d.acrossCm, 8, 0.05);
    near(d.headingDeg ?? 0, 3, 0.05);
  }
});

test('compare: outside the tolerance by position or by heading', () => {
  const real = doorCorners({ position: [0, 0, 0], yawDeg: 0, widthM: 0.9 });
  assert.equal(compareDoor({ position: [0.11, 0, 0], yawDeg: 0, widthM: 0.9 }, real)?.pass, false);
  assert.equal(compareDoor({ position: [0, 0, 0], yawDeg: 6, widthM: 0.9 }, real)?.pass, false);
  assert.equal(compareDoor({ position: [0.05, 0, 0], yawDeg: -4, widthM: 0.9 }, real)?.pass, true);
  // A door turned round is 180 degrees off, and the text says what that usually means.
  const flipped = compareDoor({ position: [0, 0, 0], yawDeg: 180, widthM: 0.9 }, real);
  near(Math.abs(flipped?.headingDeg ?? 0), 180, 0.05);
});

test('compare: with one mark the corner is compared, without heading', () => {
  const door = { position: [0, 0, 0] as V3, yawDeg: 0, widthM: 1 };
  const c = compareDoor(door, { left: [-0.53, 0, 0.04], right: null });
  assert.ok(c);
  if (c) {
    assert.equal(c.basis, 'left-corner');
    near(c.positionCm, 5, 0.05);
    near(c.alongCm, 3, 0.05);
    near(c.acrossCm, -4, 0.05);
    assert.equal(c.headingDeg, null);
    assert.equal(c.widthCm, null);
    assert.equal(c.rightCm, null);
  }
  assert.equal(compareDoor(door, { left: null, right: null }), null);
});

test('conditions cycle', () => {
  assert.equal(nextCondition('baseline'), 'restart');
  assert.equal(nextCondition('walk-through'), 'baseline');
});

function record(over: Partial<MeasurementRecord>): MeasurementRecord {
  const door = { position: [0.03, 0, 0.04] as V3, yawDeg: 2, widthM: 0.9 };
  const reference = doorCorners({ position: [0, 0, 0], yawDeg: 0, widthM: 0.9 });
  return {
    v: 1,
    kind: 'door-measurement',
    run: 'run-a',
    device: 'dev-1',
    seq: 1,
    time: '2026-11-21T10:00:00.000Z',
    condition: 'restart',
    event: 'check',
    provider: 'self-hosted',
    tracking: 'normal',
    placement: {
      event: 'placed',
      reason: 'start',
      attempts: 2,
      elapsedMs: 7300,
      sinceStartMs: 15300,
      trusted: true,
      quality: 'good',
      inliers: 743,
      source: 'auto',
      confidence: 0.8,
    },
    door: { ...door, heightM: 2, sizeFromServer: true },
    reference: { ...reference, method: 'aim', beforeInterruption: false },
    comparison: compareDoor(door, reference),
    held: false,
    ...over,
  };
}

test('record: the line for the device log fits and reads back to the same trial', () => {
  const r = record({});
  const line = compactLine(r);
  assert.ok(line.startsWith('measure-data {'));
  assert.ok(line.length <= 500, `line is ${line.length} characters`);
  // As the phone file, as a device-log event of the server, and as bare text.
  const fromFile = parseTrials(JSON.stringify(r));
  const fromLog = parseTrials(JSON.stringify({ id: 7, device_id: 'dev-1', type: 'app', message: line }));
  const fromText = parseTrials(`11-21 10:00:00 I ReactNativeJS: [portal] 12.3s ${line}`);
  assert.equal(fromFile.length, 1);
  assert.deepEqual(fromLog, fromFile);
  assert.deepEqual(fromText, fromFile);
  near(fromFile[0].positionCm ?? 0, 5, 0.05);
  assert.equal(fromFile[0].attempts, 2);
  assert.equal(fromFile[0].pass, true);
});

test('record: the longest realistic line still fits the device log', () => {
  const far: V3 = [-123.456, -12.345, -234.567];
  const r = record({
    condition: 'tracking-loss',
    seq: 9999,
    run: 'run-zzzzzzzzzz',
    door: { position: far, yawDeg: -179.999, widthM: 1.234, heightM: 2.345, sizeFromServer: true },
    reference: { left: far, right: [-124.456, -12.345, -234.567], method: 'phone', beforeInterruption: true },
    comparison: {
      basis: 'both-corners',
      positionCm: 1234.5,
      alongCm: -1234.5,
      acrossCm: -1234.5,
      heightCm: -123.4,
      headingDeg: -179.9,
      widthCm: -123.4,
      leftCm: 1234.5,
      rightCm: 1234.5,
      pass: false,
    },
    placement: {
      event: 'confirmed',
      reason: 'recovery',
      attempts: 7,
      elapsedMs: 123456,
      sinceStartMs: 12345678,
      trusted: true,
      quality: 'weak',
      inliers: 12345,
      source: 'manual',
      confidence: 0.123,
    },
  });
  assert.ok(compactLine(r).length <= 500, `line is ${compactLine(r).length} characters`);
});

test('record: readable line', () => {
  const text = describeRecord(record({}));
  assert.ok(text.startsWith('measure restart #1 check: door 5.0 cm from the real opening'), text);
  assert.ok(text.includes('inside the tolerance'), text);
  assert.ok(text.includes('2 attempts'), text);
  const none = describeRecord(record({ event: 'not-found', door: null, comparison: null, reference: null }));
  assert.ok(none.includes('no door on screen'), none);
  const unmarked = describeRecord(record({ comparison: null, reference: null }));
  assert.ok(unmarked.includes('no marks'), unmarked);
});

test('summary: trials are checks and searches without a door; duplicates count once', () => {
  const lines = [
    // restart: three measured checks (one outside), one search that found nothing
    record({ seq: 1, event: 'placed' }),
    record({ seq: 2 }),
    record({ run: 'run-b', seq: 2, comparison: { ...(record({}).comparison as NonNullable<MeasurementRecord['comparison']>), positionCm: 14, pass: false } }),
    record({ run: 'run-c', seq: 2, comparison: { ...(record({}).comparison as NonNullable<MeasurementRecord['comparison']>), positionCm: 8, headingDeg: -3 } }),
    record({ run: 'run-d', seq: 1, event: 'not-found', door: null, comparison: null }),
    // lighting: a check without marks
    record({ run: 'run-e', seq: 3, condition: 'lighting', comparison: null, reference: null }),
  ];
  const text = [
    ...lines.map((r) => JSON.stringify(r)),
    // the same record again, as it arrives through the server's device log
    JSON.stringify({ message: compactLine(lines[1]) }),
    'not json at all',
    '{"broken": ',
  ].join('\n');
  const trials = parseTrials(text);
  assert.equal(trials.length, 6);
  const summary = summarize(trials);
  assert.deepEqual(
    summary.map((s) => s.condition),
    ['restart', 'lighting'],
  );
  const restart = summary[0];
  assert.equal(restart.trials, 4);
  assert.equal(restart.measured, 3);
  assert.equal(restart.notFound, 1);
  assert.equal(restart.passed, 2);
  near(restart.positionCm?.median ?? 0, 8);
  near(restart.positionCm?.max ?? 0, 14);
  near(restart.headingDeg?.max ?? 0, 3);
  near(restart.sinceStartS?.median ?? 0, 15.3);
  near(restart.searchS?.median ?? 0, 7.3);
  const lighting = summary[1];
  assert.equal(lighting.trials, 1);
  assert.equal(lighting.measured, 0);
  assert.equal(lighting.unmeasured, 1);
  const table = formatSummary(summary);
  assert.ok(table.includes('| restart | 4 | 3 of 4 | 3 | 2 of 3 |'), table);
  assert.ok(table.includes('| lighting | 1 | 1 of 1 | 0 | - |'), table);
  assert.ok(formatSummary([]).includes('no trials found'));
});
