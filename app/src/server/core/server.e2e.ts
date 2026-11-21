/**
 * End-to-end run of the app's server client against a REAL localization server, without
 * a phone: the same functions the app calls (`client.ts`), the same decisions
 * (`localization/core/relocalization.ts`), on a recording that lies on the PC.
 *
 *   npm run e2e:server -- <server url> <recording folder> [map id] [--localize-only] [--door]
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
 * The door is worked out the way the app's door layer does it (`door/core/placement.ts`):
 * the answer of `/localize` says where the room is, the door record is read apart, and the
 * sum is the app's own; it is compared with the door the server multiplied out itself.
 *
 * After the localisation the run does what a staff member and a visitor do with the door
 * (`ui-spec.md`, 5.14): a door placed in the clip's AR session is saved in the room's
 * frame, a second localisation in the same session must bring it back to the same place
 * with its size, and the door is removed again. With the capability `service_bridge` the
 * second way of recognising the room is gone through as well, with a made-up "service"
 * whose map lies in the room in a known way (there is no ReactVision account): the room
 * gets a place there, the bridge is measured from samples of the clip's session, the same
 * door record is placed through the bridge, and the place is removed again. THE DOOR OF
 * THE MAP IS REPLACED AND THEN REMOVED, so with `--localize-only` (somebody else's map)
 * this part runs only when `--door` is given as well.
 *
 * What this does not cover (needs a device): how React Native encodes the multipart
 * upload from file URIs, the upload progress events, the recorder, and everything visual.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { doorCandidate, doorRecordBody, portalInSession, settle } from '../../door/core/placement';
import { applyToPoint, invertTransform, matrixFromYaw, rowsFromMatrix } from '../../door/core/roomFrame';
import { decide } from '../../localization/core/relocalization';
import { cameraMatrix, mapInSession, type Mat4, multiply } from '../../localization/core/vpsAlignment';
import { BRIDGE, BridgeSamples, roomThroughBridge } from '../../localization/core/ways';
import {
  compactLine,
  compareDoor,
  describeRecord,
  doorCorners,
  type MeasurementRecord,
  parseTrials,
} from '../../measure/core/measurement';
import { type DoorDraft, yawFromEuler } from '../../ui/core/doorEdit';
import { doorMayBeShown } from '../../ui/core/modes';
import {
  getJob,
  getMaps,
  getPortal,
  getRoom,
  localize,
  measureBridge,
  patchRoomVps,
  postDeviceLog,
  probeHealth,
  removeDoor,
  saveDoor,
  setClientIdentity,
  setClientRole,
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
  const withDoor = !localizeOnly || args.includes('--door');
  const [baseUrl, recording, mapId = 'app_e2e'] = args.filter((arg) => !arg.startsWith('--'));
  if (!baseUrl || !recording) {
    console.log('usage: npm run e2e:server -- <server url> <recording folder> [map id] [--localize-only] [--door]');
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
  const arSession = `${identity.sessionId}-w0`;
  const makeClip = () => {
    const clip = new FormData();
    clip.append('video', filePart(video, 'video/mp4'), 'video.mp4');
    clip.append('session_jsonl', filePart(session, 'application/x-ndjson'), 'session.jsonl');
    clip.append('map_id', mapId);
    clip.append('session_id', arSession);
    clip.append('device_id', identity.deviceId);
    clip.append('include_room', 'true');
    return clip;
  };
  let measured: MeasurementRecord | null = null;
  const t0 = Date.now();
  const located = await localize(baseUrl, makeClip());
  const localizeMs = Date.now() - t0;
  check(located.ok, `localize answered in ${localizeMs} ms${located.ok ? '' : `: ${located.reason}`}`);
  if (located.ok) {
    const outcome = located.value;
    console.log(`      quality ${outcome.quality}, ${outcome.numInliers} inliers, alignment ${outcome.alignmentStatus}${outcome.reason ? `, reason ${outcome.reason}` : ''}`);
    check(outcome.alignmentStatus === 'ok', 'the map was placed in the session of the clip');
    // As the app's door layer does it: the server says where the room is, the door record
    // is read apart, the sum is the app's. A door is one that staff saved; a doorway the
    // server only found is a suggestion.
    check(outcome.alignmentStatus !== 'ok' || outcome.transform !== null, 'the answer says where the room is (alignment.T_arworld_from_map)');
    const settled =
      outcome.transform && portal.ok ? settle(null, false, outcome.transform, portal.value, outcome.quality === 'good') : null;
    const mine = settled?.portal ?? null;
    const door = doorCandidate(mine, outcome.quality === 'good');
    if (mine?.suggested) {
      console.log(`      the server suggests a doorway at ${fmt(mine.suggested.position)} (a suggestion, not a door)`);
    }
    const decision =
      settled?.decision ?? decide(null, false, { quality: outcome.quality, alignmentStatus: outcome.alignmentStatus, door: null });
    // The door the server multiplied out itself is still in the answer: the two sums must agree.
    const theirs = outcome.portal?.position ? outcome.portal : (outcome.portal?.suggested ?? null);
    const ours = outcome.portal?.position ? mine : (mine?.suggested ?? null);
    if (theirs?.position && ours?.position && theirs.rotation && ours.rotation) {
      const off = Math.hypot(ours.position[0] - theirs.position[0], ours.position[1] - theirs.position[1], ours.position[2] - theirs.position[2]);
      const turn = Math.abs(((yawFromEuler(ours.rotation) - yawFromEuler(theirs.rotation) + 540) % 360) - 180);
      check(
        off < 0.005 && turn < 0.1,
        `the app's own sum (room transform x door record) agrees with the door the server multiplied out: ${(off * 1000).toFixed(1)} mm, ${turn.toFixed(2)} deg`,
      );
    } else {
      console.log('      nothing to compare the app\'s own sum with: the room has neither a door nor a suggested doorway');
    }
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
        let turnDeg = 0;
        let how = 'where the map has it';
        const expectedFile = join(recording, 'expected.json');
        if (localizeOnly && existsSync(expectedFile)) {
          const t = (JSON.parse(readFileSync(expectedFile, 'utf-8')) as { expected_T_arworld_from_map?: number[][] })
            .expected_T_arworld_from_map;
          if (t) {
            const p = portal.value.position;
            expected = [0, 1, 2].map((r) => t[r][0] * p[0] + t[r][1] * p[1] + t[r][2] * p[2] + t[r][3]) as [number, number, number];
            turnDeg = (Math.atan2(t[0][2], t[0][0]) * 180) / Math.PI;
            how = "where the recording's known transform puts it";
          }
        }
        const d = Math.hypot(door.position[0] - expected[0], door.position[1] - expected[1], door.position[2] - expected[2]);
        console.log(`      doorway from /localize ${fmt(door.position)} vs expected ${fmt(expected)}: ${(d * 100).toFixed(1)} cm apart`);
        check(decision.action === 'place', 'the app would place the doorway');
        check(d < 0.25, `the doorway comes back within 25 cm of ${how}`);
        if (portal.value.rotation) {
          // The same answer as the app's measurement mode would record it, with the
          // expected doorway standing in for the corners a user marks in the room.
          const widthM = portal.value.width ?? 0.9;
          const pose = { position: door.position, yawDeg: door.rotation[1], widthM };
          const reference = doorCorners({ position: expected, yawDeg: portal.value.rotation[1] + turnDeg, widthM });
          measured = {
            v: 1,
            kind: 'door-measurement',
            run: identity.sessionId,
            device: identity.deviceId,
            seq: 1,
            time: new Date().toISOString(),
            condition: 'restart',
            event: 'check',
            provider: 'self-hosted',
            tracking: 'normal',
            placement: {
              event: 'placed',
              reason: 'start',
              attempts: 1,
              elapsedMs: localizeMs,
              sinceStartMs: localizeMs,
              trusted: outcome.quality === 'good',
              quality: outcome.quality,
              inliers: outcome.numInliers,
              source: outcome.portal?.source ?? null,
              confidence: outcome.portal?.confidence ?? null,
            },
            door: { ...pose, heightM: portal.value.height ?? 2, sizeFromServer: portal.value.width !== null },
            reference: { ...reference, method: 'expected', beforeInterruption: false },
            comparison: compareDoor(pose, reference),
            held: false,
          };
          console.log(`      as a measurement record: ${describeRecord(measured)}`);
        }
      } else {
        console.log('      no door saved in this map: the app shows none and sends staff to "Place the door"');
        check(decision.action === 'no-doorway', 'no saved door -> nothing is placed');
      }
    }
  }

  // 6. the staff's door (`ui-spec.md`, 5.14): placed in the AR session of the clip, saved
  //    in the room's frame through the room transform, and what a visitor's phone makes of
  //    the record in that same session.
  if (!withDoor) {
    console.log(`SKIP  the staff's door: it would replace the door of "${mapId}" (add --door to run it)`);
  } else if (!caps.includes('staff_door')) {
    console.log('SKIP  the staff\'s door: the server does not announce staff_door');
  } else if (!located.ok || located.value.alignmentStatus !== 'ok' || !located.value.transform) {
    check(false, 'the staff\'s door could not be tried: the room was not found in the clip\'s session');
  } else {
    const sized = caps.includes('door_size');
    const floorY = located.value.room?.floorOutline?.[0]?.[1] ?? located.value.portal?.suggested?.position[1] ?? -1.3;
    const placed: DoorDraft = { position: [0.4, Math.round(floorY * 1000) / 1000, -0.6], yaw: 35, width: 0.85, height: 2.05 };
    setClientRole('staff');

    const body = doorRecordBody(located.value.transform, placed, sized);
    console.log(`      the door in the room's frame: ${fmt(body.position)}, quaternion ${fmt(body.quaternion_xyzw)}`);
    const saved = await saveDoor(baseUrl, mapId, body);
    check(saved.ok, `door saved in the room's frame${saved.ok ? ` (the server names the way: ${saved.value.alignmentUsed || 'not named'})` : `: ${saved.reason}`}`);
    if (saved.ok) {
      check(saved.value.portal?.source === 'manual' && saved.value.portal.confirmed === true, 'the answer shows the door as placed by hand and confirmed');
      const stored = await getPortal(baseUrl, mapId);
      check(stored.ok && stored.value.confirmed && doorMayBeShown(stored.value.source), `GET portal: ${stored.ok ? `source ${stored.value.source}, ${stored.value.width ?? '?'} x ${stored.value.height ?? '?'} m` : stored.reason}`);
      const rooms = await getMaps(baseUrl);
      check(rooms.ok && rooms.value.find((room) => room.mapId === mapId)?.portalConfirmed === true, 'GET /maps lists the room as one with a door for visitors');

      // A visitor's phone in the same AR frame: the door must stand where it was put.
      setClientRole('visitor');
      const back = await localize(baseUrl, makeClip());
      check(back.ok && back.value.alignmentStatus === 'ok', `a second localisation in that session${back.ok ? '' : `: ${back.reason}`}`);
      const record = await getPortal(baseUrl, mapId);
      const got = back.ok && back.value.transform && record.ok ? portalInSession(back.value.transform, record.value) : null;
      const theirs = back.ok ? back.value.portal : null;
      if (got?.position && got.rotation && theirs?.position && theirs.rotation) {
        // The server still multiplies the door out itself: the two sums must agree.
        const off = Math.hypot(got.position[0] - theirs.position[0], got.position[1] - theirs.position[1], got.position[2] - theirs.position[2]);
        const turn = Math.abs(((yawFromEuler(got.rotation) - yawFromEuler(theirs.rotation) + 540) % 360) - 180);
        check(
          off < 0.005 && turn < 0.1,
          `the app's own sum (room transform x door record) agrees with the door the server multiplied out: ${(off * 1000).toFixed(1)} mm, ${turn.toFixed(2)} deg`,
        );
      }
      if (got && got.position && got.rotation) {
        const apart = Math.hypot(got.position[0] - placed.position[0], got.position[1] - placed.position[1], got.position[2] - placed.position[2]);
        const turned = Math.abs(((yawFromEuler(got.rotation) - placed.yaw + 540) % 360) - 180);
        console.log(`      door from the record and the new room transform ${fmt(got.position)} yaw ${yawFromEuler(got.rotation).toFixed(1)} vs placed ${fmt(placed.position)} yaw ${placed.yaw}: ${(apart * 100).toFixed(1)} cm, ${turned.toFixed(1)} deg`);
        check(got.confirmed && doorMayBeShown(got.source), 'the visitor is given the door (confirmed)');
        check(apart < 0.05 && turned < 3, 'the door comes back within 5 cm and 3 degrees of where it was placed');
        if (sized) {
          check(got.width === placed.width && got.height === placed.height, `the door comes back with its size: ${got.width} x ${got.height} m`);
        } else {
          console.log('      this server does not store door sizes (no capability door_size)');
        }
        const decision = decide(null, false, {
          quality: back.ok ? back.value.quality : 'failed',
          alignmentStatus: back.ok ? back.value.alignmentStatus : 'none',
          door: { position: got.position, rotation: got.rotation },
        });
        check(decision.action === 'place', "the visitor's app would place the door");
      } else {
        check(false, 'the second localisation gave no door');
      }

      // 7. the second way (api-v2, section 11), with a made-up service: its map lies in
      //    the room turned by 25 degrees and shifted. What the app would measure in the
      //    clip's session is worked out from that truth; the server must find the bridge
      //    again, and the SAME door record must then stand at the same place.
      setClientRole('staff');
      if (!caps.includes('service_bridge')) {
        console.log('SKIP  the second way: the server does not announce service_bridge');
      } else if (!back.ok || !back.value.transform || !record.ok) {
        check(false, 'the second way could not be tried: no room transform or no door record');
      } else {
        const roomInSession = back.value.transform;
        const truth: Mat4 = matrixFromYaw([2, 0.3, -1], 25); // room to service
        const serviceInSessionTruth = multiply(roomInSession, invertTransform(truth));
        const place = await patchRoomVps(baseUrl, mapId, { provider: 'reactvision', location_id: 'e2e-made-up-place' });
        check(place.ok && place.value.vps?.locationId === 'e2e-made-up-place' && place.value.vps.bridge === null, `the room got a place at the service, no bridge yet${place.ok ? '' : `: ${place.reason}`}`);
        check(place.ok && !place.value.recognition.includes('reactvision'), `without a bridge the room is recognised through: ${place.ok ? place.value.recognition.join(', ') || '(not said)' : '?'}`);

        // The phone at several places of the room: the AR camera pose, and the pose the
        // service would report for it; from the two the app reads where the service's map lies.
        const samples = new BridgeSamples();
        let reading = null;
        for (let i = 0; i < BRIDGE.samples; i++) {
          const camera = cameraMatrix([0.6 * i - 1.5, 1.4, 0.5 * (i % 3)], [Math.sin(i), -0.2, -Math.cos(i)], [0, 1, 0]);
          if (!camera) {
            continue;
          }
          // a little noise, as two poses that were not taken at the same instant have
          const noisy = multiply(serviceInSessionTruth, matrixFromYaw([0.01 * Math.sin(3 * i), 0, 0.01 * Math.cos(5 * i)], 0.3 * Math.sin(7 * i)));
          reading = mapInSession(camera, multiply(invertTransform(noisy), camera));
          if (reading) {
            samples.offer(reading, [camera[12], camera[13], camera[14]], i * 3000);
          }
        }
        check(samples.complete, `${samples.count} samples of where the service's map lies in the session`);
        const measured = await measureBridge(baseUrl, mapId, { T_arworld_from_map: rowsFromMatrix(roomInSession), samples: samples.body() });
        check(measured.ok, `the server measured the bridge${measured.ok ? '' : `: ${measured.reason}`}`);
        const bridge = measured.ok ? (measured.value.vps?.bridge ?? null) : null;
        if (bridge) {
          const at = record.value.position ?? [0, 0, 0];
          const there = applyToPoint(bridge.serviceFromRoom, at);
          const expected = applyToPoint(truth, at);
          const off = Math.hypot(there[0] - expected[0], there[1] - expected[1], there[2] - expected[2]);
          console.log(
            `      bridge from ${bridge.samples} samples; the server's own estimate of its error: ` +
              `${bridge.positionErrorM === null ? '?' : (bridge.positionErrorM * 100).toFixed(1)} cm, ${bridge.rotationErrorDeg === null ? '?' : bridge.rotationErrorDeg.toFixed(2)} deg`,
          );
          check(off < 0.03, `the bridge puts the door ${(off * 100).toFixed(1)} cm from where the made-up service has it`);
          const rooms = await getMaps(baseUrl);
          const listed = rooms.ok ? rooms.value.find((room) => room.mapId === mapId) : undefined;
          check(listed?.recognition.includes('reactvision') === true && listed.vps?.bridge !== null, `GET /maps lists the room as recognisable through: ${listed?.recognition.join(', ') ?? '?'}`);

          // A visitor's phone that finds the room through the service: the same door record.
          if (reading) {
            const viaService = portalInSession(roomThroughBridge(reading, bridge.serviceFromRoom), record.value);
            const apart = viaService.position
              ? Math.hypot(viaService.position[0] - placed.position[0], viaService.position[1] - placed.position[1], viaService.position[2] - placed.position[2])
              : NaN;
            const turned = viaService.rotation ? Math.abs(((yawFromEuler(viaService.rotation) - placed.yaw + 540) % 360) - 180) : NaN;
            check(apart < 0.05 && turned < 3, `the door through the second way stands ${(apart * 100).toFixed(1)} cm and ${turned.toFixed(1)} deg from where it was placed`);
          }
        } else if (measured.ok) {
          check(false, 'the answer carries no bridge');
        }
        const gone = await patchRoomVps(baseUrl, mapId, null);
        check(gone.ok && gone.value.vps === null, `the room's place at the service removed${gone.ok ? '' : `: ${gone.reason}`}`);
      }

      const removed = await removeDoor(baseUrl, mapId);
      check(removed.ok, `door removed${removed.ok ? '' : `: ${removed.reason}`}`);
      const after = await getPortal(baseUrl, mapId);
      check(after.ok && !after.value.confirmed && !doorMayBeShown(after.value.source), `after removal the room has no door for visitors${after.ok ? ` (source ${after.value.source}${after.value.suggested ? ', a suggestion stays' : ''})` : `: ${after.reason}`}`);
    }
    setClientRole(null);
  }

  if (caps.includes('device_log')) {
    queue.acknowledge(2);
    queue.add(`server: client test finished with ${failures} failed checks`, Date.now());
    if (measured) {
      queue.add(describeRecord(measured), Date.now());
      queue.add(compactLine(measured), Date.now());
    }
    const lastSeq = measured ? 5 : 3;
    const body = buildLogBody(
      identity,
      queue.nextBatch(),
      { step: failures ? 'error' : 'portal_placed', tracking: 'NORMAL', map_id: mapId, detail: 'client test finished' },
      Date.now(),
      null,
    );
    const receipt = await postDeviceLog(baseUrl, identity.deviceId, body);
    check(receipt.ok && receipt.value.lastSeq === lastSeq, `closing device log batch: ${JSON.stringify(receipt)}`);
    if (measured) {
      // The measurement must be readable from the server afterwards (the panel, the report).
      try {
        const back = await fetch(`${baseUrl}/devices/${identity.deviceId}/log?limit=100`);
        const events = ((await back.json()) as { events?: unknown[] }).events ?? [];
        const trials = parseTrials(events.map((event) => JSON.stringify(event)).join('\n'));
        check(
          trials.length === 1 && trials[0].positionCm === measured.comparison?.positionCm,
          `the measurement record reads back from the server's device log (${trials.length} found among ${events.length} events)`,
        );
      } catch (error) {
        check(false, `the device log could not be read back: ${String(error)}`);
      }
    }
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
