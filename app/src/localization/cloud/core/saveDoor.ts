/**
 * Saving the doorway that is on screen as a cloud anchor ("hosting"). Done once per room
 * by the staff, while another provider (the self-hosted server, or placement by hand)
 * shows the doorway.
 *
 * Steps:
 *  1. a local AR anchor is made on the floor under the doorway;
 *  2. the service uploads what the camera has seen around it and returns an id;
 *  3. the anchor is looked up once in the same session. That proves it can be found, and
 *     gives its pose measured the same way every later session will measure it;
 *  4. the doorway pose is written down relative to that anchor pose.
 *
 * Everything the function needs comes in through `deps`, so it is unit-tested with fakes.
 */
import { applyRelative, distanceM, relativeTo, type RigidPose, tiltDeg } from './anchorMath';
import { classifyFailure, type CloudAnchorApi, type Failure } from './cloudAnchorApi';
import { type CloudDoorRecord, type CloudService, RECORD_VERSION } from './doorRecord';
import type { LocalAnchorSource } from './localAnchor';

/** Runs `fn` after `delayMs`; the returned function cancels it. */
export type Schedule = (fn: () => void, delayMs: number) => () => void;

export type SaveStep = 'anchoring' | 'uploading' | 'checking';

export interface SaveDoorDeps {
  api: CloudAnchorApi;
  anchors: LocalAnchorSource;
  now(): number;
  schedule: Schedule;
  log(message: string): void;
  /** For a progress line on screen. */
  onStep?(step: SaveStep): void;
}

export interface SaveDoorInput {
  service: CloudService;
  /** Doorway pose on screen, AR world of the current session. */
  door: RigidPose;
  opening: { width: number; height: number } | null;
  doorSource: 'server' | 'by-hand';
  roomId: string | null;
  /** Lifetime to ask for, days (1..365). More than 1 needs keyless authorisation at Google. */
  ttlDays: number;
}

export interface SaveDoorOptions {
  /** Uploading may take this long before it is given up. */
  uploadTimeoutMs: number;
  /** The look-up of step 3 may take this long. */
  checkTimeoutMs: number;
  /**
   * When the service refuses the asked lifetime as "not authorised", ask once more for
   * 1 day. That is what a build with an API key is allowed; the result says so.
   */
  shortLifetimeFallback: boolean;
}

export const DEFAULT_SAVE_OPTIONS: SaveDoorOptions = {
  uploadTimeoutMs: 90_000,
  checkTimeoutMs: 40_000,
  shortLifetimeFallback: true,
};

/** The saved offset and the look-up of step 3 may disagree by this much without a warning. */
export const CHECK_WARNING_M = 0.15;
/** A doorway farther than this from its anchor gets a warning: small anchor errors grow with distance. */
export const LEVER_WARNING_M = 3;

export type SaveDoorResult =
  | {
      ok: true;
      record: CloudDoorRecord;
      /** The anchor was found again in step 3. */
      checked: boolean;
      /** Distance between the local anchor and where step 3 found it, when both are known. */
      checkOffsetM: number | null;
      /** Things the staff should know (short lifetime, not checked...). */
      warnings: string[];
    }
  | {
      ok: false;
      step: SaveStep;
      failure: Failure;
      /** Service state behind the failure, for the log. */
      state: string;
      /** Set when an anchor was uploaded but the save still failed: it stays in the service until it expires. */
      cloudAnchorId: string | null;
    };

/** `promise`, or `onTimeout()` when it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, schedule: Schedule, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const cancel = schedule(() => {
      if (!done) {
        done = true;
        resolve(onTimeout());
      }
    }, ms);
    promise.then((value) => {
      if (!done) {
        done = true;
        cancel();
        resolve(value);
      }
    });
  });
}

export async function saveDoor(
  deps: SaveDoorDeps,
  input: SaveDoorInput,
  options: Partial<SaveDoorOptions> = {},
): Promise<SaveDoorResult> {
  const opts = { ...DEFAULT_SAVE_OPTIONS, ...options };
  const { api, log } = deps;
  const warnings: string[] = [];

  // 1. A local anchor under the doorway.
  deps.onStep?.('anchoring');
  const local = await deps.anchors.anchorNear(input.door.position);
  if (!local) {
    return {
      ok: false,
      step: 'anchoring',
      state: 'NoLocalAnchor',
      cloudAnchorId: null,
      failure: { reason: 'poor-view', retry: true, text: 'no surface was found at the doorway - let the phone see the floor there' },
    };
  }
  log(`cloud: local anchor ${local.anchorId} (${local.origin})`);

  // 2. Upload.
  deps.onStep?.('uploading');
  const upload = (ttlDays: number) =>
    withTimeout(api.host(local.anchorId, ttlDays), opts.uploadTimeoutMs, deps.schedule, () => {
      api.cancel();
      return { ok: false as const, state: 'Timeout', error: 'uploading took too long' };
    });
  let ttlDays = Math.max(1, Math.min(365, Math.floor(input.ttlDays)));
  let hosted = await upload(ttlDays);
  if (!hosted.ok && ttlDays > 1 && opts.shortLifetimeFallback && classifyFailure(hosted.state, hosted.error).reason === 'not-authorised') {
    log(`cloud: a ${ttlDays}-day anchor was refused (${hosted.state}); asking for 1 day`);
    const short = await upload(1);
    if (short.ok) {
      hosted = short;
      ttlDays = 1;
      warnings.push(
        'The service accepted only a 1-day anchor: this build is authorised with an API key. Anchors that last up to 365 days need keyless authorisation.',
      );
    }
  }
  if (!hosted.ok) {
    const failure =
      hosted.state === 'Timeout'
        ? { reason: 'network' as const, retry: true, text: 'saving took too long - check the internet connection' }
        : classifyFailure(hosted.state, hosted.error);
    log(`cloud: hosting failed: ${hosted.state} ${hosted.error}`);
    return { ok: false, step: 'uploading', state: hosted.state, cloudAnchorId: null, failure };
  }
  const cloudAnchorId = hosted.cloudAnchorId;
  const hostedAtMs = deps.now();
  log(`cloud: anchor hosted for ${ttlDays} day(s)`);

  // 3. Look it up once in this session.
  deps.onStep?.('checking');
  const found = await withTimeout(api.resolve(cloudAnchorId), opts.checkTimeoutMs, deps.schedule, () => {
    api.cancel();
    return { ok: false as const, state: 'Timeout', error: 'the anchor was not found again in time' };
  });
  let anchorPose: RigidPose;
  let checkOffsetM: number | null = null;
  if (found.ok) {
    anchorPose = found.pose;
    if (local.pose) {
      checkOffsetM = distanceM(local.pose.position, found.pose.position);
      log(`cloud: the hosted anchor was found again ${(checkOffsetM * 100).toFixed(0)} cm from the local one`);
      if (checkOffsetM > CHECK_WARNING_M) {
        warnings.push(
          `The anchor was found ${(checkOffsetM * 100).toFixed(0)} cm from where it was made. The doorway may be off by that much in later sessions.`,
        );
      }
    }
  } else if (local.pose) {
    anchorPose = local.pose;
    log(`cloud: the hosted anchor was not found again (${found.state}); using the local anchor pose`);
    warnings.push('The saved anchor could not be found again right away. Check it by restarting the app before relying on it.');
  } else {
    log(`cloud: the hosted anchor was not found again (${found.state}) and its pose is unknown`);
    return { ok: false, step: 'checking', state: found.state, cloudAnchorId, failure: classifyFailure(found.state, found.error) };
  }

  // 4. The doorway relative to the anchor.
  const doorInAnchor = relativeTo(anchorPose, input.door);
  const rebuilt = applyRelative(anchorPose, doorInAnchor);
  if (!doorInAnchor.position.every(Number.isFinite) || distanceM(rebuilt.position, input.door.position) > 0.01) {
    return {
      ok: false,
      step: 'checking',
      state: 'BadAnchorPose',
      cloudAnchorId,
      failure: { reason: 'unknown', retry: true, text: 'the anchor pose is not usable' },
    };
  }
  const lever = Math.hypot(...doorInAnchor.position);
  if (lever > LEVER_WARNING_M) {
    warnings.push(`The anchor is ${lever.toFixed(1)} m from the doorway. Save again with the floor under the doorway in view.`);
  }
  log(`cloud: doorway ${lever.toFixed(2)} m from its anchor, anchor tilt ${tiltDeg(anchorPose.rotation).toFixed(1)} deg`);

  return {
    ok: true,
    checked: found.ok,
    checkOffsetM,
    warnings,
    record: {
      version: RECORD_VERSION,
      service: input.service,
      cloudAnchorId,
      roomId: input.roomId,
      doorInAnchor,
      opening: input.opening,
      doorSource: input.doorSource,
      hostedAtMs,
      ttlDays,
    },
  };
}
