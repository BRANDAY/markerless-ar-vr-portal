import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LocalizationReport, LocalizationStatus, StatusMeta, TrackingState } from '../../types';
import { relativeTo, type RigidPose } from './anchorMath';
import type { CloudAnchorApi, ResolveOutcome } from './cloudAnchorApi';
import type { CloudDoorRecord } from './doorRecord';
import { type DoorUpdate, ResolveSession } from './resolveSession';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

const ANCHOR_SAVED: RigidPose = { position: [0, 0, 0], rotation: [0, 0, 0] };
const DOOR_SAVED: RigidPose = { position: [0, 0, -1], rotation: [0, 0, 0] };

function record(patch: Partial<CloudDoorRecord> = {}): CloudDoorRecord {
  return {
    version: 1,
    service: 'arcore',
    cloudAnchorId: 'ua-1',
    roomId: null,
    doorInAnchor: relativeTo(ANCHOR_SAVED, DOOR_SAVED),
    opening: { width: 0.9, height: 2 },
    doorSource: 'server',
    hostedAtMs: T0,
    ttlDays: 365,
    ...patch,
  };
}

/** A hand-driven world: clock, timers, tracking state and a service that answers on demand. */
class World {
  nowMs = T0 + DAY;
  tracking: TrackingState = 'normal';
  hasApi = true;
  statuses: { status: LocalizationStatus; detail: string; meta: StatusMeta }[] = [];
  doors: DoorUpdate[] = [];
  reports: LocalizationReport[] = [];
  logs: string[] = [];
  resolveCalls: string[] = [];
  cancels = 0;
  private pending: ((outcome: ResolveOutcome) => void)[] = [];
  private timers: { at: number; fn: () => void }[] = [];

  readonly api: CloudAnchorApi = {
    host: async () => ({ ok: false, state: 'ErrorInternal', error: 'not used' }),
    resolve: (id) => {
      this.resolveCalls.push(id);
      return new Promise<ResolveOutcome>((resolve) => this.pending.push(resolve));
    },
    cancel: () => {
      this.cancels++;
    },
  };

  readonly session = new ResolveSession({
    getApi: () => (this.hasApi ? this.api : null),
    now: () => this.nowMs,
    schedule: (fn, delayMs) => {
      const timer = { at: this.nowMs + delayMs, fn };
      this.timers.push(timer);
      return () => {
        this.timers = this.timers.filter((t) => t !== timer);
      };
    },
    log: (m) => this.logs.push(m),
    getTracking: () => this.tracking,
    onStatus: (status, detail, meta = {}) => this.statuses.push({ status, detail, meta }),
    onDoor: (update) => this.doors.push(update),
    onReport: (report) => this.reports.push(report),
  });

  get last() {
    return this.statuses[this.statuses.length - 1];
  }

  /** The service answers the oldest call that is still open. */
  async answer(outcome: ResolveOutcome): Promise<void> {
    const resolve = this.pending.shift();
    assert.ok(resolve, 'no resolve call is open');
    resolve(outcome);
    await new Promise((r) => setImmediate(r));
  }

  found(pose: RigidPose): Promise<void> {
    return this.answer({ ok: true, pose });
  }

  failed(state: string): Promise<void> {
    return this.answer({ ok: false, state, error: '' });
  }

  /** Moves the clock and runs the timers that are due, in order. */
  advance(ms: number): void {
    const until = this.nowMs + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      this.timers = this.timers.filter((t) => t !== due);
      this.nowMs = due.at;
      due.fn();
    }
    this.nowMs = until;
  }

  setTracking(state: TrackingState): void {
    this.tracking = state;
    this.session.onTracking(state);
  }
}

test('start: the anchor is found and the doorway is rebuilt in this session', async () => {
  const w = new World();
  w.session.start(record());
  assert.equal(w.last.status, 'localizing');
  assert.deepEqual(w.last.meta, { attempt: 1, attempts: 4 });
  assert.deepEqual(w.resolveCalls, ['ua-1']);

  // In this session the anchor is seen 3 m to the side, turned by 90 degrees.
  await w.found({ position: [3, -1.2, 0], rotation: [0, 90, 0] });
  assert.equal(w.doors.length, 1);
  const door = w.doors[0];
  [2, -1.2, 0].forEach((v, i) => assert.ok(Math.abs(door.pose.position[i] - v) < 1e-9));
  assert.ok(Math.abs(door.pose.rotation[1] - 90) < 1e-9);
  assert.deepEqual(door.opening, { width: 0.9, height: 2 });
  assert.equal(door.automatic, false);
  assert.equal(w.last.status, 'localized');
  assert.deepEqual(w.reports, [{ event: 'placed', reason: 'start', attempts: 1, elapsedMs: 0, trusted: true }]);
});

test('start: without a record nothing is looked for', () => {
  const w = new World();
  w.session.start(null);
  assert.equal(w.last.status, 'error');
  assert.equal(w.last.meta.code, 'no-room');
  assert.equal(w.resolveCalls.length, 0);
  w.session.relocalize();
  assert.equal(w.resolveCalls.length, 0);
});

test('start: waits for tracking NORMAL before asking the service', () => {
  const w = new World();
  w.tracking = 'limited';
  w.session.start(record());
  assert.equal(w.last.status, 'waiting-for-tracking');
  assert.equal(w.resolveCalls.length, 0);
  w.setTracking('normal');
  assert.equal(w.resolveCalls.length, 1);
  assert.equal(w.last.status, 'localizing');
});

test('start: a build without cloud anchor calls says so', () => {
  const w = new World();
  w.hasApi = false;
  w.session.start(record());
  assert.equal(w.last.status, 'error');
  assert.equal(w.last.meta.code, 'incompatible');
});

test('search: not recognised is tried again with pauses, then given up with advice', async () => {
  const w = new World();
  w.session.start(record());
  for (let attempt = 1; attempt <= 3; attempt++) {
    await w.failed('ErrorResolvingLocalizationNoMatch');
    assert.equal(w.last.status, 'localizing', `after attempt ${attempt}`);
    assert.equal(w.resolveCalls.length, attempt, 'the next attempt waits for its pause');
    w.advance(10_000);
    assert.equal(w.resolveCalls.length, attempt + 1);
  }
  await w.failed('ErrorResolvingLocalizationNoMatch');
  assert.equal(w.last.status, 'lost');
  assert.equal(w.last.meta.code, 'not-recognised');
  assert.equal(w.doors.length, 0);
  assert.deepEqual(
    w.reports.map((r) => [r.event, r.attempts, r.trusted]),
    [['not-found', 4, false]],
  );
});

test('search: an attempt that never ends is cancelled at the time limit and counted', async () => {
  const w = new World();
  w.session.start(record());
  w.advance(35_000);
  assert.equal(w.cancels, 1);
  assert.equal(w.last.status, 'localizing');
  assert.equal(w.last.meta.attempt, 2);
  w.advance(1500);
  assert.equal(w.resolveCalls.length, 2);
  // The late answer of the cancelled first attempt changes nothing.
  await w.found({ position: [9, 9, 9], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 0);
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 1);
  assert.deepEqual(w.doors[0].pose.position, [0, 0, -1]);
});

test('search: an anchor that is gone, or a build that is not authorised, is not tried again', async () => {
  const gone = new World();
  gone.session.start(record());
  await gone.failed('ErrorCloudIdNotFound');
  assert.equal(gone.last.status, 'error');
  assert.equal(gone.last.meta.code, 'no-room');
  assert.match(gone.last.detail, /Save the doorway to the cloud again/);
  gone.advance(60_000);
  assert.equal(gone.resolveCalls.length, 1);

  const refused = new World();
  refused.session.start(record());
  await refused.failed('ErrorNotAuthorized');
  assert.equal(refused.last.status, 'error');
  assert.equal(refused.last.meta.code, 'incompatible');
});

test('search: no internet ends as "server offline"', async () => {
  const w = new World();
  w.session.start(record());
  for (let attempt = 1; attempt <= 4; attempt++) {
    await w.failed('ErrorNetworkFailure');
    w.advance(10_000);
  }
  assert.equal(w.last.status, 'lost');
  assert.equal(w.last.meta.code, 'server-offline');
});

test('search: an anchor pose that would lay the door on its back is refused', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [90, 0, 0] });
  assert.equal(w.doors.length, 0);
  assert.equal(w.last.status, 'localizing');
});

test('re-localize: the same spot confirms the door, another spot moves it', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });

  w.session.relocalize();
  assert.equal(w.last.meta.attempts, 2);
  await w.found({ position: [0.05, 0, 0], rotation: [0, 1, 0] });
  assert.equal(w.doors.length, 1, 'a small disagreement does not move the door');
  assert.equal(w.reports[1].event, 'confirmed');

  w.session.relocalize();
  await w.found({ position: [0.6, 0, 0], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 2);
  assert.equal(w.doors[1].automatic, false, 'the user asked for it');
  assert.equal(w.reports[2].event, 'moved');
  assert.equal(w.reports[2].reason, 'manual');
});

test('re-localize: a failed look keeps the trusted door', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  w.session.relocalize();
  await w.failed('ErrorResolvingLocalizationNoMatch');
  w.advance(10_000);
  await w.failed('ErrorResolvingLocalizationNoMatch');
  assert.equal(w.last.status, 'localized');
  assert.equal(w.reports[1].event, 'kept');
  assert.equal(w.doors.length, 1);
});

test('tracking: a hiccup changes nothing', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  const statuses = w.statuses.length;
  w.setTracking('limited');
  w.advance(500);
  w.setTracking('normal');
  w.advance(5000);
  assert.equal(w.statuses.length, statuses);
  assert.equal(w.resolveCalls.length, 1);
});

test('tracking: after a real loss the door stays, is not trusted, and is looked for again', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });

  w.setTracking('unavailable');
  w.advance(2000);
  assert.equal(w.last.status, 'lost');
  assert.equal(w.last.meta.code, 'tracking-lost');
  assert.equal(w.doors.length, 1, 'the door is not removed');

  w.advance(3000);
  w.setTracking('normal');
  assert.equal(w.resolveCalls.length, 2);
  assert.equal(w.last.status, 'localizing');
  // The AR world shifted while tracking was away: the door is moved, on the provider's own account.
  await w.found({ position: [0.4, 0, 0], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 2);
  assert.equal(w.doors[1].automatic, true);
  assert.deepEqual(w.reports[1], { event: 'moved', reason: 'recovery', attempts: 1, elapsedMs: 0, trusted: true });
  assert.equal(w.last.status, 'localized');
});

test('tracking: a door that cannot be confirmed after a loss is reported as unconfirmed', async () => {
  const w = new World();
  w.session.start(record());
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  w.setTracking('unavailable');
  w.advance(4000);
  w.setTracking('normal');
  for (let attempt = 1; attempt <= 4; attempt++) {
    await w.failed('ErrorResolvingLocalizationNoMatch');
    w.advance(10_000);
  }
  assert.equal(w.last.status, 'lost');
  assert.equal(w.last.meta.code, 'unconfirmed');
  assert.deepEqual([w.reports[1].event, w.reports[1].trusted], ['kept', false]);
});

test('tracking: a loss during the first search starts the search again', async () => {
  const w = new World();
  w.session.start(record());
  w.setTracking('unavailable');
  w.advance(2000);
  assert.equal(w.last.status, 'waiting-for-tracking');
  assert.equal(w.cancels, 1);
  w.setTracking('normal');
  assert.equal(w.resolveCalls.length, 2);
  // The answer of the interrupted attempt is ignored, the new one counts.
  await w.found({ position: [5, 5, 5], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 0);
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  assert.equal(w.doors.length, 1);
  assert.equal(w.reports[0].reason, 'start');
});

test('expiry: the status says when the anchor is about to expire; an expired record is still tried', async () => {
  const soon = new World();
  soon.nowMs = T0 + 350 * DAY;
  soon.session.start(record());
  assert.ok(soon.logs.some((l) => l.includes('expires in 15 day')));
  await soon.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  assert.match(soon.last.detail, /expires in 15 day/);

  const late = new World();
  late.nowMs = T0 + 400 * DAY;
  late.session.start(record());
  assert.equal(late.resolveCalls.length, 1, 'the service decides, not the phone clock');
  await late.failed('ErrorCloudIdNotFound');
  assert.equal(late.last.meta.code, 'no-room');
});

test('stop: nothing happens after stop, and the service call is cancelled', async () => {
  const w = new World();
  w.session.start(record());
  w.session.stop();
  assert.equal(w.cancels, 1);
  const statuses = w.statuses.length;
  await w.found({ position: [0, 0, 0], rotation: [0, 0, 0] });
  w.advance(120_000);
  w.setTracking('limited');
  assert.equal(w.doors.length, 0);
  assert.equal(w.statuses.length, statuses);
});
