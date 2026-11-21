// Unit tests of the room-scan part of the server contract (api-v2). Run with `npm test`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { getJob, getPortal, getRoom, localize, uploadRecording } from './client';
import { validateHealth } from './health';
import {
  describeJob,
  describeJobError,
  isFinalJobState,
  parseJob,
  parseMaps,
  parseLocalize,
  parsePortal,
  parseRoom,
} from './roomPlan';

const JOB = {
  job_id: 'b3f9c2a17d04',
  kind: 'build_map',
  map_id: 'room',
  state: 'running',
  stage: 'matching',
  stage_index: 3,
  stage_count: 7,
  stage_progress: 0.41,
  progress: 0.24,
  message: 'matched 410 of 1000 image pairs',
  queue_position: 0,
  eta_s: 380,
  error: null,
  result: null,
};

const POSE = { position: [1, 0, -2], rotation_euler_deg: [0, 90, 0], quaternion_xyzw: [0, 0.7071, 0, 0.7071] };
const WALL = {
  id: 'w0',
  center: [1, 0, -2],
  width: 3.84,
  height: 2.63,
  normal: [1, 0, 0],
  corners: [[1, -1.3, -3.9], [1, -1.3, -0.1], [1, 1.3, -0.1], [1, 1.3, -3.9]],
  pose: POSE,
  confidence: 0.88,
  coverage: 0.64,
};
const OPENING = {
  id: 'o0',
  kind: 'door',
  wall_id: 'w0',
  state: 'open',
  center: [1, -0.3, -2],
  center_bottom: [1, -1.3, -2],
  width: 0.86,
  height: 2.02,
  normal: [1, 0, 0],
  corners: [],
  pose: { ...POSE, position: [1, -0.3, -2] },
  portal_pose: { ...POSE, position: [1, -1.3, -2] },
  confidence: 0.78,
};
const ROOM = {
  version: 1,
  status: 'ok',
  reason: null,
  frame: 'map',
  floor: { level: -1.3, outline: [[0, -1.3, 0], [1, -1.3, 0], [1, -1.3, -4], [0, -1.3, -4]] },
  ceiling: { level: 1.3 },
  walls: [WALL, { id: 'broken', width: 2 }],
  corners: [{ id: 'c0', walls: ['w0', 'w1'], bottom: [1, -1.3, -4], top: [1, 1.3, -4] }, { id: 'bad' }],
  openings: [OPENING],
  best_opening_id: 'o0',
};
const PORTAL = {
  map_id: 'room',
  frame: 'map',
  source: 'auto',
  opening_id: 'o0',
  position: [1, -1.3, -2],
  rotation_euler_deg: [0, 90, 0],
  width: 0.86,
  height: 2.02,
  confidence: 0.78,
  reason: null,
};

describe('health: v2 capabilities', () => {
  const base = { service: 'arportal-localization-server', api_version: 1, status: 'ok' };
  test('absent on a v1 server, read on a v2 server', () => {
    const v1 = validateHealth(base);
    assert.equal(v1.kind, 'ok');
    assert.deepEqual(v1.kind === 'ok' ? v1.info.capabilities : null, []);
    const v2 = validateHealth({ ...base, api_revision: 2, capabilities: ['recording_upload', 7, 'jobs'] });
    assert.deepEqual(v2.kind === 'ok' ? v2.info.capabilities : null, ['recording_upload', 'jobs']);
  });
});

describe('parseJob / describeJob', () => {
  test('a running job, also inside the upload envelope', () => {
    const job = parseJob({ job: JOB });
    assert.equal(job?.jobId, 'b3f9c2a17d04');
    assert.equal(job?.state, 'running');
    assert.equal(job && isFinalJobState(job.state), false);
    assert.equal(job && describeJob(job), '24 %, step 3/7 matching, about 6 min left');
    assert.equal(parseJob(JOB)?.stage, 'matching');
  });
  test('queued, succeeded, failed, cancelled', () => {
    const queued = parseJob({ ...JOB, state: 'queued', stage: null, queue_position: 2, eta_s: null });
    assert.equal(queued && describeJob(queued), 'waiting, 2 build(s) ahead');
    const done = parseJob({
      ...JOB,
      state: 'succeeded',
      progress: 1,
      result: { room: { status: 'ok', num_walls: 4, num_corners: 4, num_openings: 1 }, portal: { source: 'auto' }, warnings: ['mesh ignored', 3] },
    });
    assert.equal(done && isFinalJobState(done.state), true);
    assert.equal(done && describeJob(done), 'done: 4 walls, 4 corners, 1 door opening(s)');
    assert.deepEqual(done?.result?.warnings, ['mesh ignored']);
    assert.equal(done?.result?.portalSource, 'auto');
    const failed = parseJob({ ...JOB, state: 'failed', error: { code: 'sfm_failed', message: 'x' } });
    assert.match(failed ? describeJob(failed) : '', /could not be reconstructed/);
    assert.match(describeJobError('whatever', 'disk full'), /disk full/);
    const cancelled = parseJob({ ...JOB, state: 'cancelled' });
    assert.equal(cancelled && describeJob(cancelled), 'cancelled');
  });
  test('rejects what is not a job; clamps progress', () => {
    assert.equal(parseJob(null), null);
    assert.equal(parseJob({ job_id: 'x', state: 'exploded' }), null);
    assert.equal(parseJob({ ...JOB, progress: 7 })?.progress, 1);
  });
});

describe('parseRoom', () => {
  test('keeps well-formed walls, corners and openings', () => {
    const room = parseRoom({ map_id: 'room', room: ROOM });
    assert.equal(room?.status, 'ok');
    assert.equal(room?.walls.length, 1);
    assert.deepEqual(room?.walls[0].rotation, [0, 90, 0]);
    assert.equal(room?.walls[0].corners.length, 4);
    assert.equal(room?.corners.length, 1);
    assert.equal(room?.openings.length, 1);
    assert.deepEqual(room?.openings[0].portalPosition, [1, -1.3, -2]);
    assert.equal(room?.openings[0].heightMeasured, true);
    assert.equal(room?.floorLevel, -1.3);
    assert.equal(room?.floorOutline?.length, 4);
    assert.equal(room?.bestOpeningId, 'o0');
  });
  test('a room without a plan, and "door not found"', () => {
    const none = parseRoom({ status: 'unavailable', reason: 'not computed', walls: [], openings: [] });
    assert.equal(none?.status, 'unavailable');
    assert.equal(none?.reason, 'not computed');
    assert.equal(none?.floorOutline, null);
    const noDoor = parseRoom({ ...ROOM, openings: [], best_opening_id: null });
    assert.equal(noDoor?.status, 'ok');
    assert.equal(noDoor?.openings.length, 0);
    assert.equal(noDoor?.bestOpeningId, null);
    assert.equal(parseRoom('nonsense'), null);
  });
});

describe('parsePortal', () => {
  test('an automatic doorway with its size', () => {
    const portal = parsePortal(PORTAL);
    assert.equal(portal?.source, 'auto');
    assert.deepEqual(portal?.position, [1, -1.3, -2]);
    assert.equal(portal?.width, 0.86);
  });
  test('"none", and anything without a pose, is no doorway', () => {
    const none = parsePortal({ source: 'none', position: null, rotation_euler_deg: null, reason: 'no door opening was found in this room' });
    assert.equal(none?.source, 'none');
    assert.equal(none?.position, null);
    assert.match(none?.reason ?? '', /no door opening/);
    assert.equal(parsePortal({ ...PORTAL, position: [1, 2] })?.source, 'none');
    assert.equal(parsePortal({ ...PORTAL, source: 'invented' })?.source, 'none');
    assert.equal(parsePortal({}), null);
  });
  test('a manual pose has no size', () => {
    const manual = parsePortal({ ...PORTAL, source: 'manual', width: null, height: null, confidence: null });
    assert.equal(manual?.source, 'manual');
    assert.equal(manual?.width, null);
  });
});

describe('parseLocalize', () => {
  test('plan and doorway only with a complete alignment', () => {
    const ok = parseLocalize({
      success: true,
      quality: 'good',
      num_inliers: 388,
      alignment: { status: 'ok', portal: { ...PORTAL, frame: 'arworld' }, room: { ...ROOM, frame: 'arworld' } },
    });
    assert.equal(ok?.alignmentStatus, 'ok');
    assert.equal(ok?.portal?.source, 'auto');
    assert.equal(ok?.room?.frame, 'arworld');
    const scaleUnknown = parseLocalize({ success: true, quality: 'good', alignment: { status: 'scale_unknown', portal: PORTAL } });
    assert.equal(scaleUnknown?.alignmentStatus, 'scale_unknown');
    assert.equal(scaleUnknown?.portal, null);
    const failed = parseLocalize({ success: false, quality: 'failed', reason: 'too few matches', pose: null });
    assert.equal(failed?.quality, 'failed');
    assert.equal(failed?.alignmentStatus, 'none');
    assert.equal(parseLocalize({ detail: 'x' }), null);
  });
});

describe('room-scan requests against a local mock', () => {
  let server: Server;
  let baseUrl = '';
  const seen: { method: string; url: string; contentType: string; bytes: number }[] = [];

  before(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = request.url ?? '';
        seen.push({
          method: request.method ?? '',
          url,
          contentType: request.headers['content-type'] ?? '',
          bytes: Buffer.concat(chunks).length,
        });
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (request.method === 'POST' && url === '/maps/room/recording') return send(202, { job: { ...JOB, state: 'queued' } });
        if (request.method === 'POST' && url === '/maps/taken/recording') return send(409, { detail: 'map exists' });
        if (url === '/jobs/b3f9c2a17d04') return send(200, JOB);
        if (url === '/jobs/unknown') return send(404, { detail: 'no such job' });
        if (url === '/maps/room/room') return send(200, { map_id: 'room', room: ROOM });
        if (url === '/maps/room/portal') return send(200, PORTAL);
        if (url === '/maps/odd/portal') return send(200, 'not an object');
        if (request.method === 'POST' && url === '/localize') return send(200, { success: false, quality: 'failed', reason: 'too dark' });
        send(404, { detail: 'not found' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const form = () => {
    const data = new FormData();
    data.append('video', new Blob([new Uint8Array(2048)]), 'video.mp4');
    data.append('session_jsonl', new Blob(['{"type":"header"}\n']), 'session.jsonl');
    data.append('replace', 'true');
    return data;
  };

  test('upload: accepted as a job, sent as multipart', async () => {
    const result = await uploadRecording(baseUrl, 'room', form());
    assert.equal(result.ok && result.value.state, 'queued');
    const request = seen.find((r) => r.url === '/maps/room/recording');
    assert.match(request?.contentType ?? '', /^multipart\/form-data; boundary=/);
    assert.ok((request?.bytes ?? 0) > 2048);
  });
  test('upload: the server\'s refusal is passed on with its reason', async () => {
    const result = await uploadRecording(baseUrl, 'taken', form());
    assert.deepEqual(result, { ok: false, status: 409, reason: 'HTTP 409: map exists' });
  });
  test('job, room and portal', async () => {
    const job = await getJob(baseUrl, 'b3f9c2a17d04');
    assert.equal(job.ok && job.value.stage, 'matching');
    assert.deepEqual(await getJob(baseUrl, 'unknown'), { ok: false, status: 404, reason: 'HTTP 404: no such job' });
    const room = await getRoom(baseUrl, 'room');
    assert.equal(room.ok && room.value.walls.length, 1);
    const portal = await getPortal(baseUrl, 'room');
    assert.equal(portal.ok && portal.value.source, 'auto');
    const odd = await getPortal(baseUrl, 'odd');
    assert.equal(odd.ok, false);
    assert.match(odd.ok ? '' : odd.reason, /expected shape/);
  });
  test('localize: a failed localisation is an answer, not an error', async () => {
    const result = await localize(baseUrl, form());
    assert.equal(result.ok && result.value.quality, 'failed');
    assert.equal(result.ok && result.value.reason, 'too dark');
  });
  test('no server: a reason instead of an exception', async () => {
    const result = await getRoom('http://127.0.0.1:9', 'room', { timeoutMs: 800 });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.status, null);
  });
});

describe('parseMaps', () => {
  test('the rooms of GET /maps', () => {
    const maps = parseMaps({
      maps: [
        { map_id: 'room', label: 'Living room', created_utc: '2026-11-20T10:00:00Z', room_status: 'ok', portal_source: 'auto', num_images: 30 },
        { map_id: 'old' },
        { label: 'no id' },
        'rubbish',
      ],
    });
    assert.deepEqual(maps, [
      { mapId: 'room', label: 'Living room', createdUtc: '2026-11-20T10:00:00Z', roomStatus: 'ok', portalSource: 'auto' },
      { mapId: 'old', label: '', createdUtc: '', roomStatus: 'unavailable', portalSource: 'none' },
    ]);
    assert.equal(parseMaps({ maps: 'no' }), null);
    assert.equal(parseMaps(null), null);
  });
});
