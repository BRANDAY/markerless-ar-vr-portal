import assert from 'node:assert/strict';
import { test } from 'node:test';

import { roomDisplayName, roomIdFromName } from '../../room/roomNames';
import { chipState, homeSituation, pickRoom } from './homeView';
import { planLayout, segmentBar } from './planLayout';

test('home: the situation follows the connection and the rooms (5.4)', () => {
  const at = (connection: string, rooms: string[] = [], lastRoomId: string | null = null, building = false) =>
    homeSituation({ connection, rooms, lastRoomId, building });
  assert.equal(at('connected', ['room']), 'room-ready');
  assert.equal(at('connected', []), 'no-room');
  assert.equal(at('connected', ['room'], null, true), 'building');
  assert.equal(at('unreachable', [], 'room'), 'offline');
  assert.equal(at('unreachable', [], null), 'offline-unknown');
  assert.equal(at('incompatible', [], 'room'), 'offline');
  assert.equal(at('not-configured'), 'no-server');
  assert.equal(at('searching'), 'connecting');
  assert.equal(at('connecting'), 'connecting');
});

test('home: the server chip', () => {
  assert.equal(chipState('connected'), 'connected');
  assert.equal(chipState('searching'), 'connecting');
  assert.equal(chipState('unreachable'), 'offline');
  assert.equal(chipState('incompatible'), 'offline');
  assert.equal(chipState('not-configured'), 'none');
});

test('the room to work with', () => {
  assert.equal(pickRoom(['a', 'b'], 'b'), 'b');
  assert.equal(pickRoom(['a', 'room'], 'gone'), 'room');
  assert.equal(pickRoom(['a', 'b'], null), 'a');
  assert.equal(pickRoom([], 'b'), null);
});

test('room names and ids', () => {
  assert.equal(roomDisplayName('living_room'), 'Living room');
  assert.equal(roomDisplayName('room'), 'Room');
  assert.equal(roomIdFromName('Room 1'), 'room_1');
  assert.equal(roomIdFromName('  Dnevna soba – Čiovo!  '), 'dnevna_soba_ciovo');
  assert.equal(roomIdFromName('???'), 'room');
  assert.ok(roomIdFromName('x'.repeat(100)).length <= 40);
});

// A 4 x 3 m room in the X/Z plane with a 0.9 m door in the wall z = 0.
const ROOM = {
  walls: [
    { id: 'w0', width: 4, corners: [[0, 0, 0], [4, 0, 0], [4, 2.5, 0], [0, 2.5, 0]] },
    { id: 'w1', width: 3, corners: [[4, 0, 0], [4, 0, 3], [4, 2.5, 3], [4, 2.5, 0]] },
    { id: 'w2', width: 4, corners: [[4, 0, 3], [0, 0, 3], [0, 2.5, 3], [4, 2.5, 3]] },
    { id: 'w3', width: 3, corners: [[0, 0, 3], [0, 0, 0], [0, 2.5, 0], [0, 2.5, 3]] },
  ],
  corners: [{ bottom: [0, 0, 0] }, { bottom: [4, 0, 0] }, { bottom: [4, 0, 3] }, { bottom: [0, 0, 3] }],
  openings: [
    { id: 'o0', width: 0.9, height: 2, heightMeasured: true, state: 'open', corners: [[1, 0, 0], [1.9, 0, 0]], portalPosition: [1.45, 0, 0] },
    { id: 'o1', width: 0.8, height: 2, heightMeasured: false, state: 'closed', corners: [[4, 0, 1], [4, 0, 1.8]], portalPosition: [4, 0, 1.4] },
  ],
};

test('plan: the room is fitted into the box and keeps its proportions', () => {
  const layout = planLayout(ROOM, 232, 182, null, 16);
  assert.ok(layout);
  if (!layout) {
    return;
  }
  // 200 x 150 points for 4 x 3 m: 50 points per metre in both directions.
  assert.ok(Math.abs(layout.scale - 50) < 1e-9);
  assert.equal(layout.metreBar, layout.scale);
  assert.deepEqual(layout.walls[0].a, { x: 16, y: 16 });
  assert.deepEqual(layout.walls[0].b, { x: 216, y: 16 });
  assert.equal(layout.corners.length, 4);
  assert.equal(layout.walls[1].lengthM, 3);
  // A narrow box: the scale comes from the tighter direction and the drawing is centred.
  const narrow = planLayout(ROOM, 132, 400, null, 16);
  assert.ok(narrow && Math.abs(narrow.scale - 25) < 1e-9);
  assert.ok(narrow && Math.abs(narrow.walls[0].a.y - (400 - 75) / 2) < 1e-9);
});

test('plan: doorways get letters, and the one in use is marked', () => {
  const none = planLayout(ROOM, 232, 182);
  assert.deepEqual(none?.openings.map((o) => [o.letter, o.chosen]), [['A', false], ['B', false]]);
  const second = planLayout(ROOM, 232, 182, [4.05, 0, 1.35]);
  assert.deepEqual(second?.openings.map((o) => o.chosen), [false, true]);
  // A doorway set by hand somewhere else matches no opening.
  assert.deepEqual(planLayout(ROOM, 232, 182, [2, 0, 3])?.openings.map((o) => o.chosen), [false, false]);
  assert.equal(second?.openings[1].heightMeasured, false);
});

test('plan: nothing to draw without walls', () => {
  assert.equal(planLayout({ walls: [], corners: [], openings: [] }, 200, 200), null);
});

test('plan: a segment as a rotated bar', () => {
  const bar = segmentBar({ a: { x: 0, y: 0 }, b: { x: 0, y: 10 } });
  assert.deepEqual([bar.cx, bar.cy, bar.length, Math.round(bar.angleDeg)], [0, 5, 10, 90]);
});
