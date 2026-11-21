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
  timeLine,
  uploadPercent,
} from './buildView';
import { addToPath, buttonLabel, clock, SCAN, type ScanInput, scanView } from './scanFlow';

function scan(over: Partial<ScanInput>): ScanInput {
  return {
    recording: true,
    seconds: 0,
    floorFound: true,
    walls: 2,
    metres: 0,
    doorwayShown: false,
    tracking: 'normal',
    trackingReason: '',
    ...over,
  };
}

test('scan: step 1 counts down to a minute with a disabled button (5.6)', () => {
  const start = scanView(scan({ seconds: 0 }));
  assert.equal(start.step, 1);
  assert.equal(start.coach.line1, 'scan.coach.walls.1');
  assert.deepEqual(start.button, { kind: 'wait', secondsLeft: 60 });
  assert.deepEqual(scanView(scan({ seconds: 12.3, metres: 9 })).button, { kind: 'wait', secondsLeft: 48 });
  assert.deepEqual(buttonLabel({ kind: 'wait', secondsLeft: 48 }), { key: 'scan.button.keepGoing', params: { s: 48 } });
  assert.equal(start.brackets, false);
});

test('scan: before the recording runs the coach asks to move the phone', () => {
  const view = scanView(scan({ recording: false, tracking: 'unavailable' }));
  assert.equal(view.coach.line1, 'ar.coach.ready.1');
  assert.equal(view.button.kind, 'wait');
  assert.equal(view.finishNow, false);
});

test('scan: step 2 needs a minute, a floor and six metres', () => {
  const ready = scanView(scan({ seconds: 61, metres: 6.2 }));
  assert.equal(ready.step, 2);
  assert.equal(ready.coach.line1, 'scan.coach.doorway.1');
  assert.deepEqual(ready.button, { kind: 'showed' });
  assert.equal(ready.brackets, true);

  for (const missing of [scan({ seconds: 61, metres: 3 }), scan({ seconds: 61, metres: 9, floorFound: false })]) {
    const view = scanView(missing);
    assert.equal(view.step, 1);
    assert.equal(view.coach.line1, 'scan.coach.keepWalking.1');
    assert.deepEqual(view.button, { kind: 'wait', secondsLeft: 0 });
    assert.equal(buttonLabel(view.button).key, 'scan.button.keepGoing.walk');
  }
});

test('scan: step 3 after the user showed the doorway, or at 150 s whatever happened', () => {
  const confirmed = scanView(scan({ seconds: 70, metres: 7, doorwayShown: true }));
  assert.equal(confirmed.step, 3);
  assert.equal(confirmed.coach.line1, 'scan.coach.enough.1');
  assert.deepEqual(confirmed.button, { kind: 'finish' });
  assert.equal(confirmed.finishNow, false);

  const late = scanView(scan({ seconds: SCAN.hintSeconds, metres: 1, floorFound: false }));
  assert.equal(late.step, 3);
  assert.equal(late.coach.line1, 'scan.coach.finishNow.1');
  assert.equal(late.button.kind, 'finish');
  assert.equal(scanView(scan({ seconds: 179 })).finishNow, false);
  assert.equal(scanView(scan({ seconds: SCAN.maxSeconds })).finishNow, true);
});

test('scan: a tracking warning replaces the step text but not the button', () => {
  const view = scanView(scan({ seconds: 70, metres: 7, tracking: 'limited', trackingReason: 'excessive motion' }));
  assert.equal(view.coach.line1, 'ar.coach.motion.1');
  assert.deepEqual(view.button, { kind: 'showed' });
  assert.equal(scanView(scan({ tracking: 'limited', trackingReason: 'insufficient light' })).coach.line1, 'ar.coach.dark.1');
  assert.equal(scanView(scan({ tracking: 'limited', trackingReason: 'insufficient features' })).coach.line1, 'ar.coach.plain.1');
});

test('scan: the walls counter is hidden when no wall shows up within 20 s', () => {
  assert.equal(scanView(scan({ walls: 0, seconds: 5 })).showWalls, true);
  assert.equal(scanView(scan({ walls: 0, seconds: 25 })).showWalls, false);
  assert.equal(scanView(scan({ walls: 1, seconds: 25 })).showWalls, true);
});

test('scan: the way walked ignores shaking, jumps and height', () => {
  let state = addToPath(0, null, [0, 1.4, 0]);
  assert.equal(state.total, 0);
  state = addToPath(state.total, state.from, [0.01, 1.4, 0]); // shaking
  assert.equal(state.total, 0);
  state = addToPath(state.total, state.from, [0.3, 1.2, 0.4]); // half a metre on the floor plan
  assert.ok(Math.abs(state.total - 0.5) < 0.01);
  state = addToPath(state.total, state.from, [5, 1.2, 0.4]); // tracking jumped
  assert.ok(Math.abs(state.total - 0.5) < 0.01);
  state = addToPath(state.total, state.from, [5, 1.2, 0.9]);
  assert.ok(Math.abs(state.total - 1.0) < 0.01);
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
