import assert from 'node:assert/strict';
import { test } from 'node:test';

import { doorOutOfView, gridLines, gridStrength, nearestWall, wallDistance, type WallRect } from './insideView';

test('inside: the door is "behind you" only when it is out of the view', () => {
  const camera = [0, 1.4, 0];
  const door = [0, 0, 3]; // three metres along +Z
  assert.equal(doorOutOfView(camera, [0, 0, 1], door), false); // looking at it
  assert.equal(doorOutOfView(camera, [0, 0, -1], door), true); // back to it
  assert.equal(doorOutOfView(camera, [1, 0, 0], door), true); // sideways
  assert.equal(doorOutOfView(camera, [0.5, 0, 1], door), false); // 27 degrees off
  assert.equal(doorOutOfView(camera, [1, 0, 1], door), true); // 45 degrees off
  // looking down at the floor in the door's direction still counts as towards it
  assert.equal(doorOutOfView(camera, [0, -0.9, 0.3], door), false);
  // no direction: straight down, or standing on the threshold
  assert.equal(doorOutOfView(camera, [0, -1, 0], door), false);
  assert.equal(doorOutOfView([0, 1.4, 3], [0, 0, -1], door), false);
});

/** A wall 4 m wide whose inside faces +Z, standing at z = -2. */
const BACK: WallRect = { id: 'w0', position: [0, 1.25, -2], rotation: [0, 0, 0], width: 4, height: 2.5 };
/** A wall turned by 90 degrees: its inside faces +X, standing at x = -3. */
const LEFT: WallRect = { id: 'w1', position: [-3, 1.25, 0], rotation: [0, 90, 0], width: 4, height: 2.5 };

test('inside: distance to a real wall', () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(wallDistance([0, 1.4, 0], BACK), 2);
  near(wallDistance([1.5, 0.2, -1.6], BACK), 0.4); // height does not matter
  near(wallDistance([0, 1.4, -2.3], BACK), 0.3); // behind the wall counts too
  near(wallDistance([2.3, 1.4, -1.6], BACK), 0.5); // past its end: 0.3 along, 0.4 out
  near(wallDistance([-2.5, 1.4, 0.5], LEFT), 0.5);
  const nearest = nearestWall([-2.5, 1.4, 0.5], [BACK, LEFT]);
  assert.equal(nearest?.wall.id, 'w1');
  assert.equal(nearestWall([0, 0, 0], []), null);
});

test('inside: the grid comes up between 0.6 m and 0.3 m', () => {
  assert.equal(gridStrength(2), 0);
  assert.equal(gridStrength(0.6), 0);
  assert.ok(Math.abs(gridStrength(0.45) - 0.5) < 1e-9);
  assert.equal(gridStrength(0.3), 1);
  assert.equal(gridStrength(0.05), 1);
  assert.equal(gridStrength(Number.NaN), 0);
});

test('inside: grid lines cover the wall from edge to edge', () => {
  const { xs, ys } = gridLines(4, 2.5, 0.5);
  assert.equal(xs.length, 9);
  assert.equal(xs[0], -2);
  assert.equal(xs[8], 2);
  assert.equal(ys.length, 6);
  assert.equal(ys[0], -1.25);
  assert.equal(ys[5], 1.25);
  assert.deepEqual(gridLines(0.2, 0.2, 0.5).xs, [-0.1, 0.1]);
});
