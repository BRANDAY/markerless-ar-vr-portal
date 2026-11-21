import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rotateByViroEuler } from '../../localization/math';
import type { Mat4 } from '../../localization/core/vpsAlignment';
import { multiply } from '../../localization/core/vpsAlignment';
import { parseLocalize, parsePortal, type ServerPortal, type ServerRoom } from '../../server/core/roomPlan';
import { doorCandidate, doorRecordBody, portalInSession, roomInSession, settle } from './placement';
import {
  applyToPoint,
  asTransform,
  IDENTITY,
  invertTransform,
  matrixFromPose,
  matrixFromRows,
  matrixFromYaw,
  poseInRoom,
  poseInSession,
  quaternionFromViroEuler,
  quaternionOf,
  rowsFromMatrix,
  scaleOf,
  viroEulerOf,
} from './roomFrame';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((value, i) => near(value, b[i], eps));
/**
 * Two sets of Euler angles are the same turn. The angles themselves are not compared: a
 * heading of 110 degrees is written [180, 70, 180], by the server as well.
 */
const sameTurn = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  nearAll(matrixFromPose([0, 0, 0], quaternionFromViroEuler(a)), matrixFromPose([0, 0, 0], quaternionFromViroEuler(b)), eps);

/** The room turned by 90 degrees about the vertical and shifted: room +Z lands on session +X. */
const ROOM: Mat4 = matrixFromYaw([1, -1.4, 2], 90);

/** A door record as `GET /maps/{id}/portal` gives it: frame of the room. */
function record(over: Partial<ServerPortal> = {}): ServerPortal {
  return {
    source: 'manual',
    confirmed: true,
    openingId: null,
    position: [0, 0.1, 1],
    rotation: [0, 20, 0],
    quaternion: quaternionFromViroEuler([0, 20, 0]),
    frameId: 'f1',
    width: 0.85,
    height: 2.05,
    confidence: null,
    updatedUtc: '2026-11-21T09:40:00Z',
    suggested: null,
    reason: '',
    ...over,
  };
}

test('room frame: a matrix as the server writes it', () => {
  const rows = [
    [0, 0, 1, 1],
    [0, 1, 0, -1.4],
    [-1, 0, 0, 2],
    [0, 0, 0, 1],
  ];
  const m = matrixFromRows(rows);
  assert.ok(m);
  nearAll(m ?? [], ROOM);
  assert.deepEqual(rowsFromMatrix(m ?? []).map((row) => row.map((n) => Math.round(n * 1e6) / 1e6 + 0)), rows);
  // not a matrix, not a turn, a shear, a projective row
  assert.equal(matrixFromRows(null), null);
  assert.equal(matrixFromRows([[1, 0, 0, 0]]), null);
  assert.equal(matrixFromRows([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 'x', 0], [0, 0, 0, 1]]), null);
  assert.equal(matrixFromRows([[1, 0.5, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]), null);
  assert.equal(matrixFromRows([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 1]]), null);
  assert.equal(matrixFromRows([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]), null);
  // a map without metric scale: a turn with a scale is a room transform too
  const scaled = matrixFromRows([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]);
  assert.ok(scaled);
  near(scaleOf(scaled ?? []), 2);
  assert.ok(asTransform([...ROOM]));
  assert.equal(asTransform([1, 2, 3]), null);
  assert.equal(asTransform('x'), null);
});

test('room frame: inverse, quaternion and the Euler angles a node takes', () => {
  const pose = matrixFromPose([0.3, 1, -2], quaternionFromViroEuler([10, -70, 25]));
  nearAll(multiply(pose, invertTransform(pose)), IDENTITY);
  // with a scale in it
  const scaled = multiply(pose, [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1]);
  nearAll(multiply(invertTransform(scaled), scaled), IDENTITY);
  near(scaleOf(scaled), 3);
  // the angles go in and come out, also through the quaternion, also with a scale
  for (const euler of [[0, 0, 0], [0, 90, 0], [10, -70, 25], [-5, 179, 3], [0, -135, 0]]) {
    const m = matrixFromPose([0, 0, 0], quaternionFromViroEuler(euler));
    sameTurn(viroEulerOf(m), euler);
    nearAll(matrixFromPose([0, 0, 0], quaternionOf(m)), m);
    // the same turn as the app's own "rotate by ViroReact Euler angles"
    nearAll(applyToPoint(m, [0.2, 0.5, -1]), rotateByViroEuler([0.2, 0.5, -1], euler as [number, number, number]));
  }
  nearAll(viroEulerOf(multiply(matrixFromPose([0, 0, 0], quaternionFromViroEuler([10, -70, 25])), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])), [10, -70, 25]);
  // as the server writes them: the middle angle stays within 90 degrees, so a heading of 110 is [180, 70, 180]
  nearAll(viroEulerOf(matrixFromYaw([0, 0, 0], 110)).map(Math.abs), [180, 70, 180]);
  // a heading is where +Z points on the floor plan
  nearAll(applyToPoint(matrixFromYaw([0, 0, 0], 90), [0, 0, 1]), [1, 0, 0]);
  nearAll(viroEulerOf(matrixFromYaw([0, 0, 0], -35)), [0, -35, 0]);
});

test('door: the room in the session times the door in the room', () => {
  // a door 1 m along the room's +Z stands 1 m along the session's +X from where the room's origin is
  const door = poseInSession(ROOM, [0, 0.1, 1], quaternionFromViroEuler([0, 20, 0]));
  nearAll(door.position, [2, -1.3, 2]);
  sameTurn(door.rotation, [0, 110, 0]);
  // the room's frame is the session's frame (the room was scanned in this session)
  const same = poseInSession(IDENTITY, [0.4, -1.3, -0.6], quaternionFromViroEuler([0, 35, 0]));
  nearAll(same.position, [0.4, -1.3, -0.6]);
  nearAll(same.rotation, [0, 35, 0]);
  // what staff save is what a visitor gets back - through another room transform too
  const placed = { position: [-0.7, -1.38, 3.2], yaw: -165 };
  const inRoom = poseInRoom(ROOM, placed.position, placed.yaw);
  const back = poseInSession(ROOM, inRoom.position, inRoom.quaternion);
  nearAll(back.position, placed.position);
  sameTurn(back.rotation, [0, placed.yaw, 0]);
  const elsewhere = matrixFromYaw([-4, 0.2, 7], -30);
  const visitor = poseInSession(elsewhere, inRoom.position, inRoom.quaternion);
  // the same spot of the room, seen from the other session
  nearAll(applyToPoint(invertTransform(elsewhere), visitor.position), applyToPoint(invertTransform(ROOM), placed.position));
});

test('door: the record in the session, with the doorway the server suggests', () => {
  const suggested = { openingId: 'o1', position: [2, 0, 0] as [number, number, number], rotation: [0, -90, 0] as [number, number, number], quaternion: null, width: 0.9, height: 2, confidence: 0.7 };
  const here = portalInSession(ROOM, record({ suggested }));
  nearAll(here.position ?? [], [2, -1.3, 2]);
  sameTurn(here.rotation ?? [], [0, 110, 0]);
  assert.equal(here.width, 0.85);
  assert.equal(here.source, 'manual');
  assert.equal(here.frameId, 'f1');
  // the suggestion came without a quaternion: its Euler angles do
  nearAll(here.suggested?.position ?? [], [1, -1.4, 0]);
  nearAll(here.suggested?.rotation ?? [], [0, 0, 0]);
  // a room without a door keeps its suggestion
  const none = portalInSession(ROOM, record({ source: 'none', confirmed: false, position: null, rotation: null, quaternion: null, suggested }));
  assert.equal(none.position, null);
  nearAll(none.suggested?.position ?? [], [1, -1.4, 0]);
  // lengths follow the scale of a map that is not metric
  const twice = multiply(ROOM, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  const big = portalInSession(twice, record());
  near(big.width ?? 0, 1.7);
  nearAll(big.position ?? [], [3, -1.2, 2]);
  sameTurn(big.rotation ?? [], [0, 110, 0]);
});

test('door: only a door that staff saved is one; the rules decide what happens to it', () => {
  assert.equal(doorCandidate(portalInSession(ROOM, record({ source: 'auto', confirmed: false })), true), null);
  assert.equal(doorCandidate(null, true), null);
  const first = settle(null, false, ROOM, record(), true);
  assert.equal(first.decision.action, 'place');
  const shown = first.decision.action === 'place' ? first.decision.door : null;
  assert.ok(shown);
  // the room is recognised again 5 cm off: the door stays (noise), and is believed
  const nudged = matrixFromYaw([1.05, -1.4, 2], 90);
  assert.equal(settle(shown, true, nudged, record(), true).decision.action, 'keep');
  // 40 cm off with a good answer: the door moves; with a weak one against a believed door: ignored
  const moved = matrixFromYaw([1.4, -1.4, 2], 90);
  assert.equal(settle(shown, true, moved, record(), true).decision.action, 'move');
  assert.equal(settle(shown, true, moved, record(), false).decision.action, 'ignore');
  assert.equal(settle(shown, false, moved, record(), false).decision.action, 'move');
  // a room without a saved door: nothing is placed, whatever the server suggests
  assert.equal(settle(null, false, ROOM, record({ source: 'auto', confirmed: false }), true).decision.action, 'no-doorway');
  assert.equal(settle(shown, true, ROOM, record({ source: 'none', confirmed: false, position: null, rotation: null }), true).decision.action, 'no-doorway');
  // scanned in this very session: the door goes where the record says, whatever stands
  assert.equal(settle(shown, true, moved, record(), true, true).decision.action, 'place');
  assert.equal(settle(shown, true, moved, record({ source: 'none', position: null, rotation: null }), true, true).decision.action, 'no-doorway');
});

test('door: what is sent to the server is the door in the room\'s frame', () => {
  const draft = { position: [2, -1.3, 2] as [number, number, number], yaw: 110, width: 0.85, height: 2.05 };
  const body = doorRecordBody(ROOM, draft, true);
  nearAll(body.position, [0, 0.1, 1], 1e-4);
  nearAll(body.quaternion_xyzw, quaternionFromViroEuler([0, 20, 0]), 1e-6);
  assert.equal(body.width, 0.85);
  assert.equal(body.height, 2.05);
  // a server that does not store sizes is not sent one
  assert.deepEqual(Object.keys(doorRecordBody(ROOM, draft, false)), ['position', 'quaternion_xyzw']);
  // and it reads back as the record the visitor's sum starts from
  const stored = parsePortal({ source: 'manual', confirmed: true, position: body.position, rotation_euler_deg: [0, 20, 0], quaternion_xyzw: body.quaternion_xyzw, width: 0.85, height: 2.05, frame_id: 'f1' });
  assert.ok(stored);
  const back = portalInSession(ROOM, stored as ServerPortal);
  nearAll(back.position ?? [], draft.position, 1e-3);
  sameTurn(back.rotation ?? [], [0, draft.yaw, 0], 1e-3);
});

test('door: the answer of /localize says where the room is', () => {
  const answer = parseLocalize({
    success: true,
    quality: 'good',
    num_inliers: 700,
    frame_id: '2026-11-21T09:31:07Z',
    alignment: {
      status: 'ok',
      T_arworld_from_map: [[0, 0, 1, 1], [0, 1, 0, -1.4], [-1, 0, 0, 2], [0, 0, 0, 1]],
      portal: { source: 'manual', confirmed: true, position: [2, -1.3, 2], rotation_euler_deg: [0, 110, 0], quaternion_xyzw: [0, 0.819152, 0, 0.573576] },
    },
  });
  assert.ok(answer?.transform);
  nearAll(answer?.transform ?? [], ROOM);
  assert.equal(answer?.frameId, '2026-11-21T09:31:07Z');
  // the app's own sum lands where the server's does
  const mine = portalInSession(answer?.transform ?? [], record());
  nearAll(mine.position ?? [], answer?.portal?.position ?? [], 1e-6);
  sameTurn(mine.rotation ?? [], answer?.portal?.rotation ?? [], 1e-4);
  // no complete alignment: no room transform
  assert.equal(parseLocalize({ success: true, alignment: { status: 'scale_unknown', T_arworld_from_map: [[1]] } })?.transform, null);
  assert.equal(parseLocalize({ success: false })?.transform, null);
});

test('door: the room plan in the session', () => {
  const plan: ServerRoom = {
    status: 'ok',
    reason: '',
    frame: 'map',
    floorLevel: 0,
    floorOutline: [[0, 0, 0], [0, 0, 3], [2, 0, 3]],
    ceilingLevel: 2.5,
    walls: [{ id: 'w0', position: [0, 1.25, 1], rotation: [0, 90, 0], width: 3, height: 2.5, corners: [[0, 0, 0], [0, 0, 3]], confidence: 0.9 }],
    corners: [{ id: 'c0', bottom: [0, 0, 0], top: [0, 2.5, 0] }],
    openings: [
      {
        id: 'o0', position: [0, 1, 1], rotation: [0, 90, 0], width: 0.9, height: 2, corners: [], confidence: 0.8,
        state: 'open', heightMeasured: true, portalPosition: [0, 0, 1], portalRotation: [0, 90, 0],
      },
    ],
    bestOpeningId: 'o0',
  };
  const here = roomInSession(ROOM, plan);
  assert.equal(here.frame, 'arworld');
  near(here.floorLevel ?? NaN, -1.4);
  near(here.ceilingLevel ?? NaN, 1.1);
  nearAll(here.floorOutline?.[1] ?? [], [4, -1.4, 2]);
  nearAll(here.walls[0].position, [2, -0.15, 2]);
  sameTurn(here.walls[0].rotation, [0, 180, 0]);
  nearAll(here.corners[0].top, [1, 1.1, 2]);
  nearAll(here.openings[0].portalPosition, [2, -1.4, 2]);
  sameTurn(here.openings[0].portalRotation, [0, 180, 0]);
  assert.equal(here.walls[0].width, 3);
});
