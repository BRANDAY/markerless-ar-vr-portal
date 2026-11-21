/**
 * The room scan's dealings with the localization server: sending a capture, following the
 * map build, fetching the room plan and the doorway, and localising a later session with a
 * short clip. The HTTP itself is in `server/core/client.ts`; this module decides what to
 * send and what the answers mean for the app.
 */
import { Directory, File } from 'expo-file-system';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import {
  cancelJob,
  getJob,
  getJobs,
  getPortal,
  getRoom,
  localize,
  uploadRecording,
} from '../server/core/client';
import { describeJob, isFinalJobState, type LocalizeOutcome, type ServerJob } from '../server/core/roomPlan';
import { getDeviceId } from '../server/identity';
import { serverConnection } from '../server/ServerConnection';
import { appActions, getAppState } from '../state/appStore';
import { getPrefs, prefsActions } from '../state/prefs';
import { type BuildFailure, failureFromJobError, failureFromUpload } from '../ui/core/buildView';
import { noteSession } from './roomAdmin';
import { getRoomScanState, isBuilding, roomActions, type ScanTarget, type ServerPlan } from './roomStore';
import { roomsActions } from './roomsStore';
import { findCaptureDir, getLastCaptureDir, recordClip } from './scanController';

/** The map the developer tools scan into (the product screens name their rooms). */
export const DEFAULT_MAP_ID = 'room';
const JOB_POLL_INTERVAL_MS = 1500;
/**
 * A computer that is busy building a map may answer slowly, and a build may take twenty
 * minutes and more: an answer has this long...
 */
const JOB_POLL_TIMEOUT_MS = 8000;
/**
 * ...and this many polls in a row without one end the waiting (the build itself goes on,
 * and `useBuildFollowUp` takes it up again when the server answers): about two minutes.
 */
const MAX_FAILED_POLLS = 12;
/** How often a build that was lost sight of is asked for again. */
const FOLLOW_UP_INTERVAL_MS = 5000;
/**
 * Length of the clip a look for the room sends. 2.5 s until the first pass on a phone
 * (2026-11-21): there the server recognised the room from almost every frame of a clip
 * that looked at it, so most of the clip was waiting. The server takes three frames.
 */
const CLIP_SECONDS = 1.2;
/**
 * How long the server may take over one clip. On a loaded PC an answer has taken 39 s;
 * the health checks are held meanwhile (`serverConnection.hold`), so this is what ends
 * the waiting when the server is really gone.
 */
const LOCALIZE_TIMEOUT_MS = 60_000;

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

/**
 * The end of a build that did not work: `failure` chooses the screen
 * (`ui/core/buildView.ts`), `text` is the technical line for the log and the developer
 * tools.
 */
function fail(failure: BuildFailure, text: string): void {
  roomActions.setBuild({ phase: 'failed', failure });
  roomActions.setUpload({ phase: 'failed', text, progress: null });
  log(`upload/build failed (${failure}): ${text}`);
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

/** Follows a build to its end. Null when contact was lost for too long (already reported). */
async function followJob(baseUrl: string, first: ServerJob): Promise<ServerJob | null> {
  let job = first;
  let failedPolls = 0;
  let lastStage = '';
  activeJobId = job.jobId;
  try {
    while (!isFinalJobState(job.state)) {
      if (failedPolls === 0) {
        roomActions.setBuild({
          phase: job.state === 'queued' ? 'queued' : 'running',
          jobId: job.jobId,
          jobProgress: job.progress,
          queuePosition: job.queuePosition,
          etaSeconds: job.etaSeconds,
        });
        roomActions.setUpload({ phase: 'building', text: describeJob(job), progress: job.progress });
      }
      if (job.stage && job.stage !== lastStage) {
        lastStage = job.stage;
        log(`build: step ${job.stageIndex}/${job.stageCount} ${job.stage}`);
      }
      await wait(JOB_POLL_INTERVAL_MS);
      const next = await getJob(baseUrl, job.jobId, { timeoutMs: JOB_POLL_TIMEOUT_MS });
      if (next.ok) {
        job = next.value;
        failedPolls = 0;
      } else if (++failedPolls >= MAX_FAILED_POLLS) {
        fail('lost-contact', `lost contact with the server while it was building (${next.reason}). The build may still finish.`);
        return null;
      } else {
        roomActions.setBuild({ phase: 'lost-contact' });
      }
    }
    return job;
  } finally {
    activeJobId = null;
  }
}

/**
 * The scan sent last stays remembered for "Send again", but its build is over: a restarted
 * app (`recoverBuild`) must not look the same job up again.
 */
function forgetJobOfCapture(): void {
  const saved = getPrefs().lastCapture;
  if (!saved) {
    return;
  }
  try {
    const json = JSON.parse(saved) as Record<string, unknown>;
    if ('jobId' in json) {
      delete json.jobId;
      prefsActions.set({ lastCapture: JSON.stringify(json) });
    }
  } catch {
    prefsActions.set({ lastCapture: null });
  }
}

/** What the end of a followed build means for the app. */
async function finishBuild(baseUrl: string, target: ScanTarget, job: ServerJob, startedAt: number): Promise<void> {
  if (job.state !== 'succeeded') {
    forgetJobOfCapture();
  }
  if (job.state === 'cancelled') {
    roomActions.setBuild({ phase: 'cancelled' });
    roomActions.setUpload({ phase: 'failed', text: 'cancelled', progress: null });
    log('build cancelled');
    return;
  }
  if (job.state !== 'succeeded') {
    // The server's own words go to the log, not to the screen.
    fail(failureFromJobError(job.error?.code), `${job.error?.code ?? 'no code'}: ${job.error?.message ?? describeJob(job)}`);
    return;
  }
  for (const warning of job.result?.warnings ?? []) {
    log(`build warning: ${warning}`);
  }
  roomActions.setBuild({
    phase: 'done',
    jobProgress: 1,
    frames: job.result?.numImages ?? null,
    seconds: job.result?.buildSeconds ?? (Date.now() - startedAt) / 1000,
    quality: job.result?.scanQuality ?? null,
  });
  roomActions.setUpload({ phase: 'done', text: describeJob(job), progress: 1 });
  log(`build ${describeJob(job)}`);

  // The new room is the one the app works with from now on.
  prefsActions.set({ lastRoomId: target.mapId, lastCapture: null });
  // A new map: the searches that failed with the old one no longer count against the room.
  noteSession(target.mapId, true);
  void roomsActions.refresh();
  if (getAppState().screen === 'ar') {
    // Developer tools: the recording was made in the AR session that is still running,
    // so the new map's frame is this session's frame and the plan can be drawn at once.
    roomActions.setServerPlan(await fetchPlan(baseUrl, target.mapId, 'build'));
    appActions.setProvider('self-hosted');
  }
}

/** A build of this room that the server is still working on, if there is one. */
async function runningJobOf(baseUrl: string, mapId: string): Promise<ServerJob | null> {
  const jobs = await getJobs(baseUrl, mapId);
  return jobs.ok ? (jobs.value.find((job) => !isFinalJobState(job.state)) ?? null) : null;
}

/**
 * Sends a capture as the map of a room, waits for the build and reports every step to the
 * room store: the product's build screen and the developer tools both read it there.
 */
export async function sendCapture(target: ScanTarget, dir: Directory | null): Promise<void> {
  if (uploadAbort || activeJobId) {
    return;
  }
  const startedAt = Date.now();
  roomActions.resetBuild();
  roomActions.setBuild({ phase: 'uploading', target });
  roomActions.setUpload({ phase: 'uploading', text: 'starting...', progress: 0 });

  const baseUrl = serverConnection.getBaseUrl();
  const info = serverConnection.getView().connection.info;
  if (!baseUrl || !info) {
    fail('upload-interrupted', 'the server is not connected');
    return;
  }
  if (!info.capabilities.includes('recording_upload')) {
    fail('internal', 'this server does not accept recordings - update the localization server');
    return;
  }
  if (!dir) {
    fail('bad_recording', 'nothing to send - there is no recording on the phone');
    return;
  }
  const video = new File(dir, 'video.mp4');
  const session = new File(dir, 'session.jsonl');
  if (!video.exists || !session.exists) {
    fail('bad_recording', `${dir.name} has no video.mp4 / session.jsonl`);
    return;
  }
  // "Send again" finds the scan by this, also after a restart of the app.
  prefsActions.set({ lastCapture: JSON.stringify({ dir: dir.name, ...target }) });

  const form = new FormData();
  form.append('video', filePart(video, 'video.mp4', 'video/mp4') as never);
  form.append('session_jsonl', filePart(session, 'session.jsonl', 'application/x-ndjson') as never);
  // The engine's own mesh file (world_mesh.bin) is not sent: the app converts it to PLY.
  const mesh = new File(dir, 'world_mesh.ply');
  let total = Number(video.size ?? 0) + Number(session.size ?? 0);
  if (mesh.exists) {
    form.append('mesh', filePart(mesh, mesh.name, 'application/octet-stream') as never);
    form.append('mesh_format', 'ply');
    total += Number(mesh.size ?? 0);
  }
  if (target.replace) {
    form.append('replace', 'true');
  }
  form.append('device_id', getDeviceId());
  form.append('label', target.label);

  log(`sending ${dir.name} (${megabytes(total)}) as map "${target.mapId}"${target.replace ? ' (replacing it)' : ''}`);
  roomActions.setBuild({ megabytes: Math.max(1, Math.round(total / 1e6)) });
  roomActions.setUpload({ phase: 'uploading', text: `sending ${megabytes(total)}...`, progress: 0 });

  const abort = new AbortController();
  uploadAbort = abort;
  let lastPercent = -1;
  let lastQuarter = 0;
  const uploadStarted = Date.now();
  const accepted = await uploadRecording(baseUrl, target.mapId, form, {
    signal: abort.signal,
    onProgress: (sent, all) => {
      // The platform has been seen to report a total smaller than what is sent (the log
      // of the first pass counted up to 175 %): the size of the files is the floor.
      const whole = Math.max(all, total);
      const fraction = whole > 0 ? Math.min(1, sent / whole) : 0;
      const percent = Math.round(fraction * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        roomActions.setBuild({ uploadFraction: fraction });
        roomActions.setUpload({ phase: 'uploading', text: `sending ${percent} % of ${megabytes(whole)}`, progress: fraction });
      }
      // In the log a line per quarter: a transfer that stalls shows as a missing one.
      const quarter = Math.floor(percent / 25);
      if (quarter > lastQuarter) {
        lastQuarter = quarter;
        log(`upload ${quarter * 25} % of ${megabytes(whole)} after ${((Date.now() - uploadStarted) / 1000).toFixed(0)} s`);
      }
    },
  });
  uploadAbort = null;

  let job: ServerJob | null = null;
  if (accepted.ok) {
    job = accepted.value;
    log(`recording accepted, build job ${job.jobId}`);
    prefsActions.set({ lastCapture: JSON.stringify({ dir: dir.name, ...target, jobId: job.jobId }) });
  } else if (abort.signal.aborted) {
    roomActions.setBuild({ phase: 'cancelled' });
    roomActions.setUpload({ phase: 'failed', text: 'cancelled', progress: null });
    log('upload cancelled');
    return;
  } else {
    if (accepted.status === 409) {
      // Either a build for this room is already running, and then that one is followed...
      job = await runningJobOf(baseUrl, target.mapId);
    }
    if (!job) {
      fail(failureFromUpload(accepted.status, accepted.code), `the server did not take the recording: ${accepted.reason}`);
      return;
    }
    log(`a build for "${target.mapId}" is already running (job ${job.jobId}); following it`);
  }
  roomActions.setBuild({ uploadFraction: 1 });

  const finished = await followJob(baseUrl, job);
  if (finished) {
    await finishBuild(baseUrl, target, finished, startedAt);
  }
}

/** Developer tools: the newest capture as the map "room". */
export function uploadLastCapture(): Promise<void> {
  const dir = getLastCaptureDir();
  return sendCapture({ mapId: DEFAULT_MAP_ID, label: `phone scan ${dir?.name ?? ''}`.trim(), replace: true }, dir);
}

/** The scan that was sent last and has not become a map yet, as remembered between launches. */
export function pendingCapture(): { dir: Directory; target: ScanTarget; jobId: string | null } | null {
  const saved = getPrefs().lastCapture;
  if (!saved) {
    return null;
  }
  try {
    const json = JSON.parse(saved) as Record<string, unknown>;
    if (typeof json.dir !== 'string' || typeof json.mapId !== 'string') {
      return null;
    }
    const dir = findCaptureDir(json.dir);
    if (!dir) {
      return null;
    }
    return {
      dir,
      target: { mapId: json.mapId, label: typeof json.label === 'string' ? json.label : '', replace: json.replace === true },
      jobId: typeof json.jobId === 'string' && json.jobId ? json.jobId : null,
    };
  } catch {
    return null;
  }
}

/** "Send again": the same scan once more, for the same room. */
export function sendAgain(): Promise<void> {
  const pending = pendingCapture();
  const target = getRoomScanState().build.target ?? pending?.target ?? null;
  if (!target) {
    fail('bad_recording', 'nothing to send again');
    return Promise.resolve();
  }
  return sendCapture(target, pending?.dir ?? getLastCaptureDir());
}

/**
 * Takes up a build again after contact with the server was lost: asks for the job and,
 * if the server answers, follows it to its end.
 */
export async function resumeBuild(): Promise<void> {
  const { build } = getRoomScanState();
  const baseUrl = serverConnection.getBaseUrl();
  if (uploadAbort || activeJobId || !baseUrl || !build.jobId || !build.target) {
    return;
  }
  if (build.phase !== 'failed' || build.failure !== 'lost-contact') {
    return;
  }
  const job = await getJob(baseUrl, build.jobId, { timeoutMs: JOB_POLL_TIMEOUT_MS });
  // Asked again by several callers: only the first answer takes the build up.
  const now = getRoomScanState().build;
  if (!job.ok || uploadAbort || activeJobId || now.phase !== 'failed' || now.failure !== 'lost-contact') {
    return;
  }
  log(`contact with the server is back; build job ${job.value.jobId} is ${job.value.state}`);
  roomActions.setBuild({ phase: 'running', failure: null });
  const startedAt = Date.now();
  const finished = await followJob(baseUrl, job.value);
  if (finished) {
    await finishBuild(baseUrl, build.target, finished, startedAt);
  }
}

let recovering = false;

/**
 * After a restart of the app (Android may end an app that was put aside for the twenty
 * minutes a build can take): the build that was started for the scan sent last is looked
 * up on the server by its job id. Still running - it is followed again and Home shows
 * its progress; finished - the room is there; failed - Home says so. Nothing is asked
 * when no such build is remembered, or one is being followed already.
 */
export async function recoverBuild(): Promise<void> {
  const baseUrl = serverConnection.getBaseUrl();
  const pending = pendingCapture();
  if (recovering || uploadAbort || activeJobId || !baseUrl || !pending?.jobId) {
    return;
  }
  if (getRoomScanState().build.phase !== 'idle') {
    return;
  }
  recovering = true;
  try {
    const { target, jobId, dir } = pending;
    const answer = await getJob(baseUrl, jobId, { timeoutMs: JOB_POLL_TIMEOUT_MS });
    if (uploadAbort || activeJobId || getRoomScanState().build.phase !== 'idle') {
      return;
    }
    if (!answer.ok) {
      if (answer.status !== 404) {
        return; // no answer now: asked again later
      }
      // The server no longer knows the job. If it has the room, the build did finish.
      forgetJobOfCapture();
      const listed = (serverConnection.getView().connection.info?.maps ?? []).includes(target.mapId);
      if (listed && !target.replace) {
        log(`build job ${jobId} is not known to the server any more, and room "${target.mapId}" is there: taken as built`);
        prefsActions.set({ lastRoomId: target.mapId, lastCapture: null });
        void roomsActions.refresh();
      } else {
        roomActions.setBuild({ phase: 'failed', target, jobId, uploadFraction: 1 });
        fail('server_restarted', `build job ${jobId} is not known to the server any more`);
      }
      return;
    }
    const job = answer.value;
    log(`after a restart of the app: build job ${job.jobId} of "${target.mapId}" is ${job.state}`);
    roomActions.resetBuild();
    roomActions.setBuild({
      phase: 'running',
      target,
      jobId: job.jobId,
      uploadFraction: 1,
      jobProgress: job.progress,
      megabytes: Math.max(1, Math.round(Number(new File(dir, 'video.mp4').size ?? 0) / 1e6)),
    });
    const startedAt = Date.now();
    const finished = isFinalJobState(job.state) ? job : await followJob(baseUrl, job);
    if (finished) {
      await finishBuild(baseUrl, target, finished, startedAt);
    }
  } finally {
    recovering = false;
  }
}

/**
 * For Home and the build screen: a build that was lost sight of - contact with the
 * server lost for a while, the phone put aside with its screen off, the app restarted -
 * is taken up again as soon as the server answers, when the app comes to the front, and
 * every few seconds in between. Asks the server only when there is such a build.
 */
export function useBuildFollowUp(connected: boolean): void {
  useEffect(() => {
    if (!connected) {
      return undefined;
    }
    const again = () => {
      void resumeBuild();
      void recoverBuild();
    };
    again();
    const timer = setInterval(again, FOLLOW_UP_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        again();
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [connected]);
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
  } else if (isBuilding(getRoomScanState().build)) {
    // Nothing is in flight any more: only the screen is behind.
    roomActions.setBuild({ phase: 'cancelled' });
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
export async function localizeWithClip(
  mapId: string,
  sessionId: string,
  /** Told what the look is doing, for the screen: recording, sending, waiting for the answer. */
  onStage: (stage: 'recording' | 'sending' | 'thinking') => void = () => undefined,
): Promise<LocalizeResult> {
  const baseUrl = serverConnection.getBaseUrl();
  if (!baseUrl) {
    return { kind: 'failed', reason: 'the server is not connected' };
  }
  onStage('recording');
  const clip = await recordClip(CLIP_SECONDS);
  if ('error' in clip) {
    return { kind: 'failed', reason: clip.error };
  }
  // From here to the answer the server may be too busy for health checks: it is not gone.
  const release = serverConnection.hold();
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
    onStage('sending');
    let sent = false;
    const answer = await localize(baseUrl, form, {
      timeoutMs: LOCALIZE_TIMEOUT_MS,
      onProgress: (bytes, all) => {
        if (!sent && all > 0 && bytes >= all) {
          sent = true;
          onStage('thinking');
        }
      },
    });
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
    release();
    removeQuietly(clip.dir);
  }
}
