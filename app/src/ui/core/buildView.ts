/**
 * Building the map (`docs/product/ui-spec.md`, 5.7 and 7.2): one percentage for upload
 * and build together, the five steps shown, the time line, and what to say when it
 * fails. Pure.
 */
import type { TextKey } from '../../i18n';
import type { ScanQuality } from '../../server/core/roomPlan';

/** The upload is the first 8 % of the whole. */
const UPLOAD_SHARE = 8;

/** 0..100 for an upload in progress. */
export function uploadPercent(uploadFraction: number): number {
  return Math.round(UPLOAD_SHARE * clamp01(uploadFraction));
}

/** 0..100 for a build job with the server's own progress 0..1. */
export function buildPercent(jobProgress: number): number {
  return Math.round(UPLOAD_SHARE + (100 - UPLOAD_SHARE) * clamp01(jobProgress));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** The steps as the user sees them, with the percentage at which each is done. */
export const BUILD_STEPS: { key: TextKey; doneAt: number }[] = [
  { key: 'build.step.send', doneAt: 8 },
  { key: 'build.step.read', doneAt: 17 },
  { key: 'build.step.map', doneAt: 82 },
  { key: 'build.step.measure', doneAt: 89 },
  { key: 'build.step.doorway', doneAt: 100 },
];

/** Index (0-based) of the step in progress at a percentage; all done = the number of steps. */
export function currentStep(percent: number): number {
  const index = BUILD_STEPS.findIndex((step) => percent < step.doneAt);
  return index < 0 ? BUILD_STEPS.length : index;
}

/** The moments of a build in which something is still going on. */
export type BuildPhase = 'uploading' | 'queued' | 'running' | 'lost-contact';

/** The one percentage of the screen, from whichever part is in progress. */
export function percentOf(input: { phase: BuildPhase | 'done'; uploadFraction: number; jobProgress: number }): number {
  if (input.phase === 'done') {
    return 100;
  }
  if (input.phase === 'uploading') {
    return uploadPercent(input.uploadFraction);
  }
  // 100 is reserved for a finished build.
  return Math.min(99, buildPercent(input.jobProgress));
}

/** The line under the title: what is happening and, where known, how long it will take. */
export function timeLine(input: {
  phase: BuildPhase;
  percent: number;
  /** Upload progress 0..1. */
  uploadFraction: number;
  megabytes: number;
  queuePosition: number;
  etaSeconds: number | null;
}): { key: TextKey; params: Record<string, string | number> } {
  switch (input.phase) {
    case 'uploading':
      return { key: 'build.time.sending', params: { p: Math.round(clamp01(input.uploadFraction) * 100), n: input.megabytes } };
    case 'queued':
      return { key: 'build.time.queued', params: { n: Math.max(0, input.queuePosition) } };
    case 'lost-contact':
      return { key: 'build.time.lost', params: {} };
    case 'running': {
      if (input.etaSeconds !== null && input.etaSeconds >= 0) {
        if (input.etaSeconds < 60) {
          return { key: 'build.time.lessThanMinute', params: {} };
        }
        const minutes = Math.round(input.etaSeconds / 60);
        return minutes === 1 ? { key: 'build.time.minutes.one', params: {} } : { key: 'build.time.minutes', params: { m: minutes } };
      }
      return { key: 'build.time.step', params: { i: Math.min(BUILD_STEPS.length, currentStep(input.percent) + 1) } };
    }
  }
}

/** Why sending or building failed, as far as the screens tell cases apart. */
export type BuildFailure =
  | 'upload-interrupted'
  | 'too-large'
  | 'too_few_frames'
  | 'sfm_failed'
  | 'bad_recording'
  | 'out_of_memory'
  | 'server_restarted'
  | 'internal'
  | 'lost-contact';

export type BuildAction = 'send-again' | 'scan-again' | 'search-again' | 'not-now';

export interface BuildProblem {
  title: TextKey;
  body: TextKey;
  tip: TextKey | null;
  primary: BuildAction;
  secondary: BuildAction | null;
}

/** The problem screen of a failure (7.2). The scan stays on the phone in every case. */
export function buildProblem(failure: BuildFailure): BuildProblem {
  switch (failure) {
    case 'upload-interrupted':
      return { title: 'build.fail.upload.title', body: 'build.fail.upload.body', tip: null, primary: 'send-again', secondary: 'not-now' };
    case 'too-large':
      return { title: 'build.fail.large.title', body: 'build.fail.large.body', tip: null, primary: 'scan-again', secondary: null };
    case 'too_few_frames':
      return { title: 'build.fail.short.title', body: 'build.fail.short.body', tip: null, primary: 'scan-again', secondary: 'not-now' };
    case 'sfm_failed':
      return { title: 'build.fail.sfm.title', body: 'build.fail.sfm.body', tip: 'build.fail.short.body', primary: 'scan-again', secondary: 'not-now' };
    case 'bad_recording':
      return { title: 'build.fail.unreadable.title', body: 'build.fail.unreadable.body', tip: null, primary: 'scan-again', secondary: null };
    case 'out_of_memory':
      return { title: 'build.fail.memory.title', body: 'build.fail.memory.body', tip: null, primary: 'send-again', secondary: 'not-now' };
    case 'server_restarted':
      return { title: 'build.fail.restarted.title', body: 'build.fail.restarted.body', tip: null, primary: 'send-again', secondary: null };
    case 'lost-contact':
      return { title: 'problem.server.title', body: 'build.fail.contact.body', tip: null, primary: 'search-again', secondary: null };
    case 'internal':
      return { title: 'build.fail.internal.title', body: 'build.fail.internal.body', tip: null, primary: 'send-again', secondary: 'scan-again' };
  }
}

/** The failure for a server error code of a build job; anything unknown is `internal`. */
export function failureFromJobError(code: string | null | undefined): BuildFailure {
  switch (code) {
    case 'too_few_frames':
    case 'sfm_failed':
    case 'bad_recording':
    case 'out_of_memory':
    case 'server_restarted':
      return code;
    default:
      return 'internal';
  }
}

/**
 * The failure for an upload that was not accepted: the HTTP status (null without an
 * answer) and the server's `X-Error-Code`, if it sent one. Since server 0.3.0 a recording
 * that cannot become a map is refused at once with `recording_too_short` or
 * `too_little_motion`; the spec has one text for both ("The scan was too short").
 */
export function failureFromUpload(status: number | null, code?: string | null): BuildFailure {
  if (status === null) {
    return 'upload-interrupted';
  }
  if (status === 413) {
    return 'too-large';
  }
  if (code === 'recording_too_short' || code === 'too_little_motion') {
    return 'too_few_frames';
  }
  if (status === 422 || status === 400) {
    return 'bad_recording';
  }
  return 'internal';
}

/** No more than this many of the server's advice lines are shown. */
const MAX_ADVICE_LINES = 2;

/**
 * The server's opinion of the scan under "The map is ready": one line with its verdict
 * and score, one with its advice (in the server's own words). Both null when the server
 * said nothing - as every server does today (`ScanQuality` is a placeholder contract).
 */
export function qualityLines(quality: ScanQuality | null): {
  summary: { key: TextKey; params: Record<string, string | number> } | null;
  advice: string | null;
} {
  if (!quality) {
    return { summary: null, advice: null };
  }
  const p = quality.score === null ? null : Math.round(clamp01(quality.score) * 100);
  const verdict = quality.verdict;
  let summary: { key: TextKey; params: Record<string, string | number> } | null = null;
  if (verdict && p !== null) {
    summary = { key: 'build.done.quality.both', params: { verdict, p } };
  } else if (verdict) {
    summary = { key: 'build.done.quality.verdict', params: { verdict } };
  } else if (p !== null) {
    summary = { key: 'build.done.quality.score', params: { p } };
  }
  return { summary, advice: quality.advice.slice(0, MAX_ADVICE_LINES).join(' ') || null };
}

/** "4 min", "50 s": how long a build took. */
export function duration(seconds: number): { key: TextKey; params: Record<string, number> } {
  return seconds < 90
    ? { key: 'build.took.seconds', params: { s: Math.max(1, Math.round(seconds)) } }
    : { key: 'build.took.minutes', params: { m: Math.round(seconds / 60) } };
}
