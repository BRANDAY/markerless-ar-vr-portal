import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type CloudDoorRecord,
  daysLeft,
  expiresAtMs,
  expiryState,
  fromShareText,
  parseRecord,
  toShareText,
} from './doorRecord';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

function record(patch: Partial<CloudDoorRecord> = {}): CloudDoorRecord {
  return {
    version: 1,
    service: 'arcore',
    cloudAnchorId: 'ua-0123456789abcdef',
    roomId: 'room-7',
    doorInAnchor: { position: [0.12345678, 0, -0.9], rotation: [0, 33.123456, 0] },
    opening: { width: 0.9, height: 2.05 },
    doorSource: 'server',
    hostedAtMs: T0,
    ttlDays: 365,
    ...patch,
  };
}

test('record: a stored record is read back unchanged', () => {
  const r = record();
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(r))), r);
});

test('record: anything essential missing or of the wrong kind gives null', () => {
  const good = JSON.parse(JSON.stringify(record())) as Record<string, unknown>;
  assert.equal(parseRecord(null), null);
  assert.equal(parseRecord('text'), null);
  assert.equal(parseRecord({ ...good, version: 2 }), null);
  assert.equal(parseRecord({ ...good, service: 'someone-else' }), null);
  assert.equal(parseRecord({ ...good, cloudAnchorId: '   ' }), null);
  assert.equal(parseRecord({ ...good, cloudAnchorId: 42 }), null);
  assert.equal(parseRecord({ ...good, doorInAnchor: { position: [0, 0], rotation: [0, 0, 0] } }), null);
  assert.equal(parseRecord({ ...good, doorInAnchor: { position: [0, 'x', 0], rotation: [0, 0, 0] } }), null);
  assert.equal(parseRecord({ ...good, hostedAtMs: 'yesterday' }), null);
  assert.equal(parseRecord({ ...good, ttlDays: 0 }), null);
  assert.equal(parseRecord({ ...good, ttlDays: 400 }), null);
});

test('record: a broken opening only loses the size; odd optional fields get defaults', () => {
  const good = JSON.parse(JSON.stringify(record())) as Record<string, unknown>;
  assert.equal(parseRecord({ ...good, opening: { width: 0.9 } })?.opening, null);
  assert.equal(parseRecord({ ...good, opening: { width: 40, height: 2 } })?.opening, null);
  assert.equal(parseRecord({ ...good, roomId: 7 })?.roomId, null);
  assert.equal(parseRecord({ ...good, doorSource: 'magic' })?.doorSource, 'by-hand');
  assert.equal(parseRecord({ ...good, extra: 'ignored', ttlDays: 30.9 })?.ttlDays, 30);
});

test('expiry: days left and the three states of a 365-day anchor', () => {
  const r = record();
  assert.equal(expiresAtMs(r), T0 + 365 * DAY);
  assert.equal(daysLeft(r, T0), 365);
  assert.equal(daysLeft(r, T0 + 364.5 * DAY), 0);
  assert.equal(expiryState(r, T0 + 100 * DAY), 'valid');
  assert.equal(expiryState(r, T0 + 334 * DAY), 'valid');
  assert.equal(expiryState(r, T0 + 336 * DAY), 'expiring');
  assert.equal(expiryState(r, T0 + 365 * DAY), 'expired');
  assert.ok(daysLeft(r, T0 + 370 * DAY) < 0);
});

test('expiry: a 1-day test anchor is not "expiring" from the first minute', () => {
  const r = record({ ttlDays: 1 });
  assert.equal(expiryState(r, T0 + 60_000), 'valid');
  assert.equal(expiryState(r, T0 + 0.9 * DAY), 'expiring');
  assert.equal(expiryState(r, T0 + 1.1 * DAY), 'expired');
});

test('share text: carries the record to another phone', () => {
  const r = record();
  const text = toShareText(r);
  assert.ok(text.startsWith('ARDOOR1:'));
  assert.ok(!text.includes('\n'));
  const back = fromShareText(`  ${text}\n`);
  assert.ok(back);
  assert.equal(back.cloudAnchorId, r.cloudAnchorId);
  assert.equal(back.roomId, r.roomId);
  assert.equal(back.ttlDays, r.ttlDays);
  assert.equal(back.hostedAtMs, r.hostedAtMs);
  assert.deepEqual(back.opening, r.opening);
  // Rounded to 0.1 mm and 0.001 degrees.
  assert.ok(Math.abs(back.doorInAnchor.position[0] - r.doorInAnchor.position[0]) < 1e-4);
  assert.ok(Math.abs(back.doorInAnchor.rotation[1] - r.doorInAnchor.rotation[1]) < 1e-3);
});

test('share text: a record without opening and room, and text that is something else', () => {
  const back = fromShareText(toShareText(record({ opening: null, roomId: null, doorSource: 'by-hand' })));
  assert.ok(back);
  assert.equal(back.opening, null);
  assert.equal(back.roomId, null);
  assert.equal(back.doorSource, 'by-hand');
  assert.equal(fromShareText('https://example.com'), null);
  assert.equal(fromShareText('ARDOOR1:{broken'), null);
  assert.equal(fromShareText('ARDOOR1:[1,2]'), null);
  assert.equal(fromShareText('ARDOOR1:{"s":"arcore"}'), null);
});
