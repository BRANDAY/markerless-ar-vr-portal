import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterSession, MISSED_SESSIONS, onlyRooms, roomLabel, roomMenu, roomRows, rowTone } from './roomsView';

const ROOMS = [
  { mapId: 'hall', label: 'Main hall', portalConfirmed: true },
  { mapId: 'side', label: '', portalConfirmed: false },
  { mapId: 'attic', label: 'Attic', portalConfirmed: true },
];

test('rooms: the state of each row (5.11)', () => {
  const rows = roomRows({ rooms: ROOMS, building: null, missed: { attic: MISSED_SESSIONS, hall: MISSED_SESSIONS - 1 } });
  assert.deepEqual(rows.map((row) => [row.mapId, row.state]), [['hall', 'ready'], ['side', 'no-door'], ['attic', 'changed']]);
  assert.deepEqual(rows.map((row) => rowTone(row.state)), ['teal', 'amber', 'danger']);
  // whatever the phone's file held for the counts
  for (const broken of [null, 'x', [3, 3, 3], { attic: '3' }, { attic: -1 }, { attic: Number.NaN }]) {
    assert.equal(roomRows({ rooms: ROOMS, building: null, missed: broken })[2].state, 'ready');
  }
});

test('rooms: a build shows on its room, a first build gets a row of its own', () => {
  const again = roomRows({ rooms: ROOMS, building: { mapId: 'attic', label: 'Attic', percent: 41.6 }, missed: { attic: 5 } });
  assert.deepEqual(again.map((row) => [row.mapId, row.state, row.percent, row.unbuilt]), [
    ['hall', 'ready', 0, false],
    ['side', 'no-door', 0, false],
    ['attic', 'building', 42, false],
  ]);
  assert.equal(rowTone('building'), 'amber');
  const first = roomRows({ rooms: ROOMS, building: { mapId: 'cellar', label: 'Cellar', percent: 130 }, missed: {} });
  assert.deepEqual(first[3], { mapId: 'cellar', label: 'Cellar', state: 'building', percent: 100, unbuilt: true });
  assert.equal(roomRows({ rooms: [], building: { mapId: 'cellar', label: 'Cellar', percent: Number.NaN }, missed: {} })[0].percent, 0);
});

test('rooms: what the menu of a row offers', () => {
  const [hall, side] = roomRows({ rooms: ROOMS, building: null, missed: {} });
  assert.deepEqual(roomMenu(hall, true, true), { door: 'move', removeDoor: true, changeSpace: true, scanAgain: true, rename: true, remove: true });
  // no door: it is placed, and there is none to remove
  assert.deepEqual(roomMenu(side, false, true), { door: 'place', removeDoor: false, changeSpace: true, scanAgain: true, rename: true, remove: true });
  // a server that cannot rename or delete rooms
  const old = roomMenu(hall, true, false);
  assert.equal(old?.rename, false);
  assert.equal(old?.remove, false);
  // nothing to do with a room whose map is being built
  const building = roomRows({ rooms: ROOMS, building: { mapId: 'hall', label: '', percent: 5 }, missed: {} })[0];
  assert.equal(roomMenu(building, true, true), null);
});

test('rooms: sessions in a row in which a room was not found', () => {
  let missed = afterSession({}, 'hall', false);
  missed = afterSession(missed, 'hall', false);
  assert.deepEqual(missed, { hall: 2 });
  assert.equal(roomRows({ rooms: ROOMS, building: null, missed })[0].state, 'ready');
  missed = afterSession(missed, 'hall', false);
  assert.equal(roomRows({ rooms: ROOMS, building: null, missed })[0].state, 'changed');
  // another room is counted on its own, and finding a room starts its count anew
  missed = afterSession(missed, 'side', false);
  assert.deepEqual(missed, { hall: 3, side: 1 });
  missed = afterSession(missed, 'hall', true);
  assert.deepEqual(missed, { side: 1 });
  assert.deepEqual(afterSession(missed, 'attic', true), { side: 1 });
  // a broken record counts from nothing
  assert.deepEqual(afterSession('x', 'hall', false), { hall: 1 });
  assert.deepEqual(afterSession({ hall: 'many', side: 2.9 }, 'hall', false), { side: 2, hall: 1 });
});

test('rooms: what is kept per room goes with the room', () => {
  assert.deepEqual(onlyRooms({ hall: 'sponza', gone: 'test-room' }, ['hall', 'side']), { hall: 'sponza' });
  assert.deepEqual(onlyRooms(null, ['hall']), {});
  assert.deepEqual(onlyRooms(['hall'], ['0']), {});
});

test('rooms: a name as typed', () => {
  assert.equal(roomLabel('  Exhibition   2 '), 'Exhibition 2');
  assert.equal(roomLabel('   '), null);
  assert.equal(roomLabel('x'.repeat(200))?.length, 80);
});
