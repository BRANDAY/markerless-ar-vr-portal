/**
 * End-to-end run of the app's server client against a REAL localization server, without
 * a phone: the same functions the app calls (`client.ts`), the same decisions
 * (`localization/core/relocalization.ts`), on a recording that lies on the PC.
 *
 *   npm run e2e:server -- <server url> <recording folder> [map id] [--localize-only]
 *   npm run e2e:server -- http://127.0.0.1:8077 D:\recordings\room1 app_e2e
 *
 * The recording folder holds `video.mp4` and `session.jsonl` (and optionally
 * `world_mesh.ply`), as written by the app's scan mode. The map id defaults to `app_e2e`
 * and IS REPLACED on the server.
 *
 * With `--localize-only` nothing is uploaded: the recording is used as the clip of a
 * later session against a map that already exists on the server. If the folder has an
 * `expected.json` with `expected_T_arworld_from_map` (the server's test recordings do),
 * the doorway of the answer is compared with the map's doorway moved by that transform.
 *
 * What this does not cover (needs a device): how React Native encodes the multipart
 * upload from file URIs, the upload progress events, the recorder, and everything visual.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { decide } from '../../localization/core/relocalization';
import {
  getJob,
  getPortal,
  getRoom,
  localize,
  postDeviceLog,
  probeHealth,
  setClientIdentity,
  uploadRecording,
} from './client';
import { buildLogBody, type ClientIdentity, DeviceLogQueue, newDeviceId } from './deviceLog';
import { describeJob, isFinalJobState } from './roomPlan';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fmt = (v: readonly number[] | null | undefined) => (v ? `[${v.map((x) => x.toFixed(3)).join(', ')}]` : 'null');

let failures = 0;
function check(ok: boolean, text: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) {
    failures++;
  }
}

function filePart(path: string, type: string): Blob {
  return new Blob([readFileSync(path)], { type });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const localizeOnly = args.includes('--localize-only');
  const [baseUrl, recording, mapId = 'app_e2e'] = args.filter((arg) => !arg.startsWith('--'));
  if (!baseUrl || !recording) {
    console.log('usage: npm run e2e:server -- <server url> <recording folder> [map id] [--localize-only]');
    return 2;
  }
  const video = join(recording, 'video.mp4');
  const session = join(recording, 'session.jsonl');
  const mesh = join(recording, 'world_mesh.ply');
  if (!existsSync(video) || !existsSync(session)) {
    console.log(`${recording} has no video.mp4 / session.jsonl`);
    return 2;
  }

  const identity: ClientIdentity = {
    deviceId: `e2e-${newDeviceId().slice(-6)}`,
    deviceName: 'App client test (PC)',
    sessionId: `run-${Date.now().toString(36)}`,
    appVersion: 'e2e',
  };
  setClientIdentity(identity);
  console.log(`server ${baseUrl}, recording ${recording}, map "${mapId}", device ${identity.deviceId}`);

  // 1. health, as the connection heartbeat does it
  const health = await probeHealth(baseUrl, { timeoutMs: 5000 });
  check(health.kind === 'ok', `health: ${health.kind}${'reason' in health ? ` (${health.reason})` : ''}`);
  if (health.kind !== 'ok') {
    return 1;
  }
  const caps = health.info.capabilities;
  console.log(`      server "${health.info.serverName}", ${health.latencyMs} ms, capabilities ${caps.join(', ')}`);
  check(caps.includes('recording_upload'), 'capability recording_upload');

  // 2. device log (section 9), before and after
  const queue = new DeviceLogQueue();
  queue.add('app: client test started', Date.now());
  queue.add('server: sending the recording', Date.now());
  if (caps.includes('device_log')) {
    const body = buildLogBody(
      identity,
      queue.nextBatch(),
      { step: 'uploading', tracking: 'NORMAL', map_id: mapId, detail: 'client test' },
      Date.now(),
      health.latencyMs,
    );
    const receipt = await postDeviceLog(baseUrl, identity.deviceId, body);
    check(receipt.ok && receipt.value.lastSeq === 2, `device log accepted: ${JSON.stringify(receipt)}`);
    const again = await postDeviceLog(baseUrl, identity.deviceId, body);
    check(again.ok && again.value.duplicates === 2 && again.value.accepted === 0, `a repeated batch is counted as duplicates: ${JSON.stringify(again)}`);
  } else {
    console.log('SKIP  device log: the server does not announce device_log');
  }

  // 3. upload and build, as "Upload" does it
  if (localizeOnly) {
    console.log(`SKIP  upload and build: using the existing map "${mapId}"`);
  } else {
  const form = new FormData();
  form.append('video', filePart(video, 'video/mp4'), 'video.mp4');
  form.append('session_jsonl', filePart(session, 'application/x-ndjson'), 'session.jsonl');
  if (existsSync(mesh)) {
    form.append('mesh', filePart(mesh, 'application/octet-stream'), 'world_mesh.ply');
    form.append('mesh_format', 'ply');
  }
  form.append('replace', 'true');
  form.append('device_id', identity.deviceId);
  form.append('label', 'app client test');
  const startedAt = Date.now();
  const accepted = await uploadRecording(baseUrl, mapId, form);
  check(accepted.ok, `upload accepted${accepted.ok ? `, job ${accepted.value.jobId}` : `: ${accepted.reason}`}`);
  if (!accepted.ok) {
    return 1;
  }
  let job = accepted.value;
  let lastLine = '';
  let missed = 0;
  while (!isFinalJobState(job.state)) {
    await wait(1500);
    const polled = await getJob(baseUrl, job.jobId);
    if (!polled.ok) {
      missed++;
      console.log(`      poll failed: ${polled.reason}`);
      if (missed > 40) {
        check(false, 'the job could not be followed: the server stopped answering for a minute');
        return 1;
      }
      continue;
    }
    job = polled.value;
    missed = 0;
    // One line per step and per ten percent, not one per poll.
    const key = `${job.state} ${job.stage} ${Math.floor((job.progress ?? 0) * 10)}`;
    if (key !== lastLine) {
      console.log(`      ${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)} s  ${describeJob(job)}`);
      lastLine = key;
    }
  }
  check(job.state === 'succeeded', `build ${job.state} after ${((Date.now() - startedAt) / 1000).toFixed(0)} s${job.error ? `: ${job.error.code} - ${job.error.message}` : ''}`);
  if (job.state !== 'succeeded') {
    return 1;
  }
  }

  // 4. room plan and doorway in the map frame
  const room = await getRoom(baseUrl, mapId);
  check(room.ok, `room plan parsed${room.ok ? `: ${room.value.status}, ${room.value.walls.length} walls, ${room.value.corners.length} corners, ${room.value.openings.length} openings` : `: ${room.reason}`}`);
  const portal = await getPortal(baseUrl, mapId);
  check(portal.ok, `portal parsed${portal.ok ? `: source ${portal.value.source}, position ${fmt(portal.value.position)}, ${portal.value.width ?? '?'} x ${portal.value.height ?? '?'} m, confidence ${portal.value.confidence ?? '?'}` : `: ${portal.reason}`}`);

  // 5. localisation with a clip, as a later session does it. The clip here is the
  //    recording itself, so the "AR world" of the clip is the frame the map was built in
  //    and the doorway must come back where the map has it.
  const clip = new FormData();
  clip.append('video', filePart(video, 'video/mp4'), 'video.mp4');
  clip.append('session_jsonl', filePart(session, 'application/x-ndjson'), 'session.jsonl');
  clip.append('map_id', mapId);
  clip.append('session_id', `${identity.sessionId}-w0`);
  clip.append('device_id', identity.deviceId);
  clip.append('include_room', 'true');
  const t0 = Date.now();
  const located = await localize(baseUrl, clip);
  check(located.ok, `localize answered in ${Date.now() - t0} ms${located.ok ? '' : `: ${located.reason}`}`);
  if (located.ok) {
    const outcome = located.value;
    console.log(`      quality ${outcome.quality}, ${outcome.numInliers} inliers, alignment ${outcome.alignmentStatus}${outcome.reason ? `, reason ${outcome.reason}` : ''}`);
    check(outcome.alignmentStatus === 'ok', 'the map was placed in the session of the clip');
    const door =
      outcome.portal && outcome.portal.source !== 'none' && outcome.portal.position && outcome.portal.rotation
        ? { position: outcome.portal.position, rotation: outcome.portal.rotation }
        : null;
    const decision = decide(null, false, {
      quality: outcome.quality,
      alignmentStatus: outcome.alignmentStatus,
      door,
    });
    console.log(`      the app's decision for this answer: ${decision.action}`);
    if (outcome.alignmentStatus === 'ok') {
      if (room.ok && room.value.status !== 'unavailable') {
        check(outcome.room !== null, 'the answer carries the room plan in the AR frame');
      } else {
        console.log('      the map has no room plan, so the answer carries none');
      }
      if (portal.ok && portal.value.position && door) {
        // Where the doorway has to be in the clip's AR frame: the map position as it is
        // (a map built from this very recording), or moved by the known transform.
        let expected = portal.value.position;
        let how = 'where the map has it';
        const expectedFile = join(recording, 'expected.json');
        if (localizeOnly && existsSync(expectedFile)) {
          const t = (JSON.parse(readFileSync(expectedFile, 'utf-8')) as { expected_T_arworld_from_map?: number[][] })
            .expected_T_arworld_from_map;
          if (t) {
            const p = portal.value.position;
            expected = [0, 1, 2].map((r) => t[r][0] * p[0] + t[r][1] * p[1] + t[r][2] * p[2] + t[r][3]) as [number, number, number];
            how = "where the recording's known transform puts it";
          }
        }
        const d = Math.hypot(door.position[0] - expected[0], door.position[1] - expected[1], door.position[2] - expected[2]);
        console.log(`      doorway from /localize ${fmt(door.position)} vs expected ${fmt(expected)}: ${(d * 100).toFixed(1)} cm apart`);
        check(decision.action === 'place', 'the app would place the doorway');
        check(d < 0.25, `the doorway comes back within 25 cm of ${how}`);
      } else {
        console.log('      no doorway in this map: the app would report "no door opening found" and place nothing');
        check(decision.action === 'no-doorway', 'no doorway -> nothing is placed');
      }
    }
  }

  if (caps.includes('device_log')) {
    queue.acknowledge(2);
    queue.add(`server: client test finished with ${failures} failed checks`, Date.now());
    const body = buildLogBody(
      identity,
      queue.nextBatch(),
      { step: failures ? 'error' : 'portal_placed', tracking: 'NORMAL', map_id: mapId, detail: 'client test finished' },
      Date.now(),
      null,
    );
    const receipt = await postDeviceLog(baseUrl, identity.deviceId, body);
    check(receipt.ok && receipt.value.lastSeq === 3, `closing device log batch: ${JSON.stringify(receipt)}`);
  }

  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(`crashed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  },
);
