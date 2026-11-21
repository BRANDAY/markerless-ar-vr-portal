// Unit tests of the room-scan part of the server contract (api-v2). Run with `npm test`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { deleteRoom, getJob, getJobs, getPortal, getRoom, localize, measureBridge, patchRoomVps, removeDoor, renameRoom, saveDoor, setClientRole, uploadRecording } from './client';
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
  parseSavedDoor,
  parseScanQuality,
  describeScanQuality,
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
  test('the scan quality of a finished build is kept as far as it is well-formed (server 0.8.0)', () => {
    const result = { room: { status: 'ok' }, portal: { source: 'none' }, warnings: [] };
    const done = (scan_quality: unknown) => parseJob({ ...JOB, state: 'succeeded', progress: 1, result: { ...result, scan_quality } });
    // an older server says nothing about the scan
    assert.equal(parseJob({ ...JOB, state: 'succeeded', result })?.result?.scanQuality, null);
    // the owner's first recording, as the server judged it
    const owner = done({
      verdict: 'rescan',
      summary: ' Scanned from one spot. ',
      issues: [
        { code: 'one_spot', value: 1.1, limit: 1.5, text: 'Made from one spot.', do: 'Walk round the room.' },
        { code: 'never_looked_up', value: -11.5, limit: 15, text: 'Never looked up.', do: 'Sweep to the ceiling.' },
        { code: 'repeated_views', value: 0.45, limit: 0.3 },
        { value: 3 },
      ],
      motion: { footprint_m: [1.1, 0.84], pitch_deg: { lowest: -40, median: -20, highest: -11.5 }, repeated_share: 0.45 },
    })?.result?.scanQuality;
    assert.equal(owner?.verdict, 'rescan');
    assert.equal(owner?.summary, 'Scanned from one spot.');
    assert.deepEqual(owner?.issues.map((issue) => issue.code), ['one_spot', 'never_looked_up', 'repeated_views']);
    assert.deepEqual(owner?.issues[0], { code: 'one_spot', value: 1.1, limit: 1.5, text: 'Made from one spot.', todo: 'Walk round the room.' });
    assert.deepEqual(owner?.footprintM, [1.1, 0.84]);
    assert.equal(owner?.highestPitchDeg, -11.5);
    assert.equal(owner?.repeatedShare, 0.45);
    assert.match(owner ? describeScanQuality(owner) : '', /rescan; issues one_spot, never_looked_up, repeated_views; footprint 1.10 x 0.84 m; highest pitch -11.5 deg; 45 % repeated/);
    // the row of GET /maps gives bare codes
    assert.deepEqual(parseScanQuality({ verdict: 'limited', issues: ['frames_lost', 7] })?.issues.map((issue) => issue.code), ['frames_lost']);
    // an unknown verdict is not guessed at; odd shapes are nothing
    assert.equal(done({ verdict: 'excellent' })?.result?.scanQuality, null);
    assert.equal(done('good')?.result?.scanQuality, null);
    assert.equal(done([0.5])?.result?.scanQuality, null);
    assert.equal(parseScanQuality(null), null);
    // the job itself is read whatever the field holds
    assert.equal(done({ verdict: {} })?.state, 'succeeded');
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
    assert.equal(none?.confirmed, false);
    assert.equal(none?.suggested, null);
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
    // server 0.8.0: weak frames only - an ordinary refusal, with its reason kept for the log
    const weak = parseLocalize({ success: true, quality: 'weak', alignment: { status: 'failed', reason_code: 'weak_only' }, load: { stopped_early: true } });
    assert.equal(weak?.alignmentStatus, 'failed');
    assert.equal(weak?.alignmentReason, 'weak_only');
    assert.equal(weak?.stoppedEarly, true);
    assert.equal(weak?.transform, null);
    assert.equal(failed?.stoppedEarly, false);
    assert.equal(parseLocalize({ detail: 'x' }), null);
  });
});

describe('the door staff placed (api-v2, section 5)', () => {
  const SUGGESTED = { source: 'auto', opening_id: 'o0', position: [1, -1.3, -2], rotation_euler_deg: [0, 90, 0], width: 0.86, height: 2.02, confidence: 0.78 };
  const MANUAL = {
    map_id: 'room',
    frame: 'map',
    source: 'manual',
    confirmed: true,
    position: [0.4, -1.3, -1],
    rotation_euler_deg: [0, 30, 0],
    width: 0.9,
    height: 2.05,
    opening_id: null,
    confidence: null,
    updated_utc: '2026-11-21T09:40:00Z',
    placed_by: 'staff-phone',
    suggested: SUGGESTED,
    reason: null,
  };

  test('a saved door is confirmed, carries its size and the found doorway next to it', () => {
    const door = parsePortal(MANUAL);
    assert.equal(door?.source, 'manual');
    assert.equal(door?.confirmed, true);
    assert.deepEqual([door?.width, door?.height], [0.9, 2.05]);
    assert.equal(door?.updatedUtc, '2026-11-21T09:40:00Z');
    assert.deepEqual(door?.suggested, { openingId: 'o0', position: [1, -1.3, -2], rotation: [0, 90, 0], quaternion: null, width: 0.86, height: 2.02, confidence: 0.78 });
    // saved without a size: the app draws its default
    assert.equal(parsePortal({ ...MANUAL, width: null, height: null })?.width, null);
  });
  test('a doorway the server found by itself is not confirmed, and is its own suggestion', () => {
    const auto = parsePortal(PORTAL);
    assert.equal(auto?.confirmed, false);
    assert.deepEqual(auto?.suggested?.position, [1, -1.3, -2]);
    // whatever such a server claims, "auto" is nobody's decision
    assert.equal(parsePortal({ ...PORTAL, confirmed: true })?.confirmed, false);
    // a server from before the two modes sends no `confirmed`: the source says the same
    const { confirmed: _dropped, ...old } = MANUAL;
    assert.equal(parsePortal(old)?.confirmed, true);
    assert.equal(parsePortal({ ...old, source: 'selected' })?.confirmed, true);
  });
  test('no door, but a suggestion', () => {
    const none = parsePortal({ source: 'none', position: null, rotation_euler_deg: null, suggested: SUGGESTED, reason: 'removed' });
    assert.equal(none?.source, 'none');
    assert.equal(none?.suggested?.openingId, 'o0');
  });
  test('the answer to saving a door', () => {
    const saved = parseSavedDoor({ name: 'portal', alignment_used: 'session_alignment', portal: MANUAL });
    assert.equal(saved?.alignmentUsed, 'session_alignment');
    assert.equal(saved?.portal?.source, 'manual');
    // an older server answers with the stored anchor only
    assert.deepEqual(parseSavedDoor({ name: 'portal' }), { alignmentUsed: '', portal: null });
    assert.equal(parseSavedDoor('nonsense'), null);
  });
});

describe('room-scan requests against a local mock', () => {
  let server: Server;
  let baseUrl = '';
  const seen: { method: string; url: string; contentType: string; bytes: number; role: string; body: string }[] = [];

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
          role: String(request.headers['x-device-role'] ?? ''),
          body: (request.headers['content-type'] ?? '').startsWith('application/json') ? Buffer.concat(chunks).toString('utf8') : '',
        });
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (request.method === 'POST' && url === '/maps/room/recording') return send(202, { job: { ...JOB, state: 'queued' } });
        if (request.method === 'POST' && url === '/maps/taken/recording') return send(409, { detail: 'map exists' });
        if (request.method === 'POST' && url === '/maps/short/recording') {
          response.writeHead(422, { 'Content-Type': 'application/json', 'X-Error-Code': 'recording_too_short' });
          response.end(JSON.stringify({ detail: 'the recording is too short to build a map' }));
          return;
        }
        if (url === '/jobs?map_id=room') return send(200, { jobs: [{ ...JOB, state: 'succeeded' }, JOB, 'junk'] });
        if (url === '/jobs/b3f9c2a17d04') return send(200, JOB);
        if (url === '/jobs/unknown') return send(404, { detail: 'no such job' });
        if (url === '/maps/room/room') return send(200, { map_id: 'room', room: ROOM });
        if (request.method === 'PUT' && url === '/maps/room/anchors/portal') {
          return send(200, { name: 'portal', alignment_used: 'session_alignment', portal: { ...PORTAL, source: 'manual', confirmed: true } });
        }
        if (request.method === 'PUT' && url === '/maps/lost/anchors/portal') return send(422, { detail: 'no accepted alignment for this session' });
        if (request.method === 'POST' && url === '/maps/room/vps/bridge') {
          const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { samples: unknown[]; location_id: string };
          if (sent.samples.length < 2) return send(422, { detail: 'samples disagree' });
          return send(200, {
            map_id: 'room',
            frame_id: 'f1',
            vps: {
              provider: 'reactvision',
              location_id: sent.location_id,
              bridge: { T_service_from_map: [[0, 0, 1, 1], [0, 1, 0, 0.2], [-1, 0, 0, 2], [0, 0, 0, 1]], frame_id: 'f1', valid: true, samples: sent.samples.length, position_error_m: 0.031, rotation_error_deg: 0.4, measured_utc: '2026-11-22T10:05:00Z' },
            },
          });
        }
        if (request.method === 'PATCH' && url === '/maps/room') {
          const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { vps?: unknown; label?: string | null };
          return send(200, { map_id: 'room', label: sent.label === undefined ? 'Living room' : sent.label, portal_source: 'none', vps: sent.vps });
        }
        if (request.method === 'DELETE' && url === '/maps/room') return send(200, { deleted: 'room', kept_as: '.trash/room-20261121-094000' });
        if (request.method === 'DELETE' && url === '/maps/busy') return send(409, { detail: 'a build for this room is running' });
        if (request.method === 'DELETE' && url === '/maps/room/portal') return send(200, { deleted: true, portal: { source: 'none' } });
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
  test('upload: a recording that is refused at once carries the error code of the server', async () => {
    const result = await uploadRecording(baseUrl, 'short', form());
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.status, 422);
    assert.equal(result.ok ? null : result.code, 'recording_too_short');
  });
  test('the jobs of a room, newest first, without what is not a job', async () => {
    const jobs = await getJobs(baseUrl, 'room');
    assert.deepEqual(jobs.ok && jobs.value.map((job) => job.state), ['succeeded', 'running']);
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
  test('the door: saved in the frame of the room, a refusal is passed on, removed', async () => {
    const body = { position: [1, -1.3, -2] as [number, number, number], quaternion_xyzw: [0, 0.300706, 0, 0.953717] as [number, number, number, number], width: 0.85, height: 2.05 };
    setClientRole('staff');
    const saved = await saveDoor(baseUrl, 'room', body);
    setClientRole(null);
    assert.equal(saved.ok && saved.value.alignmentUsed, 'session_alignment');
    assert.equal(saved.ok && saved.value.portal?.confirmed, true);
    const request = seen.find((r) => r.method === 'PUT' && r.url === '/maps/room/anchors/portal');
    assert.deepEqual(JSON.parse(request?.body ?? 'null'), body);
    assert.equal(request?.role, 'staff'); // the mode goes with every request while it is set

    const refused = await saveDoor(baseUrl, 'lost', body);
    assert.equal(!refused.ok && refused.status, 422);

    const removed = await removeDoor(baseUrl, 'room');
    assert.equal(removed.ok, true);
    assert.equal(seen.find((r) => r.method === 'DELETE')?.role, '');
    assert.equal((await removeDoor(baseUrl, 'nowhere')).ok, false);
  });
  test('the room at ReactVision: the place is stored with the room, and removed', async () => {
    const stored = await patchRoomVps(baseUrl, 'room', { provider: 'reactvision', location_id: 'loc-1' });
    assert.deepEqual(stored.ok && stored.value.vps, { locationId: 'loc-1', bridge: null });
    const request = seen.filter((r) => r.method === 'PATCH').pop();
    assert.deepEqual(JSON.parse(request?.body ?? 'null'), { vps: { provider: 'reactvision', location_id: 'loc-1' } });
    const removed = await patchRoomVps(baseUrl, 'room', null);
    assert.equal(removed.ok && removed.value.vps, null);
    assert.equal((await patchRoomVps(baseUrl, 'nowhere', null)).ok, false);
  });
  test('a room is renamed and deleted (api-v2, section 10)', async () => {
    const renamed = await renameRoom(baseUrl, 'room', 'Exhibition 2');
    assert.equal(renamed.ok && renamed.value.label, 'Exhibition 2');
    const request = seen.filter((r) => r.method === 'PATCH').pop();
    assert.deepEqual(JSON.parse(request?.body ?? 'null'), { label: 'Exhibition 2' });
    // no name: the label is removed
    const unnamed = await renameRoom(baseUrl, 'room', null);
    assert.equal(unnamed.ok && unnamed.value.label, '');
    assert.equal((await renameRoom(baseUrl, 'nowhere', 'x')).ok, false);

    assert.deepEqual(await deleteRoom(baseUrl, 'room'), { ok: true, value: true });
    // refused while a map is being built for the room
    const busy = await deleteRoom(baseUrl, 'busy');
    assert.equal(!busy.ok && busy.status, 409);
    const gone = await deleteRoom(baseUrl, 'nowhere');
    assert.equal(!gone.ok && gone.status, 404);
  });
  test('the bridge: samples of one AR session go to the server, the measured bridge comes back', async () => {
    const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const body = { session_id: 'run-1-w0', location_id: 'loc-1', samples: [{ T_arworld_from_service: identity }, { T_arworld_from_service: identity }] };
    const measured = await measureBridge(baseUrl, 'room', body);
    assert.equal(measured.ok, true);
    const bridge = measured.ok ? measured.value.vps?.bridge : null;
    assert.equal(bridge?.samples, 2);
    assert.equal(bridge?.positionErrorM, 0.031);
    assert.equal(bridge?.frameId, 'f1');
    assert.deepEqual(bridge?.warnings, []);
    assert.equal(measured.ok && measured.value.frameId, 'f1');
    // column-major: the last column is the shift
    assert.deepEqual(bridge?.serviceFromRoom.slice(12), [1, 0.2, 2, 1]);
    const request = seen.filter((r) => r.method === 'POST' && r.url === '/maps/room/vps/bridge').pop();
    assert.deepEqual(JSON.parse(request?.body ?? 'null'), body);
    // the server's refusal ("samples disagree") is passed on
    const refused = await measureBridge(baseUrl, 'room', { ...body, samples: body.samples.slice(0, 1) });
    assert.equal(!refused.ok && refused.status, 422);
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
      { mapId: 'room', label: 'Living room', createdUtc: '2026-11-20T10:00:00Z', roomStatus: 'ok', portalSource: 'auto', portalConfirmed: false, frameId: '', recognition: [], vps: null },
      { mapId: 'old', label: '', createdUtc: '', roomStatus: 'unavailable', portalSource: 'none', portalConfirmed: false, frameId: '', recognition: [], vps: null },
    ]);
    // which rooms have a door for a visitor: the server's word, or the source on an older server
    const doors = parseMaps({
      maps: [
        { map_id: 'a', portal_source: 'manual', portal_confirmed: true },
        { map_id: 'b', portal_source: 'selected' },
        { map_id: 'c', portal_source: 'auto', portal_confirmed: false },
      ],
    });
    assert.deepEqual(doors?.map((room) => room.portalConfirmed), [true, true, false]);
    // the room at ReactVision Advanced VPS (section 11): its place there, and the bridge
    const bridge = { T_service_from_map: [[0, 0, 1, 1], [0, 1, 0, 0.2], [-1, 0, 0, 2], [0, 0, 0, 1]], frame_id: 'f1', valid: true, samples: 10, position_error_m: 0.031, rotation_error_deg: 0.4, measured_utc: '2026-11-22T10:05:00Z', warnings: ['measured through this session only', 7, ''] };
    const cloud = parseMaps({
      maps: [
        { map_id: 'a', frame_id: 'f1', recognition: ['self-hosted', 'reactvision'], vps: { provider: 'reactvision', location_id: 'loc-1', bridge, note: 'x' } },
        { map_id: 'b', recognition: ['self-hosted'], vps: { provider: 'reactvision', location_id: 'loc-2', bridge: null, bridge_dropped: { reason: 'room_rescanned' } } },
        { map_id: 'c', vps: { location_id: '' } },
        // only the other direction is given: the app turns it round
        { map_id: 'd', vps: { location_id: 'loc-4', bridge: { T_map_from_service: [[1, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, 3], [0, 0, 0, 1]] } } },
        // a bridge of an earlier scan, and one that is no transform
        { map_id: 'e', vps: { location_id: 'loc-5', bridge: { ...bridge, valid: false } } },
        { map_id: 'f', vps: { location_id: 'loc-6', bridge: { T_service_from_map: [[1, 2], [3, 4]] } } },
        { map_id: 'g', vps: null },
      ],
    });
    assert.equal(cloud?.[0].frameId, 'f1');
    assert.deepEqual(cloud?.[0].recognition, ['self-hosted', 'reactvision']);
    assert.equal(cloud?.[0].vps?.locationId, 'loc-1');
    assert.deepEqual(cloud?.[0].vps?.bridge, {
      serviceFromRoom: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0.2, 2, 1],
      frameId: 'f1',
      positionErrorM: 0.031,
      rotationErrorDeg: 0.4,
      samples: 10,
      measuredUtc: '2026-11-22T10:05:00Z',
      warnings: ['measured through this session only'],
    });
    assert.deepEqual(cloud?.[1].vps, { locationId: 'loc-2', bridge: null });
    assert.equal(cloud?.[2].vps, null);
    assert.deepEqual(cloud?.[3].vps?.bridge?.serviceFromRoom.slice(12), [-1, -2, -3, 1]);
    assert.deepEqual(cloud?.[4].vps, { locationId: 'loc-5', bridge: null });
    assert.deepEqual(cloud?.[5].vps, { locationId: 'loc-6', bridge: null });
    assert.equal(cloud?.[6].vps, null);
    assert.equal(parseMaps({ maps: 'no' }), null);
    assert.equal(parseMaps(null), null);
  });
});
