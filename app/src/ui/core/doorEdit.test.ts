import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  doorAt,
  type DoorDraft,
  doorSize,
  moveDoor,
  normalizeYaw,
  resizeDoor,
  sameDoor,
  sizeLabel,
  turnAround,
  turnDoor,
} from './doorEdit';

const SIZE = { width: 0.9, height: 2.0 };
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

/** Where the door's own +Z (the room side) points in the world, on the floor plan. */
function roomSide(door: DoorDraft): [number, number] {
  const moved = moveDoor(door, 0, 20); // one metre towards the room
  return [moved.position[0] - door.position[0], moved.position[2] - door.position[2]];
}

test('place the door: "Put it here" stands the door on the spot, facing the camera (5.14)', () => {
  const door = doorAt([1, -1.2, -3], [1, 0.3, -1], SIZE);
  assert.deepEqual(door.position, [1, -1.2, -3]); // on the floor, not at the phone's height
  near(door.yaw, 0);
  const [x, z] = roomSide(door);
  near(x, 0);
  near(z, 1); // the room side looks at the camera (+Z here)

  const side = doorAt([0, 0, 0], [2, 1.4, 0], SIZE);
  near(side.yaw, 90);
  const [sx, sz] = roomSide(side);
  near(sx, 1);
  near(sz, 0);

  const diagonal = doorAt([0, 0, 0], [-1, 1.4, -1], SIZE);
  near(diagonal.yaw, -135);
  // standing on the spot: no direction, no NaN
  assert.equal(doorAt([0, 0, 0], [0, 1.4, 0], SIZE).yaw, 0);
});

test('place the door: move by 5 cm along the door and towards the room', () => {
  const door: DoorDraft = { position: [0, 0, 0], yaw: 0, ...SIZE };
  assert.deepEqual(moveDoor(door, 1, 0).position, [0.05, 0, 0]);
  assert.deepEqual(moveDoor(door, -2, 0).position, [-0.1, 0, 0]);
  assert.deepEqual(moveDoor(door, 0, 1).position, [0, 0, 0.05]);
  // turned by 90 degrees the door's own axes turn with it
  const turned: DoorDraft = { ...door, yaw: 90 };
  assert.deepEqual(moveDoor(turned, 0, 1).position, [0.05, 0, 0]);
  assert.deepEqual(moveDoor(turned, 1, 0).position, [0, 0, -0.05]);
  // twenty steps there and back end where they began
  let walked = door;
  for (let i = 0; i < 20; i += 1) {
    walked = moveDoor(walked, 1, 1);
  }
  for (let i = 0; i < 20; i += 1) {
    walked = moveDoor(walked, -1, -1);
  }
  assert.equal(sameDoor(walked, door), true);
  assert.equal(walked.position[1], 0); // never up or down
});

test('place the door: turn by 5 degrees, and around', () => {
  const door: DoorDraft = { position: [0, 0, 0], yaw: 170, ...SIZE };
  assert.equal(turnDoor(door, 1).yaw, 175);
  assert.equal(turnDoor(door, 2).yaw, 180);
  assert.equal(turnDoor(door, 3).yaw, -175);
  assert.equal(turnDoor(door, -1).yaw, 165);
  assert.equal(turnAround(door).yaw, -10);
  assert.equal(turnAround(turnAround(door)).yaw, 170);
  assert.equal(normalizeYaw(540), 180);
  assert.equal(normalizeYaw(-190), 170);
});

test('place the door: size in steps of 5 cm, 0.60-1.40 m wide and 1.80-2.40 m high', () => {
  const door: DoorDraft = { position: [0, 0, 0], yaw: 0, ...SIZE };
  assert.equal(resizeDoor(door, 1, 0).width, 0.95);
  assert.equal(resizeDoor(door, -1, 1).height, 2.05);
  assert.equal(resizeDoor(door, -20, 0).width, 0.6);
  assert.equal(resizeDoor(door, 20, 0).width, 1.4);
  assert.equal(resizeDoor(door, 0, -20).height, 1.8);
  assert.equal(resizeDoor(door, 0, 20).height, 2.4);
  // what the server measured is brought into the range; nothing measured is the default
  assert.deepEqual(doorSize(0.863, 2.021), { width: 0.86, height: 2.02 });
  assert.deepEqual(doorSize(3.2, 1.2), { width: 1.4, height: 1.8 });
  assert.deepEqual(doorSize(null, undefined), { width: 0.9, height: 2 });
  assert.equal(sizeLabel({ width: 0.85, height: 2.05 }), '0.85 × 2.05 m');
});

test('place the door: something changed, or not', () => {
  const door: DoorDraft = { position: [1, 0, 2], yaw: 30, ...SIZE };
  assert.equal(sameDoor(door, { ...door }), true);
  assert.equal(sameDoor(door, moveDoor(door, 1, 0)), false);
  assert.equal(sameDoor(door, turnDoor(door, 1)), false);
  assert.equal(sameDoor(door, resizeDoor(door, 1, 0)), false);
  assert.equal(sameDoor({ ...door, yaw: 180 }, { ...door, yaw: -180 }), true);
});
