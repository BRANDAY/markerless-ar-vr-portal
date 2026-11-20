import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getJob, postDeviceLog, probeHealth, setClientIdentity } from './client';
import {
  BATCH_SIZE,
  buildLogBody,
  classifyLogLine,
  type ClientIdentity,
  DeviceLogQueue,
  FLUSH_INTERVAL_MS,
  identityHeaders,
  KEEPALIVE_INTERVAL_MS,
  MAX_EVENTS_PER_REQUEST,
  MAX_QUEUED_EVENTS,
  newDeviceId,
  parseLogReceipt,
  sanitizeId,
  type ScenarioFacts,
  scenarioStep,
} from './deviceLog';

const IDENTITY: ClientIdentity = {
  deviceId: 'arportal-abc123',
  deviceName: 'Xiaomi 14 Ultra',
  sessionId: 'run-1',
  appVersion: '0.1.0',
};

test('identity headers: ids are cleaned, names are ASCII, empty values are left out', () => {
  assert.deepEqual(identityHeaders(null), {});
  assert.deepEqual(identityHeaders(IDENTITY), {
    'X-Device-Id': 'arportal-abc123',
    'X-Session-Id': 'run-1',
    'X-Device-Name': 'Xiaomi 14 Ultra',
    'X-App-Version': '0.1.0',
  });
  const odd = identityHeaders({ deviceId: 'my phone/1', deviceName: 'Телефон 100%', sessionId: '', appVersion: '' });
  assert.equal(odd['X-Device-Id'], 'my-phone-1');
  assert.equal(odd['X-Session-Id'], 'unknown');
  assert.match(odd['X-Device-Name'], /^[\x20-\x7e]+$/);
  assert.ok(odd['X-Device-Name'].startsWith('%D0%A2'));
  assert.ok(odd['X-Device-Name'].length <= 64);
  assert.ok(!('X-App-Version' in odd));
  assert.equal(sanitizeId('a'.repeat(100)).length, 64);
});

test('a new device id fits the rule for ids', () => {
  const id = newDeviceId();
  assert.match(id, /^arportal-[a-z0-9]{10}$/);
  assert.equal(sanitizeId(id), id);
  assert.notEqual(newDeviceId(), newDeviceId());
});

test('log lines are sorted into the categories of the contract', () => {
  assert.deepEqual(classifyLogLine('tracking: NORMAL'), { type: 'tracking', level: 'info' });
  assert.deepEqual(classifyLogLine('tracking: LIMITED (excessive motion)'), { type: 'tracking', level: 'warn' });
  assert.deepEqual(classifyLogLine('server: connected · PC · 12 ms'), { type: 'connect', level: 'info' });
  assert.deepEqual(classifyLogLine('server search: scanning 192.0.2.x'), { type: 'connect', level: 'info' });
  assert.deepEqual(classifyLogLine('portal ENTER -> VR'), { type: 'portal', level: 'info' });
  assert.deepEqual(classifyLogLine('environment ERROR: {}'), { type: 'portal', level: 'error' });
  assert.deepEqual(classifyLogLine('server: localize: good, 120 inliers'), { type: 'localize', level: 'info' });
  assert.deepEqual(classifyLogLine('something failed badly'), { type: 'error', level: 'error' });
  assert.deepEqual(classifyLogLine('hello'), { type: 'app', level: 'info' });
});

test('queue: numbering, batches, acknowledgement and the size limit', () => {
  const queue = new DeviceLogQueue();
  for (let i = 0; i < 250; i++) {
    queue.add(`line ${i}`, 1000 + i);
  }
  const batch = queue.nextBatch();
  assert.equal(batch.length, MAX_EVENTS_PER_REQUEST);
  assert.equal(batch[0].seq, 1);
  assert.equal(batch[0].t_ms, 1000);
  assert.equal(queue.nextBatch()[0].seq, 1, 'events stay until the server has them');
  queue.acknowledge(200);
  assert.equal(queue.size, 50);
  assert.equal(queue.nextBatch()[0].seq, 201);
  queue.acknowledge(0);
  assert.equal(queue.size, 50, 'an old acknowledgement changes nothing');

  for (let i = 0; i < 600; i++) {
    queue.add('x', 0);
  }
  assert.equal(queue.size, MAX_QUEUED_EVENTS);
  assert.equal(queue.droppedCount, 150);
  assert.equal(queue.nextBatch()[0].seq, 351, 'the oldest are dropped');

  const long = new DeviceLogQueue().add(`a\n b ${'z'.repeat(600)}`, 0);
  assert.equal(long.message.length, 500);
  assert.ok(long.message.startsWith('a b '));
});

test('queue: when a request is due', () => {
  const queue = new DeviceLogQueue();
  assert.equal(queue.isDue(1000, 0), false, 'nothing to send, keep-alive not due');
  assert.equal(queue.isDue(KEEPALIVE_INTERVAL_MS, 0), true, 'keep-alive with an empty batch');
  queue.add('one', 0);
  assert.equal(queue.isDue(FLUSH_INTERVAL_MS - 1, 0), false);
  assert.equal(queue.isDue(FLUSH_INTERVAL_MS, 0), true);
  for (let i = 1; i < BATCH_SIZE; i++) {
    queue.add('more', 0);
  }
  assert.equal(queue.isDue(1, 0), true, 'a full batch goes at once');

  const urgent = new DeviceLogQueue();
  urgent.add('upload failed: timeout', 0);
  assert.equal(urgent.isDue(1, 0), true, 'errors go at once');
  urgent.deferUrgent();
  assert.equal(urgent.isDue(1, 0), false, 'after a failed request they wait for the regular beat');
  assert.equal(urgent.isDue(FLUSH_INTERVAL_MS, 0), true);
});

const FACTS: ScenarioFacts = {
  serverConnected: true,
  recording: false,
  uploadPhase: 'idle',
  uploadText: '',
  inside: false,
  doorPlaced: false,
  providerId: 'manual',
  providerStatus: 'idle',
  providerDetail: '',
  mapAvailable: false,
};

test('scenario step follows the state of the app', () => {
  const step = (patch: Partial<ScenarioFacts>) => scenarioStep({ ...FACTS, ...patch }).step;
  assert.equal(step({ serverConnected: false }), 'connecting');
  assert.equal(step({}), 'connected');
  assert.equal(step({ mapAvailable: true }), 'ready');
  assert.equal(step({ recording: true, doorPlaced: true }), 'scanning');
  assert.equal(step({ uploadPhase: 'uploading' }), 'uploading');
  assert.equal(step({ uploadPhase: 'building' }), 'building');
  assert.equal(step({ providerStatus: 'localizing', mapAvailable: true }), 'localizing');
  assert.equal(step({ doorPlaced: true, mapAvailable: true }), 'portal_placed');
  assert.equal(step({ doorPlaced: true, inside: true }), 'inside');
  assert.equal(step({ uploadPhase: 'failed', uploadText: 'too few frames' }), 'error');
  assert.equal(step({ providerStatus: 'error', providerDetail: 'no door opening' }), 'error');
  assert.equal(scenarioStep({ ...FACTS, uploadPhase: 'failed', uploadText: 'too few frames' }).detail, 'too few frames');
});

test('log body has the fields of the contract', () => {
  const queue = new DeviceLogQueue();
  queue.add('tracking: NORMAL', 1763661998400);
  const body = buildLogBody(
    IDENTITY,
    queue.nextBatch(),
    { step: 'connected', tracking: 'NORMAL', map_id: 'room', detail: 'd'.repeat(300) },
    1763662000123.4,
    14.2,
  );
  assert.equal(body.session_id, 'run-1');
  assert.equal(body.sent_at_ms, 1763662000123);
  assert.equal(body.rtt_ms, 14);
  assert.equal((body.state as { detail: string }).detail.length, 200);
  assert.deepEqual(body.events, [
    { seq: 1, t_ms: 1763661998400, level: 'info', type: 'tracking', message: 'tracking: NORMAL' },
  ]);
  assert.ok(!('rtt_ms' in buildLogBody(IDENTITY, [], { step: 'connected', tracking: '', map_id: '', detail: '' }, 0, null)));
});

test('log receipt', () => {
  assert.deepEqual(parseLogReceipt({ accepted: 3, duplicates: 1, last_seq: 43, server_time_ms: 1 }), {
    accepted: 3,
    duplicates: 1,
    lastSeq: 43,
  });
  assert.equal(parseLogReceipt({ accepted: 3 }), null);
  assert.equal(parseLogReceipt(null), null);
});

test('client: every request carries the identity; the log is posted as JSON', async () => {
  const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });
    const answer = url.endsWith('/log')
      ? { accepted: 1, duplicates: 0, last_seq: 7, server_time_ms: 5 }
      : { detail: 'not found' };
    return new Response(JSON.stringify(answer), { status: url.endsWith('/log') ? 200 : 404 });
  }) as unknown as typeof fetch;

  setClientIdentity(IDENTITY);
  try {
    await probeHealth('http://192.0.2.1:8077', { timeoutMs: 500, fetchImpl });
    await getJob('http://192.0.2.1:8077', 'j1', { fetchImpl });
    const receipt = await postDeviceLog('http://192.0.2.1:8077', 'arportal abc', { events: [] }, { fetchImpl });
    assert.deepEqual(receipt, { ok: true, value: { accepted: 1, duplicates: 0, lastSeq: 7 } });
    assert.equal(seen.length, 3);
    for (const request of seen) {
      assert.equal(request.headers['X-Device-Id'], 'arportal-abc123');
      assert.equal(request.headers['X-Session-Id'], 'run-1');
      assert.equal(request.headers['X-Device-Name'], 'Xiaomi 14 Ultra');
      assert.equal(request.headers['X-App-Version'], '0.1.0');
    }
    assert.equal(seen[2].url, 'http://192.0.2.1:8077/devices/arportal%20abc/log');
    assert.equal(seen[2].method, 'POST');
    assert.equal(seen[2].headers['Content-Type'], 'application/json');
    assert.equal(seen[2].body, '{"events":[]}');
  } finally {
    setClientIdentity(null);
  }
  seen.length = 0;
  await getJob('http://192.0.2.1:8077', 'j1', { fetchImpl });
  assert.ok(!('X-Device-Id' in seen[0].headers));
});
