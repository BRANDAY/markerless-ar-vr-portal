import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ArInput, arView, trackingWarning } from './arView';

function input(over: Partial<ArInput>): ArInput {
  return {
    status: 'localizing',
    meta: {},
    hasDoor: false,
    mode: 'AR',
    tracking: 'normal',
    trackingReason: '',
    source: 'room',
    connection: 'connected',
    ...over,
  };
}

test('inside the space: nothing but the wall warning', () => {
  const inside = arView(input({ status: 'localized', hasDoor: true, mode: 'VR' }));
  assert.equal(inside.situation, 'inside');
  assert.equal(inside.coach, null);
  const close = arView(input({ status: 'localized', hasDoor: true, mode: 'VR', wallClose: true }));
  assert.equal(close.coach?.line1, 'ar.inside.wall.1');
  // on the room side of the door a close wall is nobody's business
  assert.equal(arView(input({ status: 'localized', hasDoor: true, wallClose: true })).coach, null);
});

test('finding the room: the coach line follows the attempt (5.9)', () => {
  const line = (attempt: number, code?: string) =>
    arView(input({ meta: { attempt, attempts: 5, code } })).coach?.line1;
  assert.equal(arView(input({ status: 'waiting-for-tracking' })).coach?.line1, 'ar.coach.ready.1');
  assert.equal(line(1), 'ar.coach.find.1');
  assert.equal(line(2), 'ar.coach.another.1');
  assert.equal(line(3), 'ar.coach.another.1');
  assert.equal(line(4), 'ar.coach.still.1');
  assert.equal(line(5), 'ar.coach.still.1');
  assert.equal(line(2, 'scale-unknown'), 'ar.coach.sideways.1');
});

test('finding the room: "This is a different room" from the fourth attempt', () => {
  assert.equal(arView(input({ meta: { attempt: 3 } })).offerOtherRoom, false);
  assert.equal(arView(input({ meta: { attempt: 4 } })).offerOtherRoom, true);
});

test('finding the room: tracking warnings replace the coach line while they apply', () => {
  const warned = (reason: string) =>
    arView(input({ meta: { attempt: 2 }, tracking: 'limited', trackingReason: reason })).coach?.line1;
  assert.equal(warned('excessive motion'), 'ar.coach.motion.1');
  assert.equal(warned('insufficient light'), 'ar.coach.dark.1');
  assert.equal(warned('insufficient features'), 'ar.coach.plain.1');
  assert.equal(warned(''), 'ar.coach.ready.1');
  assert.equal(trackingWarning('normal', 'excessive motion'), null);
});

test('a first pose that is being checked: outline, the line says so, no door situation', () => {
  const placed = arView(input({ status: 'localized', hasDoor: true, meta: { pending: true } }));
  assert.equal(placed.outline, true);
  assert.equal(placed.situation, 'finding');
  assert.equal(placed.coach?.line2, 'ar.coach.checking.2');
  const checking = arView(input({ status: 'localizing', hasDoor: true, meta: { pending: true, attempt: 2 } }));
  assert.equal(checking.outline, true);
  assert.equal(checking.coach?.line1, 'ar.coach.another.1');
  assert.equal(checking.coach?.line2, 'ar.coach.checking.2');
});

test('door in the room: nothing but the door when all is well', () => {
  const v = arView(input({ status: 'localized', hasDoor: true }));
  assert.deepEqual(
    { s: v.situation, coach: v.coach, pill: v.pill, lost: v.lostBanner, sheet: v.sheet, outline: v.outline, leave: v.leave },
    { s: 'door', coach: null, pill: null, lost: false, sheet: null, outline: false, leave: null },
  );
  // A later check of a door that was trusted before keeps the door on screen.
  assert.equal(arView(input({ status: 'localizing', hasDoor: true, meta: { attempt: 1, pending: false } })).situation, 'door');
});

test('door in the room: the small states', () => {
  assert.equal(arView(input({ status: 'lost', hasDoor: true, meta: { code: 'unconfirmed' } })).pill, 'off');
  assert.equal(arView(input({ status: 'localized', hasDoor: true, connection: 'unreachable' })).pill, 'offline');
  // A door placed without a server does not care about the server.
  assert.equal(arView(input({ status: 'localized', hasDoor: true, connection: 'not-configured', source: 'free' })).pill, null);
  // The first heartbeats of a launch are not "offline".
  assert.equal(arView(input({ status: 'localized', hasDoor: true, connection: 'connecting' })).pill, null);
  const lost = arView(input({ status: 'lost', hasDoor: true, meta: { code: 'tracking-lost' } }));
  assert.equal(lost.lostBanner, true);
  assert.equal(lost.situation, 'door');
  assert.equal(lost.pill, null);
});

test('problems in AR (7.3)', () => {
  const unknown = arView(input({ status: 'lost', meta: { code: 'not-recognised' } }));
  assert.equal(unknown.sheet, 'unknown');
  assert.equal(unknown.lostBanner, false);
  assert.equal(arView(input({ status: 'error', meta: { code: 'no-doorway' } })).sheet, 'noDoor');
  assert.equal(arView(input({ status: 'error', hasDoor: true, meta: { code: 'no-doorway' } })).sheet, 'noDoor');
  assert.equal(arView(input({ status: 'lost', meta: { code: 'tracking-lost' } })).lostBanner, true);
});

test('the AR screen cannot go on: leave for Home or a problem screen', () => {
  assert.equal(arView(input({ status: 'error', meta: { code: 'no-room' } })).leave, 'no-room');
  assert.equal(arView(input({ status: 'error', meta: { code: 'incompatible' } })).leave, 'version');
  assert.equal(arView(input({ status: 'waiting-for-server', meta: { code: 'server-offline' } })).leave, 'server');
  assert.equal(arView(input({ status: 'waiting-for-server', meta: { code: 'no-server' } })).leave, 'server');
  // While the first connection of a launch is being made the screen waits.
  const connecting = arView(input({ status: 'waiting-for-server', meta: { code: 'connecting' } }));
  assert.equal(connecting.leave, null);
  assert.equal(connecting.coach?.line1, 'ar.coach.server.1');
});

test('inside the space: no coach, no pill', () => {
  const v = arView(input({ status: 'localized', hasDoor: true, mode: 'VR' }));
  assert.equal(v.situation, 'inside');
  assert.equal(v.coach, null);
});

test('a door placed by hand: only "getting ready" before it stands', () => {
  assert.equal(arView(input({ source: 'free', status: 'localizing', meta: {} })).coach?.line1, 'ar.coach.ready.1');
  assert.equal(arView(input({ source: 'free', status: 'localizing', meta: {} })).offerOtherRoom, false);
});
