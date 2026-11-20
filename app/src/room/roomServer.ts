/**
 * The room scan's dealings with the localization server: sending a capture, following the
 * map build, fetching the room plan and the doorway, and localising a later session with a
 * short clip. The HTTP itself is in `server/core/client.ts`; this module decides what to
 * send and what the answers mean for the app.
 */
import { Directory, File } from 'expo-file-system';

import {
  cancelJob,
  getJob,
  getPortal,
  getRoom,
  localize,
  uploadRecording,
} from '../server/core/client';
import { describeJob, isFinalJobState, type LocalizeOutcome, type ServerJob } from '../server/core/roomPlan';
import { getDeviceId } from '../server/identity';
import { serverConnection } from '../server/ServerConnection';
import { appActions } from '../state/appStore';
import { roomActions, type ServerPlan } from './roomStore';
import { getLastCaptureDir, recordClip } from './scanController';

/** The map this app scans into and localises against. */
export const DEFAULT_MAP_ID = 'room';
const JOB_POLL_INTERVAL_MS = 1500;
/** This many polls in a row without an answer end the waiting (the build itself goes on). */
const MAX_FAILED_POLLS = 8;
const CLIP_SECONDS = 2.5;

const log = (text: string) => appActions.log(`server: ${text}`);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let uploadAbort: AbortController | null = null;
let activeJobId: string | null = null;

/** A file of a React Native multipart form. */
function filePart(file: File, name: string, type: string): unknown {
  return { uri: file.uri, name, type };
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function fail(text: string): void {
  roomActions.setUpload({ phase: 'failed', text, progress: null });
  log(`upload/build: ${text}`);
}

/** Room plan and doorway of a map, in the map frame. */
async function fetchPlan(baseUrl: string, mapId: string, origin: ServerPlan['origin']): Promise<ServerPlan> {
  const [room, portal] = await Promise.all([getRoom(baseUrl, mapId), getPortal(baseUrl, mapId)]);
  if (!room.ok) {
    log(`room plan not available: ${room.reason}`);
  }
  if (!portal.ok) {
    log(`doorway not available: ${portal.reason}`);
  }
  return { mapId, origin, room: room.ok ? room.value : null, portal: portal.ok ? portal.value : null };
}

async function followJob(baseUrl: string, first: ServerJob): Promise<ServerJob | null> {
  let job = first;
  let failedPolls = 0;
  let lastStage = '';
  activeJobId = job.jobId;
  try {
    while (!isFinalJobState(job.state)) {
      roomActions.setUpload({ phase: 'building', text: describeJob(job), progress: job.progress });
      if (job.stage && job.stage !== lastStage) {
        lastStage = job.stage;
        log(`build: step ${job.stageIndex}/${job.stageCount} ${job.stage}`);
      }
      await wait(JOB_POLL_INTERVAL_MS);
      const next = await getJob(baseUrl, job.jobId);
      if (next.ok) {
        job = next.value;
        failedPolls = 0;
      } else if (++failedPolls >= MAX_FAILED_POLLS) {
        fail(`lost contact with the server while it was building (${next.reason}). The build may still finish.`);
        return null;
      }
    }
    return job;
  } finally {
    activeJobId = null;
  }
}

/**
 * Sends the newest capture, waits for the map and shows the result: the room plan is
 * drawn and the doorway handed to the self-hosted provider. The recording was made in
 * the running AR session, so the new map's frame is this session's frame.
 */
export async function uploadLastCapture(): Promise<void> {
  if (uploadAbort || activeJobId) {
    return;
  }
  const baseUrl = serverConnection.getBaseUrl();
  const info = serverConnection.getView().connection.info;
  const dir = getLastCaptureDir();
  if (!baseUrl || !info) {
    fail('the server is not connected - tap the server chip');
    return;
  }
  if (!info.capabilities.includes('recording_upload')) {
    fail('this server does not accept recordings - update the localization server');
    return;
  }
  if (!dir) {
    fail('nothing to send yet - record the room first');
    return;
  }
  const video = new File(dir, 'video.mp4');
  const session = new File(dir, 'session.jsonl');
  if (!video.exists || !session.exists) {
    fail(`${dir.name} has no video.mp4 / session.jsonl`);
    return;
  }

  const form = new FormData();
  form.append('video', filePart(video, 'video.mp4', 'video/mp4') as never);
  form.append('session_jsonl', filePart(session, 'session.jsonl', 'application/x-ndjson') as never);
  // The engine's own mesh file (world_mesh.bin) is not sent: the app converts it to PLY.
  const mesh = new File(dir, 'world_mesh.ply');
  if (mesh.exists) {
    form.append('mesh', filePart(mesh, mesh.name, 'application/octet-stream') as never);
    form.append('mesh_format', 'ply');
  }
  form.append('replace', 'true');
  form.append('device_id', getDeviceId());
  form.append('label', `phone scan ${dir.name}`);

  const total = Number(video.size ?? 0) + Number(session.size ?? 0);
  log(`sending ${dir.name} (${megabytes(total)}) as map "${DEFAULT_MAP_ID}"`);
  roomActions.setUpload({ phase: 'uploading', text: `sending ${megabytes(total)}...`, progress: 0 });

  uploadAbort = new AbortController();
  let lastPercent = -1;
  const accepted = await uploadRecording(baseUrl, DEFAULT_MAP_ID, form, {
    signal: uploadAbort.signal,
    onProgress: (sent, all) => {
      const fraction = all > 0 ? sent / all : 0;
      const percent = Math.round(fraction * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        roomActions.setUpload({
          phase: 'uploading',
          text: `sending ${percent} % of ${megabytes(all)}`,
          progress: fraction,
        });
      }
    },
  });
  uploadAbort = null;
  if (!accepted.ok) {
    fail(`the server did not take the recording: ${accepted.reason}`);
    return;
  }
  log(`recording accepted, build job ${accepted.value.jobId}`);

  const job = await followJob(baseUrl, accepted.value);
  if (!job) {
    return;
  }
  if (job.state !== 'succeeded') {
    fail(describeJob(job));
    return;
  }
  for (const warning of job.result?.warnings ?? []) {
    log(`build warning: ${warning}`);
  }
  roomActions.setUpload({ phase: 'done', text: describeJob(job), progress: 1 });
  log(`build ${describeJob(job)}`);

  const plan = await fetchPlan(baseUrl, DEFAULT_MAP_ID, 'build');
  roomActions.setServerPlan(plan);
  // The doorway is placed by the self-hosted provider, which watches the plan.
  appActions.setProvider('self-hosted');
}

/** Stops an upload in progress, or asks the server to cancel the running build. */
export async function cancelUploadOrBuild(): Promise<void> {
  if (uploadAbort) {
    uploadAbort.abort();
    return;
  }
  const baseUrl = serverConnection.getBaseUrl();
  if (activeJobId && baseUrl) {
    const result = await cancelJob(baseUrl, activeJobId);
    log(result.ok ? `build ${result.value.state}` : `could not cancel the build: ${result.reason}`);
  }
}

export type LocalizeResult =
  /** The server answered. `plan` is usable only when `outcome.alignmentStatus` is "ok". */
  | { kind: 'answer'; outcome: LocalizeOutcome; plan: ServerPlan }
  /** No answer: the clip could not be recorded, or the request failed. */
  | { kind: 'failed'; reason: string };

function removeQuietly(dir: Directory): void {
  try {
    dir.delete();
  } catch {
    // a leftover clip in the cache folder does no harm
  }
}

/**
 * Looks for the scanned room in the current AR session: records a short clip with its
 * camera poses and sends it to `/localize`. The answer carries the room plan and the
 * doorway in this session's frame. What to do with the answer is the caller's decision
 * (`localization/core/relocalization.ts`).
 *
 * `sessionId` groups the observations of one AR world frame on the server; it has to
 * change whenever tracking was interrupted, because the frame may have changed.
 */
export async function localizeWithClip(mapId: string, sessionId: string): Promise<LocalizeResult> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    return { kind: 'failed', reason: 'the server is not connected' };
  }
  const clip = await recordClip(CLIP_SECONDS);
  if ('error' in clip) {
    return { kind: 'failed', reason: clip.error };
  }
  try {
    const video = new File(clip.dir, 'video.mp4');
    const session = new File(clip.dir, 'session.jsonl');
    if (!video.exists || !session.exists) {
      return { kind: 'failed', reason: 'the clip has no video.mp4 / session.jsonl' };
    }
    const form = new FormData();
    form.append('video', filePart(video, 'video.mp4', 'video/mp4') as never);
    form.append('session_jsonl', filePart(session, 'session.jsonl', 'application/x-ndjson') as never);
    form.append('map_id', mapId);
    form.append('session_id', sessionId);
    form.append('device_id', getDeviceId());
    form.append('include_room', 'true');
    const answer = await localize(baseUrl, form);
    if (!answer.ok) {
      return { kind: 'failed', reason: answer.reason };
    }
    const outcome = answer.value;
    log(
      `localize: ${outcome.quality}, ${outcome.numInliers} inliers, alignment ${outcome.alignmentStatus}` +
        (outcome.reason ? ` (${outcome.reason})` : ''),
    );
    return {
      kind: 'answer',
      outcome,
      plan: { mapId, origin: 'localize', room: outcome.room, portal: outcome.portal },
    };
  } finally {
    removeQuietly(clip.dir);
  }
}
