import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cameraMatrix,
  invertPose,
  isPose,
  type MapInSession,
  mapInSession,
  type Mat4,
  multiply,
  parseRenderPose,
  quaternionFromYaw,
  STEADY,
  SteadyAlignment,
  toMap,
  toSession,
  yawFromQuaternion,
} from './vpsAlignment';
import { differs, VPS_MOVE, VPS_SEARCH, vpsProblem, vpsSearchAttempt } from './vpsStatus';

const DEG = Math.PI / 180;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** The matrix of "the map turned by `yawDeg` about Y, then shifted": map coordinates in, session coordinates out. */
function matrixOf(map: MapInSession): Mat4 {
  const cos = Math.cos(map.yawDeg * DEG);
  const sin = Math.sin(map.yawDeg * DEG);
  return [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, map.shift[0], map.shift[1], map.shift[2], 1];
}

/** A phone held somewhere in the session, looking a little down and to the side. */
const CAMERA = cameraMatrix([0.4, 1.3, -0.7], [0.5, -0.3, -0.8], [0, 1, 0]);

/** What the service would report for that camera if the map lay in the session as `truth` says. */
function cameraInMap(truth: MapInSession, camera: Mat4): Mat4 {
  return multiply(invertPose(matrixOf(truth)), camera);
}

test('vps: the camera pose as a matrix', () => {
  // at the origin, looking along -Z with the top up: the identity
  const still = cameraMatrix([0, 0, 0], [0, 0, -1], [0, 1, 0]);
  assert.ok(still);
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, i) => near(still?.[i] ?? NaN, value));
  assert.ok(isPose(CAMERA));
  // the directions do not define a frame
  assert.equal(cameraMatrix([0, 0, 0], [0, 1, 0], [0, 1, 0]), null);
  assert.equal(cameraMatrix([0, 0, 0], [0, 0, 0], [0, 1, 0]), null);
});

test('vps: what is a pose and what is not', () => {
  assert.equal(isPose(matrixOf({ yawDeg: 40, shift: [1, 2, 3] })), true);
  assert.equal(isPose([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]), false); // a scale
  assert.equal(isPose([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]), false); // a mirror
  assert.equal(isPose([1, 2, 3]), false);
  assert.equal(isPose('1,0,0'), false);
  const inverse = multiply(matrixOf({ yawDeg: 40, shift: [1, 2, 3] }), invertPose(matrixOf({ yawDeg: 40, shift: [1, 2, 3] })));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((value, i) => near(inverse[i], value));
});

test('vps: the render pose of the service is 16 numbers in a string', () => {
  assert.deepEqual(parseRenderPose('1,0,0,0, 0,1,0,0, 0,0,1,0, 0.5,-1.2,3,1'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1.2, 3, 1]);
  assert.equal(parseRenderPose('1,0,0'), null);
  assert.equal(parseRenderPose('1,0,0,0,0,1,0,0,0,0,1,0,0,x,0,1'), null);
  assert.equal(parseRenderPose(undefined), null);
});

test('vps: where the map lies in the session, from the two camera poses', () => {
  assert.ok(CAMERA);
  for (const truth of [
    { yawDeg: 0, shift: [0, 0, 0] },
    { yawDeg: 30, shift: [1, -0.2, 2] },
    { yawDeg: -150, shift: [-3, 0.1, 0.5] },
  ] as MapInSession[]) {
    const found = mapInSession(CAMERA, cameraInMap(truth, CAMERA as Mat4));
    assert.ok(found, `yaw ${truth.yawDeg}`);
    near(found?.yawDeg ?? NaN, truth.yawDeg);
    truth.shift.forEach((value, i) => near(found?.shift[i] ?? NaN, value));
  }
  // a reading that would tilt the map is thrown away: the two poses did not belong together
  const tilt = 10 * DEG;
  const tilted = multiply([1, 0, 0, 0, 0, Math.cos(tilt), Math.sin(tilt), 0, 0, -Math.sin(tilt), Math.cos(tilt), 0, 0, 0, 0, 1], CAMERA as Mat4);
  assert.equal(mapInSession(CAMERA, tilted), null);
  assert.equal(mapInSession(CAMERA, parseRenderPose('nonsense')), null);
  assert.equal(mapInSession(null, CAMERA), null);
});

test('vps: a door goes from the map into the session and back', () => {
  const map: MapInSession = { yawDeg: 90, shift: [1, -1.4, 2] };
  // the map's origin lands on the shift; a door 1 m along the map's +Z lands 1 m along the session's +X
  assert.deepEqual(toSession(map, { position: [0, 0, 0], yawDeg: 0 }).position, [1, -1.4, 2]);
  const door = toSession(map, { position: [0, 0.1, 1], yawDeg: 20 });
  near(door.position[0], 2);
  near(door.position[1], -1.3);
  near(door.position[2], 2);
  near(door.yawDeg, 110);
  // agrees with the matrix
  const viaMatrix = multiply(matrixOf(map), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.1, 1, 1]);
  near(viaMatrix[12], door.position[0]);
  near(viaMatrix[14], door.position[2]);
  // what staff save is what a visitor gets back
  const placed = { position: [-0.7, -1.38, 3.2] as [number, number, number], yawDeg: -165 };
  const back = toSession(map, toMap(map, placed));
  placed.position.forEach((value, i) => near(back.position[i], value));
  near(back.yawDeg, placed.yawDeg);
  // headings wrap
  near(toSession({ yawDeg: 170, shift: [0, 0, 0] }, { position: [0, 0, 0], yawDeg: 30 }).yawDeg, -160);
});

test('vps: a heading as the quaternion the server keeps', () => {
  const q = quaternionFromYaw(90);
  near(q[1], Math.SQRT1_2);
  near(q[3], Math.SQRT1_2);
  for (const yaw of [0, 35, 90, 179, -120]) {
    near(yawFromQuaternion(quaternionFromYaw(yaw)) ?? NaN, yaw);
  }
  near(yawFromQuaternion([0, 2, 0, 2]) ?? NaN, 90); // not normalised
  assert.equal(yawFromQuaternion([0, 0, 0, 0]), null);
  assert.equal(yawFromQuaternion([0, 1, 0]), null);
  assert.equal(yawFromQuaternion('x'), null);
});

test('vps: readings count once enough of them agree', () => {
  const steady = new SteadyAlignment();
  const base: MapInSession = { yawDeg: 30, shift: [1, 0, 2] };
  const jitter = (mm: number, deg = 0): MapInSession => ({ yawDeg: 30 + deg, shift: [1 + mm / 1000, 0, 2 - mm / 1000] });
  for (let i = 0; i < STEADY.readings - 1; i++) {
    assert.equal(steady.add(jitter(i), 1000 + i * 500), null, `reading ${i + 1} is not enough`);
  }
  const mean = steady.add(jitter(4), 3000);
  assert.ok(mean);
  near(mean?.yawDeg ?? NaN, 30, 1e-3);
  near(mean?.shift[0] ?? NaN, 1.002, 2e-3);

  // one reading taken while the phone moved: no agreement until it is out of the window
  assert.equal(steady.add({ yawDeg: 30, shift: [1.2, 0, 2] }, 3500), null);
  let again: MapInSession | null = null;
  for (let i = 0; i < STEADY.readings; i++) {
    again = steady.add(base, 4000 + i * 500);
  }
  assert.ok(again);

  // agreement is judged at the door: one degree of turn is 17 cm ten metres from the map's origin
  const far = new SteadyAlignment();
  const door = { position: [10, 0, 0] as [number, number, number], yawDeg: 0 };
  let judged: MapInSession | null = null;
  for (let i = 0; i < STEADY.readings; i++) {
    judged = far.add(jitter(0, i % 2), 1000 + i * 500, door);
  }
  assert.equal(judged, null);
  // the same readings are steady enough for a door at the origin
  const nearby = new SteadyAlignment();
  for (let i = 0; i < STEADY.readings; i++) {
    judged = nearby.add(jitter(0, i % 2), 1000 + i * 500);
  }
  assert.ok(judged);

  // old readings are forgotten; headings around 180 average to 180, not to 0
  const old = new SteadyAlignment();
  old.add(base, 0);
  old.add(base, 100);
  old.add(base, 200);
  assert.equal(old.add(base, 200 + STEADY.maxAgeMs + 1), null);
  const around = new SteadyAlignment();
  let wrapped: MapInSession | null = null;
  for (const yawDeg of [179.5, -179.5, 179.5, -179.5]) {
    wrapped = around.add({ yawDeg, shift: [0, 0, 0] }, 1000);
  }
  near(Math.abs(wrapped?.yawDeg ?? 0), 180, 1e-6);
});

test('vps: what the service says, in the app’s terms', () => {
  assert.equal(vpsProblem('CREDENTIALS_UNAVAILABLE'), 'not-set-up');
  assert.equal(vpsProblem('NETWORK_ERROR'), 'offline');
  assert.equal(vpsProblem('PAID_PLAN_REQUIRED'), 'refused');
  assert.equal(vpsProblem('COMPUTE_SPEND_LIMIT_REACHED'), 'refused');
  assert.equal(vpsProblem('NO_LOCATION'), 'refused');
  assert.equal(vpsProblem('UNSUPPORTED'), 'unsupported');
  assert.equal(vpsProblem('SOMETHING_NEW'), 'refused');
  assert.equal(vpsProblem(''), 'refused');
  // a newer start replaced this one: not a problem
  assert.equal(vpsProblem('SUPERSEDED'), null);

  // the coach lines follow the time: 1 = "hold still", 2 = "another view", 4 = "still looking"
  assert.equal(vpsSearchAttempt(0), 1);
  assert.equal(vpsSearchAttempt(VPS_SEARCH.anotherViewS), 2);
  assert.equal(vpsSearchAttempt(VPS_SEARCH.stillLookingS), 4);
  assert.equal(vpsSearchAttempt(VPS_SEARCH.giveUpS - 1), 4);
  assert.equal(vpsSearchAttempt(VPS_SEARCH.giveUpS), null);

  // a door that stands is moved only when the new place really differs
  const here = { position: [1, 0, 2], yawDeg: 175 };
  assert.equal(differs(here, { position: [1.1, 0, 2], yawDeg: -179 }, VPS_MOVE), false);
  assert.equal(differs(here, { position: [1.2, 0, 2], yawDeg: 175 }, VPS_MOVE), true);
  assert.equal(differs(here, { position: [1, 0, 2], yawDeg: -175 }, VPS_MOVE), true);
});
