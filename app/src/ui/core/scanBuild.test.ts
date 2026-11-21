import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en } from '../../i18n/en';
import { newRoomId, nextRoomNumber } from '../../room/roomNames';
import {
  BUILD_STEPS,
  buildPercent,
  buildProblem,
  type BuildFailure,
  currentStep,
  duration,
  failureFromJobError,
  failureFromUpload,
  percentOf,
  qualityLines,
  timeLine,
  uploadPercent,
} from './buildView';
import {
  addToCoverage,
  buttonLabel,
  clock,
  describeCoverage,
  madeFromOneSpot,
  NO_COVERAGE,
  SCAN,
  type ScanCoverage,
  type ScanInput,
  scanView,
  tiltDegrees,
} from './scanFlow';

/** A walk round the room with every tilt: what step 2 asks for. */
const ROUND: ScanCoverage = { ...NO_COVERAGE, long: 2.1, short: 1.0, downSeconds: 12, levelSeconds: 40, upSeconds: 4 };
/** The scan of 2026-11-21: 100 s on a patch of 1.0 x 1.0 m, the phone at -15 degrees. */
const ONE_SPOT: ScanCoverage = { ...NO_COVERAGE, long: 1.0, short: 1.0, levelSeconds: 80 };

function scan(over: Partial<ScanInput>): ScanInput {
  return {
    recording: true,
    seconds: 0,
    floorFound: true,
    walls: 2,
    coverage: NO_COVERAGE,
    doorwayShown: false,
    tracking: 'normal',
    trackingReason: '',
    ...over,
  };
}

/** The camera's forward vector at a tilt, looking along -Z. */
function forwardAt(degrees: number): [number, number, number] {
  const r = (degrees * Math.PI) / 180;
  return [0, Math.sin(r), -Math.cos(r)];
}

/** Feeds positions at four samples a second, as the AR scene publishes them. */
function walk(points: [number, number][], tilt = 0, from: ScanCoverage = NO_COVERAGE, t0 = 0): ScanCoverage {
  return points.reduce((coverage, [x, z], i) => addToCoverage(coverage, [x, 1.4, z], forwardAt(tilt), t0 + i * 0.25), from);
}

/** Points along a straight line, 10 cm apart. */
function line(from: [number, number], to: [number, number]): [number, number][] {
  const steps = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.1));
  return Array.from({ length: steps + 1 }, (_, i): [number, number] => [
    from[0] + ((to[0] - from[0]) * i) / steps,
    from[1] + ((to[1] - from[1]) * i) / steps,
  ]);
}

test('scan: step 1 counts down to a minute with a disabled button (5.6)', () => {
  const start = scanView(scan({ seconds: 0 }));
  assert.equal(start.step, 1);
  assert.equal(start.coach.line1, 'scan.coach.walls.1');
  assert.deepEqual(start.button, { kind: 'wait', secondsLeft: 60 });
  assert.deepEqual(scanView(scan({ seconds: 12.3, coverage: ROUND })).button, { kind: 'wait', secondsLeft: 48 });
  assert.deepEqual(buttonLabel({ kind: 'wait', secondsLeft: 48 }), { key: 'scan.button.keepGoing', params: { s: 48 } });
  assert.equal(start.brackets, false);
});

test('scan: before the recording runs the coach asks to move the phone', () => {
  const view = scanView(scan({ recording: false, tracking: 'unavailable' }));
  assert.equal(view.coach.line1, 'ar.coach.ready.1');
  assert.equal(view.button.kind, 'wait');
  assert.equal(view.finishNow, false);
});

test('scan: step 2 needs a minute, a floor, a round of the room and every tilt', () => {
  const ready = scanView(scan({ seconds: 61, coverage: ROUND }));
  assert.equal(ready.step, 2);
  assert.equal(ready.coach.line1, 'scan.coach.doorway.1');
  assert.deepEqual(ready.button, { kind: 'showed' });
  assert.equal(ready.brackets, true);
  assert.equal(ready.areaEnough, true);
  assert.deepEqual(ready.tilt, { down: true, level: true, up: true });
  assert.equal(ready.oneSpot, false);

  // What is missing decides what the coach asks for, in this order.
  const missing: [Partial<ScanInput>, string][] = [
    [{ coverage: ONE_SPOT }, 'scan.coach.spot.1'],
    [{ coverage: { ...ROUND, short: 0.2 } }, 'scan.coach.walls.1'], // to and fro along one line
    [{ coverage: { ...ROUND, levelSeconds: 3 } }, 'scan.coach.level.1'],
    [{ coverage: { ...ROUND, upSeconds: 0 } }, 'scan.coach.corners.1'],
    [{ coverage: { ...ROUND, downSeconds: 2 } }, 'scan.coach.down.1'],
    [{ coverage: ROUND, floorFound: false }, 'scan.coach.floor.1'],
  ];
  for (const [over, line1] of missing) {
    const view = scanView(scan({ seconds: 61, ...over }));
    assert.equal(view.step, 1, line1);
    assert.equal(view.coach.line1, line1);
    assert.deepEqual(view.button, { kind: 'wait', secondsLeft: 0 });
    assert.equal(buttonLabel(view.button).key, 'scan.button.keepGoing.walk');
  }
  // everything is there but the minute
  assert.equal(scanView(scan({ seconds: 40, coverage: ROUND })).coach.line1, 'scan.coach.keepWalking.1');
});

test('scan: the scan of 2026-11-21 (one spot, 7.9 m of shuffling) does not get past step 1', () => {
  // In the first seconds nobody has walked yet: the plain instruction.
  assert.equal(scanView(scan({ seconds: 10, coverage: { ...ONE_SPOT, long: 0.3, short: 0.2 } })).coach.line1, 'scan.coach.walls.1');
  const view = scanView(scan({ seconds: 100, coverage: ONE_SPOT }));
  assert.equal(view.step, 1);
  assert.equal(view.coach.line1, 'scan.coach.spot.1');
  assert.equal(view.areaEnough, false);
  assert.deepEqual(view.tilt, { down: false, level: true, up: false });
  assert.equal(view.oneSpot, true);
  // After 150 s it may be finished all the same - and is asked about before it is sent.
  const late = scanView(scan({ seconds: SCAN.hintSeconds, coverage: ONE_SPOT }));
  assert.equal(late.button.kind, 'finish');
  assert.equal(late.oneSpot, true);
  assert.equal(madeFromOneSpot(ONE_SPOT), true);
  assert.equal(madeFromOneSpot(ROUND), false);
  // a walk along one line is not a round, but it is not one spot either
  assert.equal(madeFromOneSpot({ ...ROUND, short: 0.2 }), false);
});

test('scan: step 3 after the user showed the doorway, or at 150 s whatever happened', () => {
  const confirmed = scanView(scan({ seconds: 70, coverage: ROUND, doorwayShown: true }));
  assert.equal(confirmed.step, 3);
  assert.equal(confirmed.coach.line1, 'scan.coach.enough.1');
  assert.deepEqual(confirmed.button, { kind: 'finish' });
  assert.equal(confirmed.finishNow, false);

  const late = scanView(scan({ seconds: SCAN.hintSeconds, floorFound: false }));
  assert.equal(late.step, 3);
  assert.equal(late.coach.line1, 'scan.coach.finishNow.1');
  assert.equal(late.button.kind, 'finish');
  assert.equal(scanView(scan({ seconds: 179 })).finishNow, false);
  assert.equal(scanView(scan({ seconds: SCAN.maxSeconds })).finishNow, true);
});

test('scan: a tracking warning replaces the step text but not the button', () => {
  const view = scanView(scan({ seconds: 70, coverage: ROUND, tracking: 'limited', trackingReason: 'excessive motion' }));
  assert.equal(view.coach.line1, 'ar.coach.motion.1');
  assert.deepEqual(view.button, { kind: 'showed' });
  assert.equal(scanView(scan({ tracking: 'limited', trackingReason: 'insufficient light' })).coach.line1, 'ar.coach.dark.1');
  assert.equal(scanView(scan({ tracking: 'limited', trackingReason: 'insufficient features' })).coach.line1, 'ar.coach.plain.1');
});

test('scan: standing in one place is said after a few seconds', () => {
  const standing = (since: number): ScanCoverage => ({ ...ROUND, still: { x: 0, z: 0, since } });
  // step 1: a sweep in a corner takes about five seconds and is left alone
  assert.equal(scanView(scan({ seconds: 30, coverage: standing(25) })).coach.line1, 'scan.coach.keepWalking.1');
  assert.equal(scanView(scan({ seconds: 30, coverage: standing(30 - SCAN.stillSeconds) })).coach.line1, 'scan.coach.still.1');
  // step 2: the place of the door is shown standing, so the patience is longer
  assert.equal(scanView(scan({ seconds: 80, coverage: standing(70) })).coach.line1, 'scan.coach.doorway.1');
  const long = scanView(scan({ seconds: 80, coverage: standing(80 - SCAN.stillSecondsDoorway) }));
  assert.equal(long.coach.line1, 'scan.coach.still.1');
  assert.deepEqual(long.button, { kind: 'showed' });
  // step 3: the scan is enough, nothing is said
  assert.equal(scanView(scan({ seconds: 120, coverage: standing(60), doorwayShown: true })).coach.line1, 'scan.coach.enough.1');
  // a camera that lost the room has its own warning
  const lost = scanView(scan({ seconds: 30, coverage: standing(0), tracking: 'limited', trackingReason: 'insufficient light' }));
  assert.equal(lost.coach.line1, 'ar.coach.dark.1');
  // not while nothing is recorded
  assert.equal(scanView(scan({ recording: false, seconds: 30, coverage: standing(0) })).coach.line1, 'ar.coach.ready.1');
});

test('scan: the walls counter is hidden when no wall shows up within 20 s', () => {
  assert.equal(scanView(scan({ walls: 0, seconds: 5 })).showWalls, true);
  assert.equal(scanView(scan({ walls: 0, seconds: 25 })).showWalls, false);
  assert.equal(scanView(scan({ walls: 1, seconds: 25 })).showWalls, true);
});

test('coverage: the area is where the phone has been, not how far it was carried', () => {
  // Shuffling round a patch of 1 x 1 m, six times over (24 m of path), is still 1 x 1 m.
  let spot = NO_COVERAGE;
  let t = 0;
  for (let lap = 0; lap < 6; lap++) {
    for (const leg of [line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 1]), line([0, 1], [0, 0])]) {
      spot = walk(leg, -15, spot, t);
      t += leg.length * 0.25;
    }
  }
  assert.ok(Math.abs(spot.long - 1) < 0.11 && Math.abs(spot.short - 1) < 0.11, `${spot.long} x ${spot.short}`);
  assert.equal(madeFromOneSpot(spot), true);
  assert.equal(scanView(scan({ seconds: 100, coverage: spot })).step, 1);

  // A round of a small room, a metre from its walls: 2 x 1 m.
  const round = walk([...line([0, 0], [2, 0]), ...line([2, 0], [2, 1]), ...line([2, 1], [0, 1]), ...line([0, 1], [0, 0])]);
  assert.ok(Math.abs(round.long - 2) < 0.11 && Math.abs(round.short - 1) < 0.11, `${round.long} x ${round.short}`);
  assert.equal(madeFromOneSpot(round), false);
  assert.equal(scanView(scan({ coverage: round })).areaEnough, true);
});

test('coverage: the area does not depend on how the room lies in the AR frame', () => {
  // The same 2 x 1 m round, turned by 30 degrees.
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const turn = ([x, z]: [number, number]): [number, number] => [x * cos - z * sin, x * sin + z * cos];
  const corners: [number, number][] = [[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]];
  const points = corners.slice(1).flatMap((corner, i) => line(turn(corners[i]), turn(corner)));
  const round = walk(points);
  assert.ok(Math.abs(round.long - 2) < 0.2 && Math.abs(round.short - 1) < 0.2, `${round.long} x ${round.short}`);
  // A walk along one line, diagonal in the AR frame, is long but not wide.
  const diagonal = walk(line([0, 0], [2, 2]));
  assert.ok(diagonal.long > 2.7 && diagonal.short < 0.2, `${diagonal.long} x ${diagonal.short}`);
  assert.equal(scanView(scan({ coverage: diagonal })).areaEnough, false);
});

test('coverage: shaking, jumps of tracking and height do not count', () => {
  let coverage = addToCoverage(NO_COVERAGE, [0, 1.4, 0], forwardAt(0), 0);
  coverage = addToCoverage(coverage, [0.01, 1.4, 0.01], forwardAt(0), 0.25); // the hand shaking
  coverage = addToCoverage(coverage, [0.02, 0.4, 0], forwardAt(0), 0.5); // the phone lowered
  assert.equal(coverage.places.length, 1);
  assert.equal(coverage.long, 0);
  // tracking jumps five metres away and comes back: neither sample is a place
  coverage = addToCoverage(coverage, [5, 1.4, 0], forwardAt(0), 0.75);
  coverage = addToCoverage(coverage, [0.02, 1.4, 0], forwardAt(0), 1);
  coverage = addToCoverage(coverage, [0.03, 1.4, 0], forwardAt(0), 1.25);
  assert.equal(coverage.places.length, 1);
  assert.ok(coverage.long < 0.11);
  // numbers that are not numbers change nothing
  assert.equal(addToCoverage(coverage, [Number.NaN, 0, 0], forwardAt(0), 2), coverage);
});

test('coverage: the tilt is counted in seconds looking down, level and up', () => {
  assert.equal(tiltDegrees([0, 0, -1]), 0);
  assert.ok(Math.abs((tiltDegrees(forwardAt(-35)) ?? 0) + 35) < 1e-6);
  assert.ok(Math.abs((tiltDegrees([0, 3, 0]) ?? 0) - 90) < 1e-6);
  assert.equal(tiltDegrees([0, 0, 0]), null);

  // 100 s at -15 degrees, as on 2026-11-21: level only.
  let coverage = NO_COVERAGE;
  for (let i = 0; i <= 400; i++) {
    coverage = addToCoverage(coverage, [0, 1.4, 0], forwardAt(-15), i * 0.25);
  }
  assert.ok(Math.abs(coverage.levelSeconds - 100) < 0.01);
  assert.equal(coverage.downSeconds, 0);
  assert.equal(coverage.upSeconds, 0);
  // ten seconds tilted down the way a phone is held, five at the ceiling
  for (let i = 1; i <= 40; i++) {
    coverage = addToCoverage(coverage, [0, 1.4, 0], forwardAt(-40), 100 + i * 0.25);
  }
  for (let i = 1; i <= 20; i++) {
    coverage = addToCoverage(coverage, [0, 1.4, 0], forwardAt(45), 110 + i * 0.25);
  }
  assert.ok(Math.abs(coverage.downSeconds - 10) < 0.01);
  assert.ok(Math.abs(coverage.upSeconds - 5) < 0.01);
  // the floor under the feet is not "tilted down": it counts for nothing
  for (let i = 1; i <= 40; i++) {
    coverage = addToCoverage(coverage, [0, 1.4, 0], forwardAt(-80), 115 + i * 0.25);
  }
  assert.ok(Math.abs(coverage.downSeconds - 10) < 0.01);
  assert.ok(Math.abs((coverage.tiltMin ?? 0) + 80) < 1e-6 && Math.abs((coverage.tiltMax ?? 0) - 45) < 1e-6);
  // a gap in the samples (tracking lost, the app put aside) is not time spent looking
  const before = coverage.upSeconds;
  coverage = addToCoverage(coverage, [0, 1.4, 0], forwardAt(45), 400);
  assert.ok(coverage.upSeconds - before <= 1);
  // without a forward vector only the place counts
  assert.equal(addToCoverage(NO_COVERAGE, [0, 1.4, 0], null, 0).tiltMin, null);
  assert.equal(
    describeCoverage({ ...ONE_SPOT, tiltMin: -32.2, tiltMax: 4.6, downSeconds: 12.4 }),
    'area 1.0 x 1.0 m, tilt -32..+5 deg (down 12 s, level 80 s, up 0 s)',
  );
  assert.match(describeCoverage(NO_COVERAGE), /tilt not measured/);
});

test('coverage: staying in one place is timed from when the phone got there', () => {
  // walking: the place is new again and again
  const walking = walk(line([0, 0], [3, 0]));
  assert.ok((walking.still?.since ?? 0) > 5, String(walking.still?.since));
  // turning on the heel with the phone held out stays one place
  let turning = NO_COVERAGE;
  for (let i = 0; i <= 80; i++) {
    const a = (i / 80) * 4 * Math.PI;
    turning = addToCoverage(turning, [0.25 * Math.cos(a), 1.4, 0.25 * Math.sin(a)], forwardAt(0), i * 0.25);
  }
  assert.equal(turning.still?.since, 0);
  assert.equal(scanView(scan({ seconds: 20, coverage: turning })).coach.line1, 'scan.coach.still.1');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65.9), '1:05');
});

test('build: one percentage for upload and build (5.7)', () => {
  assert.equal(uploadPercent(0), 0);
  assert.equal(uploadPercent(0.5), 4);
  assert.equal(uploadPercent(1), 8);
  assert.equal(buildPercent(0), 8);
  assert.equal(buildPercent(0.5), 54);
  assert.equal(buildPercent(1), 100);
  assert.equal(buildPercent(Number.NaN), 8);
  assert.equal(percentOf({ phase: 'uploading', uploadFraction: 0.5, jobProgress: 0 }), 4);
  assert.equal(percentOf({ phase: 'running', uploadFraction: 1, jobProgress: 0.5 }), 54);
  // 100 only for a finished build
  assert.equal(percentOf({ phase: 'running', uploadFraction: 1, jobProgress: 1 }), 99);
  assert.equal(percentOf({ phase: 'done', uploadFraction: 1, jobProgress: 1 }), 100);
});

test('build: the five steps follow the server stages', () => {
  // The server's stage shares: frames 5, features 5, matching 35, sfm 35, depth 8, room_plan 10, finalize 2.
  const after = (jobProgress: number) => currentStep(buildPercent(jobProgress));
  assert.equal(currentStep(uploadPercent(0.9)), 0); // sending
  assert.equal(after(0), 1); // reading the scan
  assert.equal(after(0.09), 1);
  assert.equal(after(0.1), 2); // building the 3D map
  assert.equal(after(0.79), 2);
  assert.equal(after(0.8), 3); // measuring the room
  assert.equal(after(0.88), 4); // finding the doorway
  assert.equal(after(0.99), 4);
  assert.equal(after(1), BUILD_STEPS.length);
});

test('build: the time line names what is happening', () => {
  const base = { percent: 30, uploadFraction: 0.42, megabytes: 180, queuePosition: 2, etaSeconds: null };
  assert.deepEqual(timeLine({ ...base, phase: 'uploading' }), { key: 'build.time.sending', params: { p: 42, n: 180 } });
  assert.deepEqual(timeLine({ ...base, phase: 'queued' }), { key: 'build.time.queued', params: { n: 2 } });
  assert.equal(timeLine({ ...base, phase: 'lost-contact' }).key, 'build.time.lost');
  assert.deepEqual(timeLine({ ...base, phase: 'running' }), { key: 'build.time.step', params: { i: 3 } });
  assert.deepEqual(timeLine({ ...base, phase: 'running', etaSeconds: 380 }), { key: 'build.time.minutes', params: { m: 6 } });
  assert.equal(timeLine({ ...base, phase: 'running', etaSeconds: 70 }).key, 'build.time.minutes.one');
  assert.equal(timeLine({ ...base, phase: 'running', etaSeconds: 40 }).key, 'build.time.lessThanMinute');
});

test('build: every failure has its screen, texts and at most two actions (7.2)', () => {
  const failures: BuildFailure[] = [
    'upload-interrupted',
    'too-large',
    'too_few_frames',
    'sfm_failed',
    'bad_recording',
    'out_of_memory',
    'server_restarted',
    'internal',
    'lost-contact',
  ];
  for (const failure of failures) {
    const problem = buildProblem(failure);
    assert.ok(en[problem.title], failure);
    assert.ok(en[problem.body], failure);
    assert.notEqual(problem.primary, problem.secondary);
  }
  assert.equal(buildProblem('upload-interrupted').primary, 'send-again');
  assert.equal(buildProblem('too-large').primary, 'scan-again');
  assert.equal(buildProblem('sfm_failed').tip, 'build.fail.short.body');
  assert.equal(buildProblem('internal').secondary, 'scan-again');
  assert.equal(buildProblem('lost-contact').primary, 'search-again');
});

test('build: server answers are sorted into the failures', () => {
  assert.equal(failureFromJobError('sfm_failed'), 'sfm_failed');
  assert.equal(failureFromJobError('too_few_frames'), 'too_few_frames');
  assert.equal(failureFromJobError('something_new'), 'internal');
  assert.equal(failureFromJobError(null), 'internal');
  assert.equal(failureFromUpload(null), 'upload-interrupted');
  assert.equal(failureFromUpload(413), 'too-large');
  assert.equal(failureFromUpload(422, 'recording_too_short'), 'too_few_frames');
  assert.equal(failureFromUpload(422, 'too_little_motion'), 'too_few_frames');
  assert.equal(failureFromUpload(422), 'bad_recording');
  assert.equal(failureFromUpload(409), 'internal');
  assert.equal(failureFromUpload(500), 'internal');
  assert.deepEqual(duration(50.4), { key: 'build.took.seconds', params: { s: 50 } });
  assert.deepEqual(duration(791.2), { key: 'build.took.minutes', params: { m: 13 } });
});

test('build: the opinion the server has of the scan is one line and its advice (placeholder contract)', () => {
  // nothing came: nothing is shown
  assert.deepEqual(qualityLines(null), { summary: null, advice: null });
  assert.deepEqual(qualityLines({ score: 0.42, verdict: 'made from one spot', advice: ['Walk round the room.', 'Look up and down.', 'A third line.'] }), {
    summary: { key: 'build.done.quality.both', params: { verdict: 'made from one spot', p: 42 } },
    advice: 'Walk round the room. Look up and down.',
  });
  assert.deepEqual(qualityLines({ score: 0.9, verdict: '', advice: [] }), { summary: { key: 'build.done.quality.score', params: { p: 90 } }, advice: null });
  assert.deepEqual(qualityLines({ score: null, verdict: 'good', advice: [] }).summary, { key: 'build.done.quality.verdict', params: { verdict: 'good' } });
  assert.deepEqual(qualityLines({ score: null, verdict: '', advice: ['Scan again.'] }), { summary: null, advice: 'Scan again.' });
  for (const key of ['build.done.quality.both', 'build.done.quality.score', 'build.done.quality.verdict'] as const) {
    assert.ok(en[key]);
  }
});

test('rooms: a new room gets its own id and the next free name', () => {
  assert.equal(newRoomId('Room 1', []), 'room_1');
  assert.equal(newRoomId('Room 1', ['room_1']), 'room_1_2');
  assert.equal(newRoomId('Room 1', ['room_1', 'room_1_2']), 'room_1_3');
  assert.equal(newRoomId('???', ['room']), 'room_2');
  const name = (n: number) => `Room ${n}`;
  assert.equal(nextRoomNumber([], [], name), 1);
  assert.equal(nextRoomNumber(['room'], [], name), 2);
  assert.equal(nextRoomNumber(['room', 'room_2'], [], name), 3);
  assert.equal(nextRoomNumber(['room_2'], [], name), 3);
  assert.equal(nextRoomNumber(['kitchen'], ['Room 2'], name), 3);
});
