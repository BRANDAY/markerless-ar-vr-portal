import assert from 'node:assert/strict';
import { test } from 'node:test';

import { doorFromAnchor, type RigidPose } from './anchorMath';
import type { CloudAnchorApi, HostOutcome, ResolveOutcome } from './cloudAnchorApi';
import { firstAnchorSource, hitTestAnchorSource, type LocalAnchor, nearestHit, planeAnchorSource } from './localAnchor';
import { saveDoor, type SaveDoorDeps, type SaveDoorInput, type SaveStep } from './saveDoor';

const DOOR: RigidPose = { position: [1, -1.3, -2], rotation: [0, 40, 0] };
const ANCHOR: RigidPose = { position: [1.05, -1.3, -1.9], rotation: [0, 12, 0] };

const INPUT: SaveDoorInput = {
  service: 'arcore',
  door: DOOR,
  opening: { width: 0.9, height: 2.0 },
  doorSource: 'server',
  roomId: 'room-1',
  ttlDays: 365,
};

interface Fake {
  deps: SaveDoorDeps;
  hostCalls: [string, number][];
  resolveCalls: string[];
  cancels: number;
  steps: SaveStep[];
  logs: string[];
  /** Fires the pending timers (the time limits). */
  fireTimers(): void;
}

function fake(parts: {
  local?: LocalAnchor | null;
  host?: (anchorId: string, ttlDays: number) => Promise<HostOutcome>;
  resolve?: (id: string) => Promise<ResolveOutcome>;
}): Fake {
  const timers = new Set<() => void>();
  const f: Fake = {
    hostCalls: [],
    resolveCalls: [],
    cancels: 0,
    steps: [],
    logs: [],
    fireTimers: () => [...timers].forEach((fn) => fn()),
    deps: undefined as unknown as SaveDoorDeps,
  };
  const api: CloudAnchorApi = {
    host: (anchorId, ttlDays) => {
      f.hostCalls.push([anchorId, ttlDays]);
      return (parts.host ?? (async () => ({ ok: true, cloudAnchorId: 'ua-1' })))(anchorId, ttlDays);
    },
    resolve: (id) => {
      f.resolveCalls.push(id);
      return (parts.resolve ?? (async () => ({ ok: true, pose: ANCHOR })))(id);
    },
    cancel: () => {
      f.cancels++;
    },
  };
  const local = parts.local === undefined ? { anchorId: 'local-1', pose: ANCHOR, origin: 'test' } : parts.local;
  f.deps = {
    api,
    anchors: { anchorNear: async () => local },
    now: () => 5000,
    schedule: (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    },
    log: (m) => f.logs.push(m),
    onStep: (s) => f.steps.push(s),
  };
  return f;
}

test('save: anchor, upload, check - and the record rebuilds the doorway from the anchor', async () => {
  const f = fake({});
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.deepEqual(f.steps, ['anchoring', 'uploading', 'checking']);
  assert.deepEqual(f.hostCalls, [['local-1', 365]]);
  assert.deepEqual(f.resolveCalls, ['ua-1']);
  assert.equal(result.checked, true);
  assert.equal(result.checkOffsetM, 0);
  assert.deepEqual(result.warnings, []);
  const { record } = result;
  assert.equal(record.cloudAnchorId, 'ua-1');
  assert.equal(record.ttlDays, 365);
  assert.equal(record.hostedAtMs, 5000);
  assert.equal(record.roomId, 'room-1');
  assert.deepEqual(record.opening, { width: 0.9, height: 2.0 });
  const rebuilt = doorFromAnchor(ANCHOR, record.doorInAnchor);
  assert.ok(rebuilt);
  rebuilt.position.forEach((v, i) => assert.ok(Math.abs(v - DOOR.position[i]) < 1e-9));
  assert.ok(Math.abs(rebuilt.rotation[1] - 40) < 1e-9);
});

test('save: the offset is taken from where the check found the anchor, not from the local pose', async () => {
  const found: RigidPose = { position: [1.07, -1.3, -1.9], rotation: [0, 15, 0] };
  const f = fake({ resolve: async () => ({ ok: true, pose: found }) });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.ok(Math.abs((result.checkOffsetM ?? 0) - 0.02) < 1e-9);
  const rebuilt = doorFromAnchor(found, result.record.doorInAnchor);
  assert.ok(rebuilt);
  assert.ok(Math.abs(rebuilt.position[0] - DOOR.position[0]) < 1e-9);
});

test('save: a check that lands far from the local anchor gives a warning', async () => {
  const f = fake({ resolve: async () => ({ ok: true, pose: { position: [1.5, -1.3, -1.9], rotation: [0, 12, 0] } }) });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /45 cm/);
});

test('save: no surface under the doorway stops before anything is uploaded', async () => {
  const f = fake({ local: null });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(!result.ok);
  assert.equal(result.step, 'anchoring');
  assert.equal(result.failure.reason, 'poor-view');
  assert.equal(f.hostCalls.length, 0);
});

test('save: a refused long lifetime is asked again for one day, and the result says so', async () => {
  const f = fake({
    host: async (_id, ttl) => (ttl > 1 ? { ok: false, state: 'ErrorNotAuthorized', error: 'ttl' } : { ok: true, cloudAnchorId: 'ua-short' }),
  });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.deepEqual(f.hostCalls, [['local-1', 365], ['local-1', 1]]);
  assert.equal(result.record.ttlDays, 1);
  assert.match(result.warnings[0], /1-day anchor/);
});

test('save: a build that is not authorised at all fails at upload', async () => {
  const f = fake({ host: async () => ({ ok: false, state: 'ErrorNotAuthorized', error: 'nope' }) });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(!result.ok);
  assert.equal(result.step, 'uploading');
  assert.equal(result.failure.reason, 'not-authorised');
  assert.equal(result.cloudAnchorId, null);
  assert.equal(f.hostCalls.length, 2);
});

test('save: an upload that never ends is given up at the time limit', async () => {
  const f = fake({ host: () => new Promise<HostOutcome>(() => {}) });
  const pending = saveDoor(f.deps, INPUT);
  await new Promise((r) => setImmediate(r));
  f.fireTimers();
  const result = await pending;
  assert.ok(!result.ok);
  assert.equal(result.step, 'uploading');
  assert.equal(result.failure.reason, 'network');
  assert.equal(f.cancels, 1);
});

test('save: when the check fails the local anchor pose is used, with a warning', async () => {
  const f = fake({ resolve: async () => ({ ok: false, state: 'ErrorResolvingLocalizationNoMatch', error: '' }) });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.equal(result.checked, false);
  assert.equal(result.checkOffsetM, null);
  assert.equal(result.warnings.length, 1);
});

test('save: an anchor of unknown pose that cannot be found again cannot be used', async () => {
  const f = fake({
    local: { anchorId: 'plane-3', pose: null, origin: 'plane' },
    resolve: async () => ({ ok: false, state: 'ErrorResolvingLocalizationNoMatch', error: '' }),
  });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(!result.ok);
  assert.equal(result.step, 'checking');
  assert.equal(result.cloudAnchorId, 'ua-1');
});

test('save: an anchor of unknown pose is fine once the check has found it', async () => {
  const f = fake({ local: { anchorId: 'plane-3', pose: null, origin: 'plane' } });
  const result = await saveDoor(f.deps, INPUT);
  assert.ok(result.ok);
  assert.equal(result.checkOffsetM, null);
  assert.deepEqual(f.hostCalls, [['plane-3', 365]]);
});

// ---- local anchors ----------------------------------------------------------------------------

test('hit test: the nearest hit with an id wins; far hits and hits without id are skipped', () => {
  const point: [number, number, number] = [0, -1.3, 0];
  const hits = [
    { _hitResultId: 'far', transform: { position: [0, -0.4, 0], rotation: [0, 0, 0] } },
    { transform: { position: [0, -1.3, 0], rotation: [0, 0, 0] } },
    { _hitResultId: 'floor', transform: { position: [0, -1.31, 0], rotation: [0, 5, 0] } },
    { _hitResultId: 'near', transform: { position: [0, -1.2, 0], rotation: [0, 0, 0] } },
  ];
  const best = nearestHit(hits, point);
  assert.ok(best);
  assert.equal((best.hit as { _hitResultId: string })._hitResultId, 'floor');
  assert.equal(nearestHit([hits[0], hits[1]], point), null);
  assert.equal(nearestHit('nothing', point), null);
});

test('hit test source: a ray straight down through the point, then an anchor from the hit', async () => {
  const calls: unknown[][] = [];
  const scene = {
    performARHitTestWithWorldPoints: async (from: unknown, to: unknown) => {
      calls.push([from, to]);
      return [{ _hitResultId: 'h1', transform: { position: [1, -1.5, -2], rotation: [0, 0, 0] } }];
    },
    createAnchoredNode: async (hit: { _hitResultId: string }) => ({
      nodeId: 'n',
      reactTag: 1,
      anchorId: `anchor-of-${hit._hitResultId}`,
      transform: { position: [1, -1.5, -2], rotation: [0, 7, 0], scale: [1, 1, 1] },
    }),
  };
  const anchor = await hitTestAnchorSource(() => scene).anchorNear([1, -1.5, -2]);
  assert.deepEqual(calls, [[[1, -0.5, -2], [1, -2, -2]]]);
  assert.equal(anchor?.anchorId, 'anchor-of-h1');
  assert.deepEqual(anchor?.pose, { position: [1, -1.5, -2], rotation: [0, 7, 0] });
});

test('hit test source: no scene, no hit, no anchor id, a throwing call - all give null', async () => {
  const point: [number, number, number] = [0, 0, 0];
  assert.equal(await hitTestAnchorSource(() => null).anchorNear(point), null);
  const noHit = { performARHitTestWithWorldPoints: async () => [], createAnchoredNode: async () => null };
  assert.equal(await hitTestAnchorSource(() => noHit).anchorNear(point), null);
  const hit = [{ _hitResultId: 'h', transform: { position: [0, 0, 0], rotation: [0, 0, 0] } }];
  const noId = { performARHitTestWithWorldPoints: async () => hit, createAnchoredNode: async () => ({ nodeId: 'n' }) };
  assert.equal(await hitTestAnchorSource(() => noId).anchorNear(point), null);
  const throwing = {
    performARHitTestWithWorldPoints: async () => {
      throw new Error('native');
    },
    createAnchoredNode: async () => null,
  };
  assert.equal(await hitTestAnchorSource(() => throwing).anchorNear(point), null);
});

test('plane source and fallback order', async () => {
  const planes = [
    { anchorId: 'wall', position: [4, 0, 0] as [number, number, number] },
    { anchorId: 'floor', position: [0.5, -1.3, 0] as [number, number, number] },
  ];
  const fromPlanes = planeAnchorSource(() => planes);
  const picked = await fromPlanes.anchorNear([0, -1.3, 0]);
  assert.equal(picked?.anchorId, 'floor');
  assert.equal(picked?.pose, null);
  assert.equal(await fromPlanes.anchorNear([20, 0, 0]), null);

  const both = firstAnchorSource([hitTestAnchorSource(() => null), fromPlanes]);
  assert.equal((await both.anchorNear([0, -1.3, 0]))?.anchorId, 'floor');
});
