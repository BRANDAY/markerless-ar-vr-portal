import assert from 'node:assert/strict';
import { test } from 'node:test';

import { portalInSession } from '../../door/core/placement';
import { applyToPoint, invertTransform, matrixFromRows, matrixFromYaw, quaternionFromViroEuler } from '../../door/core/roomFrame';
import type { ServerPortal } from '../../server/core/roomPlan';
import { cameraMatrix, mapInSession, type MapInSession, type Mat4, multiply } from './vpsAlignment';
import { BRIDGE, BridgeSamples, chooseWay, roomThroughBridge, serviceInSession } from './ways';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((value, i) => near(value, b[i], eps));

test('ways: the preferred one, or the other one when it cannot work', () => {
  const way = (preferred: 'server' | 'reactvision', cloudReady: boolean, server: 'connected' | 'trying' | 'unreachable') =>
    chooseWay({ preferred, cloudReady, server });
  // the venue's server is preferred and there: it is the way, whatever the cloud could do
  assert.equal(way('server', true, 'connected'), 'self-hosted');
  assert.equal(way('server', false, 'connected'), 'self-hosted');
  // still being looked for: it stays the way
  assert.equal(way('server', true, 'trying'), 'self-hosted');
  // known to be unreachable, and the room can be recognised through the cloud: the cloud
  assert.equal(way('server', true, 'unreachable'), 'reactvision-vps');
  assert.equal(way('server', false, 'unreachable'), 'self-hosted');
  // the cloud is preferred: taken when it can work for this room, else the server
  assert.equal(way('reactvision', true, 'connected'), 'reactvision-vps');
  assert.equal(way('reactvision', true, 'unreachable'), 'reactvision-vps');
  assert.equal(way('reactvision', false, 'connected'), 'self-hosted');
  assert.equal(way('reactvision', false, 'unreachable'), 'self-hosted');
});

test('ways: the room through the bridge is the room the server would report', () => {
  // The truth of one visit: where the room and where the service's map lie in the session.
  const roomInSession: Mat4 = matrixFromYaw([1, -1.4, 2], 90);
  const service: MapInSession = { yawDeg: -40, shift: [3, -1.1, -0.5] };
  // The bridge as the server stores it: room to service.
  const serviceFromRoom = multiply(invertTransform(serviceInSession(service)), roomInSession);
  nearAll(roomThroughBridge(service, serviceFromRoom), roomInSession);

  // Another visit, another session: both maps lie elsewhere, the bridge is the same.
  const later: Mat4 = matrixFromYaw([-2, 0.3, 5], -120);
  const serviceLater = multiply(later, invertTransform(serviceFromRoom));
  // What the provider measures there: the service's map as a heading and a shift.
  const camera = cameraMatrix([0.2, 1.4, 0.1], [0.3, -0.2, -0.9], [0, 1, 0]);
  assert.ok(camera);
  const reading = mapInSession(camera, multiply(invertTransform(serviceLater), camera as Mat4));
  assert.ok(reading);
  const room = roomThroughBridge(reading as MapInSession, serviceFromRoom);
  nearAll(room, later, 1e-6);

  // And the one door record stands at the same spot of the room for both ways.
  const record: ServerPortal = {
    source: 'manual',
    confirmed: true,
    openingId: null,
    position: [0.5, 0, 1.5],
    rotation: [0, 30, 0],
    quaternion: quaternionFromViroEuler([0, 30, 0]),
    frameId: 'f1',
    width: 0.9,
    height: 2,
    confidence: null,
    updatedUtc: '',
    suggested: null,
    reason: '',
  };
  nearAll(portalInSession(room, record).position ?? [], portalInSession(later, record).position ?? []);
  nearAll(portalInSession(room, record).position ?? [], applyToPoint(later, [0.5, 0, 1.5]));
  // the rows the server is sent for a sample are that matrix
  nearAll(matrixFromRows(new BridgeSamplesOf(service).rows()) ?? [], serviceInSession(service));
});

/** One sample, to read back what would be sent. */
class BridgeSamplesOf {
  private readonly samples = new BridgeSamples();
  constructor(map: MapInSession) {
    this.samples.offer(map, [0, 0, 0], 0);
  }
  rows(): number[][] {
    return this.samples.body()[0].T_arworld_from_service;
  }
}

test('ways: the samples of a bridge come from different places, a little apart in time', () => {
  const samples = new BridgeSamples();
  const map: MapInSession = { yawDeg: 10, shift: [0, 0, 0] };
  assert.equal(samples.offer(map, [0, 1.4, 0], 0), true);
  // too soon, and from the same spot
  assert.equal(samples.offer(map, [2, 1.4, 0], BRIDGE.minGapMs - 1), false);
  assert.equal(samples.offer(map, [0.1, 1.4, 0], 10_000), false);
  assert.equal(samples.count, 1);
  assert.equal(samples.enough, false);
  // back near an earlier spot later on: still not a new place
  assert.equal(samples.offer(map, [1, 1.4, 0], 20_000), true);
  assert.equal(samples.offer(map, [0, 1.4, 0.2], 30_000), false);
  for (let i = 2; i < BRIDGE.samples; i++) {
    assert.equal(samples.offer(map, [i, 1.4, 0], 20_000 + i * 2000), true);
    assert.equal(samples.enough, i + 1 >= BRIDGE.enough);
  }
  assert.equal(samples.complete, true);
  // complete: nothing more is taken
  assert.equal(samples.offer(map, [50, 1.4, 0], 900_000), false);
  assert.equal(samples.body().length, BRIDGE.samples);
  samples.reset();
  assert.equal(samples.count, 0);
});
