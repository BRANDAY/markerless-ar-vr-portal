import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aimedSpot, doorInFront, draftFromServer, floorUnder, PLACING, putHere, yawFromEuler } from './doorEdit';
import { homeSituation } from './homeView';
import { foundDoorways, placeCoach, type PlaceInput, placeScreen, placeStart, roomResultBody } from './placeView';
import { planLayout } from './planLayout';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const SIZE = { width: 0.9, height: 2.0 };

test('room result: what the server found, in words (5.8)', () => {
  const doorway = (width: number, height: number, heightMeasured = true) => ({ width, height, heightMeasured });
  assert.deepEqual(roomResultBody({ status: 'ok', openings: [doorway(0.86, 2.02)] }), {
    key: 'roomResult.one',
    params: { w: '0.86', h: '2.02' },
  });
  // only the width could be measured
  assert.deepEqual(roomResultBody({ status: 'ok', openings: [doorway(0.86, 2.0, false)] }), {
    key: 'roomResult.one.width',
    params: { w: '0.86' },
  });
  assert.deepEqual(roomResultBody({ status: 'partial', openings: [doorway(0.9, 2), doorway(0.8, 2), doorway(1, 2)] }), {
    key: 'roomResult.several',
    params: { n: 3 },
  });
  assert.equal(roomResultBody({ status: 'ok', openings: [] }).key, 'roomResult.noDoorway');
  assert.equal(roomResultBody({ status: 'unavailable', openings: [] }).key, 'roomResult.noPlan');
  assert.equal(roomResultBody(null).key, 'roomResult.noPlan');
});

test('place the door: where the door first stands (5.14)', () => {
  assert.equal(placeStart({ source: 'manual', hasPose: true }, true), 'saved');
  assert.equal(placeStart({ source: 'selected', hasPose: true }, false), 'saved');
  // a doorway the server found by itself is a suggestion, not a saved door
  assert.equal(placeStart({ source: 'auto', hasPose: true }, true), 'suggested');
  assert.equal(placeStart({ source: 'none', hasPose: false }, true), 'suggested');
  assert.equal(placeStart({ source: 'none', hasPose: false }, false), 'free');
  assert.equal(placeStart(null, false), 'free');
  assert.equal(placeCoach('saved').line1, 'place.coach.saved.1');
  assert.equal(placeCoach('suggested').line2, 'place.coach.suggested.2');
  assert.equal(placeCoach('free').line1, 'place.coach.free.1');
});

test('place the door: the screen is the search until the room is found, then the door (5.14)', () => {
  const input = (over: Partial<PlaceInput>): PlaceInput => ({
    status: 'localizing',
    meta: { attempt: 1, attempts: 5 },
    hasDoor: false,
    tracking: 'normal',
    trackingReason: '',
    connection: 'connected',
    found: false,
    start: 'free',
    touched: false,
    ...over,
  });
  // finding the room: the texts of the AR screen, attempt by attempt
  assert.deepEqual(placeScreen(input({})), {
    ready: false,
    coach: { line1: 'ar.coach.find.1', line2: 'ar.coach.find.2' },
    lostBanner: false,
    sheet: null,
    leave: null,
  });
  assert.equal(placeScreen(input({ meta: { attempt: 4, attempts: 5 } })).coach?.line1, 'ar.coach.still.1');
  assert.equal(placeScreen(input({ tracking: 'limited', trackingReason: 'excessive motion' })).coach?.line1, 'ar.coach.motion.1');

  // found, no saved door: the provider says "no door" and the placing screen is ready
  const noDoor = placeScreen(input({ status: 'error', meta: { code: 'no-doorway' }, found: true }));
  assert.equal(noDoor.ready, true);
  assert.equal(noDoor.coach?.line1, 'place.coach.free.1');
  assert.equal(noDoor.sheet, null);
  // found with a saved door
  const saved = placeScreen(input({ status: 'localized', hasDoor: true, found: true, start: 'saved' }));
  assert.equal(saved.ready, true);
  assert.equal(saved.coach?.line1, 'place.coach.saved.1');
  // the first instruction goes once a control has been used
  assert.equal(placeScreen(input({ status: 'localized', hasDoor: true, found: true, start: 'saved', touched: true })).coach, null);

  // a first answer that is still being checked is not "found": saving through it would be off
  const pending = placeScreen(input({ status: 'localized', hasDoor: true, meta: { pending: true }, found: true, start: 'saved' }));
  assert.equal(pending.ready, false);
  assert.equal(pending.coach?.line2, 'ar.coach.checking.2');

  // tracking lost: the banner, and nothing to save until the room is found again
  const lost = placeScreen(input({ status: 'lost', meta: { code: 'tracking-lost' }, hasDoor: true, found: false }));
  assert.deepEqual([lost.ready, lost.lostBanner, lost.coach], [false, true, null]);
  // found again after a loss, the saved door still on screen: the search is explained
  assert.equal(placeScreen(input({ status: 'localizing', meta: { attempt: 1 }, hasDoor: true })).coach?.line1, 'ar.coach.find.1');

  // not recognised, no room, no server
  assert.equal(placeScreen(input({ status: 'lost', meta: { code: 'not-recognised' } })).sheet, 'unknown');
  assert.equal(placeScreen(input({ status: 'error', meta: { code: 'no-room' } })).leave, 'no-room');
  assert.equal(placeScreen(input({ status: 'waiting-for-server', meta: { code: 'server-offline' }, connection: 'unreachable' })).leave, 'server');
  // after a save the server refused for want of an alignment: "no door" is not a sheet here
  const again = placeScreen(input({ status: 'error', meta: { code: 'no-doorway' }, found: false }));
  assert.deepEqual([again.ready, again.sheet, again.coach?.line1], [false, null, 'ar.coach.find.1']);
});

test('place the door: the found doorways, the suggested one first', () => {
  const opening = (id: string, x: number, heightMeasured = true) => ({
    id,
    portalPosition: [x, 0, 0],
    portalRotation: [0, 90, 0],
    width: 0.8,
    height: 2.1,
    heightMeasured,
  });
  const suggested = { openingId: 'o1', position: [2, 0, 0], rotation: [0, 90, 0], width: 0.8, height: 2.1 };
  assert.deepEqual(foundDoorways([opening('o0', 1), opening('o1', 2), opening('o2', 3)], suggested).map((d) => d.id), ['o1', 'o0', 'o2']);
  // a height that was not measured is not used
  assert.equal(foundDoorways([opening('o0', 1, false)], null)[0].height, null);
  // no plan in the answer: the suggestion alone
  assert.deepEqual(foundDoorways(null, suggested).map((d) => [d.id, d.position[0]]), [['o1', 2]]);
  assert.deepEqual(foundDoorways(null, null), []);
});

test('place the door: the heading of a door the server describes', () => {
  near(yawFromEuler([0, 0, 0]), 0);
  near(yawFromEuler([0, 90, 0]), 90);
  near(yawFromEuler([0, 200, 0]), -160);
  // the same upright door written the other way round
  near(yawFromEuler([180, -20, 180]), -160);
  near(yawFromEuler([180, 0, 180]), 180);
  const draft = draftFromServer({ position: [1.2345, -1.3, -2], rotation: [0, 90, 0], width: 0.863, height: null });
  assert.deepEqual(draft, { position: [1.235, -1.3, -2], yaw: 90, width: 0.86, height: 2 });
});

test('place the door: two metres in front of the camera, on the floor, facing it', () => {
  // looking along -Z from 1.5 m above a floor at y = -1.5
  const door = doorInFront([0, 0, 0], [0, -0.2, -1], -1.5, SIZE);
  assert.deepEqual(door?.position, [0, -1.5, -2]);
  near(door?.yaw ?? NaN, 0); // its room side looks back at the camera
  // no floor found yet, or a table top taken for one: the floor is assumed under the phone
  assert.equal(floorUnder([0, 1, 0], null), 1 - PLACING.assumedCameraHeightM);
  assert.equal(floorUnder([0, 1, 0], 0.8), 1 - PLACING.assumedCameraHeightM);
  assert.equal(floorUnder([0, 1, 0], -0.4), -0.4);
  // the phone points straight down: there is no "in front"
  assert.equal(doorInFront([0, 0, 0], [0, -1, 0], -1.5, SIZE), null);
});

test('place the door: "Put it here" follows the aim, within reason', () => {
  // 45 degrees down from 1.5 m: the spot is 1.5 m ahead
  const spot = aimedSpot([1, 0, 1], [0, -1, -1], -1.5);
  assert.ok(spot);
  near(spot?.[0] ?? NaN, 1);
  near(spot?.[1] ?? NaN, -1.5);
  near(spot?.[2] ?? NaN, -0.5);
  const here = putHere([1, 0, 1], [0, -1, -1], -1.5, SIZE);
  assert.deepEqual(here?.position, [1, -1.5, -0.5]);
  near(here?.yaw ?? NaN, 0);
  // looking at the horizon, or at a spot across the hall: not an aim
  assert.equal(aimedSpot([0, 0, 0], [0, 0, -1], -1.5), null);
  assert.equal(aimedSpot([0, 0, 0], [0, -0.15, -1], -1.5), null); // about 10 m away
  // the door then goes two metres in front of the camera
  assert.deepEqual(putHere([0, 0, 0], [0, 0, -1], -1.5, SIZE)?.position, [0, -1.5, -2]);
});

test('home: a room without a saved door asks for one (5.4)', () => {
  const at = (doorSaved: boolean | null) => homeSituation({ connection: 'connected', rooms: ['room'], lastRoomId: null, building: false, doorSaved });
  assert.equal(at(true), 'room-ready');
  assert.equal(at(false), 'room-no-door');
  assert.equal(at(null), 'room-ready'); // not known yet
  assert.equal(homeSituation({ connection: 'connected', rooms: [], lastRoomId: null, building: false, doorSaved: false }), 'no-room');
});

test('plan: the saved door is drawn where it stands, across its width', () => {
  const room = {
    walls: [
      { id: 'w0', width: 4, corners: [[0, 0, 0], [4, 0, 0]] },
      { id: 'w1', width: 3, corners: [[4, 0, 0], [4, 0, 3]] },
    ],
    corners: [],
    openings: [],
  };
  // 50 points per metre, as in the 4 x 3 m room of the other plan tests
  const facing = planLayout(room, 232, 182, null, 16, { position: [2, 0, 1.5], yaw: 0, width: 1 });
  assert.deepEqual(facing?.door, { a: { x: 91, y: 91 }, b: { x: 141, y: 91 } });
  // turned by 90 degrees it lies along the drawing's vertical
  const turned = planLayout(room, 232, 182, null, 16, { position: [2, 0, 1.5], yaw: 90, width: 1 });
  near(turned?.door?.a.x ?? NaN, 116);
  near(Math.abs((turned?.door?.a.y ?? 0) - (turned?.door?.b.y ?? 0)), 50);
  assert.equal(planLayout(room, 232, 182)?.door, null);
});
