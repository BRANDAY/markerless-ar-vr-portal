import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyRelative,
  distanceM,
  doorFromAnchor,
  eulerToMatrix,
  matrixToEuler,
  multiply,
  relativeTo,
  type RigidPose,
  rotate,
  tiltDeg,
  transpose,
  uprightYawDeg,
  type Vec3,
} from './anchorMath';

function near(actual: number, expected: number, eps = 1e-6, message?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, message ?? `${actual} is not within ${eps} of ${expected}`);
}

function nearVec(actual: Vec3, expected: Vec3, eps = 1e-6): void {
  for (let i = 0; i < 3; i++) {
    near(actual[i], expected[i], eps, `component ${i}: ${actual[i]} vs ${expected[i]}`);
  }
}

/** Two Euler triples describe the same rotation. */
function sameRotation(a: Vec3, b: Vec3, eps = 1e-6): void {
  const ma = eulerToMatrix(a);
  const mb = eulerToMatrix(b);
  for (let i = 0; i < 9; i++) {
    near(ma[i], mb[i], eps, `matrix element ${i}: ${ma[i]} vs ${mb[i]}`);
  }
}

test('euler: yaw turns local +Z towards +X (the convention of math.ts yawFacing)', () => {
  nearVec(rotate(eulerToMatrix([0, 90, 0]), [0, 0, 1]), [1, 0, 0]);
  nearVec(rotate(eulerToMatrix([90, 0, 0]), [0, 1, 0]), [0, 0, 1]);
  nearVec(rotate(eulerToMatrix([0, 0, 90]), [1, 0, 0]), [0, 1, 0]);
});

test('euler: the order is Rz * Ry * Rx', () => {
  const combined = eulerToMatrix([20, 30, 40]);
  const byHand = multiply(eulerToMatrix([0, 0, 40]), multiply(eulerToMatrix([0, 30, 0]), eulerToMatrix([20, 0, 0])));
  for (let i = 0; i < 9; i++) {
    near(combined[i], byHand[i]);
  }
});

test('euler: matrix -> euler -> matrix is the same rotation, also at gimbal lock', () => {
  const samples: Vec3[] = [
    [0, 0, 0],
    [10, -35, 70],
    [-120, 45, 170],
    [33, 90, 12],
    [33, -90, 12],
    [179, 1, -179],
  ];
  for (const sample of samples) {
    sameRotation(matrixToEuler(eulerToMatrix(sample)), sample);
  }
});

test('relative pose: applying the offset to the same anchor gives the doorway back', () => {
  const anchor: RigidPose = { position: [1.2, -1.35, -3.4], rotation: [2, 137, -1.5] };
  const door: RigidPose = { position: [0.4, -1.4, -2.1], rotation: [0, -48, 0] };
  const offset = relativeTo(anchor, door);
  const back = applyRelative(anchor, offset);
  nearVec(back.position, door.position);
  sameRotation(back.rotation, door.rotation);
});

test('relative pose: the doorway follows the anchor into another session frame', () => {
  // Session A: anchor on the floor 1 m in front of the doorway (on its AR side).
  const anchorA: RigidPose = { position: [0, 0, 1], rotation: [0, 0, 0] };
  const doorA: RigidPose = { position: [0, 0, 0], rotation: [0, 0, 0] };
  const offset = relativeTo(anchorA, doorA);
  nearVec(offset.position, [0, 0, -1]);

  // Session B started elsewhere, turned by 90 degrees: the same anchor is seen here.
  const anchorB: RigidPose = { position: [5, -1.3, 2], rotation: [0, 90, 0] };
  const doorB = doorFromAnchor(anchorB, offset);
  assert.ok(doorB);
  // The anchor's local -Z is world -X after a 90 degree yaw.
  nearVec(doorB.position, [4, -1.3, 2]);
  nearVec(doorB.rotation, [0, 90, 0]);
});

test('relative pose: a rigid change of the session frame moves anchor and doorway together', () => {
  const anchor: RigidPose = { position: [0.7, -1.2, -0.4], rotation: [1, 25, -2] };
  const door: RigidPose = { position: [-0.6, -1.25, -1.9], rotation: [0, 160, 0] };
  const offset = relativeTo(anchor, door);

  // The new session frame differs by a yaw and a shift (gravity keeps Y up in both).
  const change: RigidPose = { position: [3, 0.4, -7], rotation: [0, -73, 0] };
  const anchorNew = applyRelative(change, anchor);
  const expectedDoor = applyRelative(change, door);
  const rebuilt = doorFromAnchor(anchorNew, offset);
  assert.ok(rebuilt);
  nearVec(rebuilt.position, expectedDoor.position);
  const expectedYaw = uprightYawDeg(expectedDoor.rotation);
  assert.ok(expectedYaw !== null);
  near(Math.cos((rebuilt.rotation[1] - expectedYaw) * (Math.PI / 180)), 1, 1e-9);
});

test('doorway from anchor: the result is upright even when the anchor leans a little', () => {
  const offset = relativeTo({ position: [0, 0, 0], rotation: [0, 0, 0] }, { position: [0, 0, -1], rotation: [0, 30, 0] });
  const door = doorFromAnchor({ position: [0, 0, 0], rotation: [3, 0, -2] }, offset);
  assert.ok(door);
  assert.equal(door.rotation[0], 0);
  assert.equal(door.rotation[2], 0);
  near(door.rotation[1], 30, 0.5);
});

test('doorway from anchor: a pose lying on its back is refused', () => {
  const offset: RigidPose = { position: [0, 0, 0], rotation: [0, 0, 0] };
  assert.equal(doorFromAnchor({ position: [0, 0, 0], rotation: [-90, 0, 0] }, offset), null);
  assert.equal(doorFromAnchor({ position: [Number.NaN, 0, 0], rotation: [0, 0, 0] }, offset), null);
});

test('tilt: upright is 0, lying is 90', () => {
  near(tiltDeg([0, 123, 0]), 0);
  near(tiltDeg([90, 0, 0]), 90);
  near(tiltDeg([0, 40, 10]), 10);
});

test('helpers: transpose inverts a rotation, distance is Euclidean', () => {
  const m = eulerToMatrix([12, 34, 56]);
  const identity = multiply(m, transpose(m));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, i) => near(identity[i], value));
  near(distanceM([0, 0, 0], [3, 4, 12]), 13);
});
