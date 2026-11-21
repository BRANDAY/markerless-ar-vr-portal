/**
 * The cloud anchor calls of ViroReact's `arSceneNavigator`, behind a small typed surface.
 *
 * The app hands providers the navigator as `unknown` (`LocalizationContext`), and the
 * results cross the native bridge as untyped objects. This file checks both, so the rest
 * of the cloud code works with values it can rely on. No ViroReact import: the calls are
 * found by name (`hostCloudAnchor`, `resolveCloudAnchor`, `cancelCloudAnchorOperations`,
 * ViroReact 3.2.2 `components/AR/ViroARSceneNavigator.tsx:1042-1095`).
 */
import type { RigidPose, Vec3 } from './anchorMath';

export type HostOutcome =
  | { ok: true; cloudAnchorId: string }
  /** `state` is a `ViroCloudAnchorState` string, or 'Exception' when the call threw. */
  | { ok: false; state: string; error: string };

export type ResolveOutcome =
  | { ok: true; pose: RigidPose }
  | { ok: false; state: string; error: string };

export interface CloudAnchorApi {
  /** Uploads the local anchor `anchorId`; the service keeps it for `ttlDays` (1..365). */
  host(anchorId: string, ttlDays: number): Promise<HostOutcome>;
  /** Looks for a hosted anchor from the current camera view. */
  resolve(cloudAnchorId: string): Promise<ResolveOutcome>;
  /** Stops every host / resolve that is running. */
  cancel(): void;
}

type AnyFunction = (...args: unknown[]) => unknown;

function method(target: unknown, name: string): AnyFunction | null {
  if (typeof target !== 'object' || target === null) {
    return null;
  }
  const value = (target as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as AnyFunction).bind(target) : null;
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }
  const v = value.slice(0, 3);
  return v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A `ViroHostCloudAnchorResult` as it arrived over the bridge. */
export function readHostResult(raw: unknown): HostOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, state: 'ErrorInternal', error: 'the host call returned nothing' };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.cloudAnchorId === 'string' ? r.cloudAnchorId.trim() : '';
  if (r.success === true && id) {
    return { ok: true, cloudAnchorId: id };
  }
  const state = text(r.state, 'ErrorInternal');
  return {
    ok: false,
    // "Success" without an id is still a failure for us.
    state: state === 'Success' ? 'ErrorInternal' : state,
    error: text(r.error, r.success === true ? 'the service returned no anchor id' : state),
  };
}

/** A `ViroResolveCloudAnchorResult` as it arrived over the bridge. */
export function readResolveResult(raw: unknown): ResolveOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, state: 'ErrorInternal', error: 'the resolve call returned nothing' };
  }
  const r = raw as Record<string, unknown>;
  const state = text(r.state, 'ErrorInternal');
  if (r.success !== true) {
    return { ok: false, state: state === 'Success' ? 'ErrorInternal' : state, error: text(r.error, state) };
  }
  const anchor = (typeof r.anchor === 'object' && r.anchor !== null ? r.anchor : {}) as Record<string, unknown>;
  const position = asVec3(anchor.position);
  const rotation = asVec3(anchor.rotation);
  if (!position || !rotation) {
    return { ok: false, state: 'ErrorInternal', error: 'the resolved anchor has no usable pose' };
  }
  return { ok: true, pose: { position, rotation } };
}

/**
 * The cloud anchor calls of a ViroReact `arSceneNavigator`, or null when the object does
 * not have them (the AR view is not mounted, or a library version without cloud anchors).
 * A call that throws or rejects becomes a failed outcome with state 'Exception'.
 */
export function cloudAnchorApiFrom(navigator: unknown): CloudAnchorApi | null {
  const host = method(navigator, 'hostCloudAnchor');
  const resolve = method(navigator, 'resolveCloudAnchor');
  if (!host || !resolve) {
    return null;
  }
  const cancel = method(navigator, 'cancelCloudAnchorOperations');
  return {
    async host(anchorId, ttlDays) {
      try {
        return readHostResult(await host(anchorId, ttlDays));
      } catch (error) {
        return { ok: false, state: 'Exception', error: errorText(error) };
      }
    },
    async resolve(cloudAnchorId) {
      try {
        return readResolveResult(await resolve(cloudAnchorId));
      } catch (error) {
        return { ok: false, state: 'Exception', error: errorText(error) };
      }
    },
    cancel() {
      try {
        cancel?.();
      } catch {
        // Nothing was running, or the view is already gone.
      }
    },
  };
}

// ---- what a failure means -------------------------------------------------------------------

export type FailureReason =
  /** The place was not recognised from the current view: look around and try again. */
  | 'not-recognised'
  /** Too little was seen around the anchor to host it: look at the place from more sides. */
  | 'poor-view'
  /** No internet, or the service did not answer. */
  | 'network'
  /** The service's request limit was hit. */
  | 'quota'
  /** The anchor is no longer in the service (expired or deleted). */
  | 'gone'
  /** The build is not authorised in the service's project (key, signing certificate, plan). */
  | 'not-authorised'
  /** The AR library on the phone and the service do not fit together. */
  | 'incompatible'
  /** This build has no cloud anchors at all (provider "none", unsupported platform). */
  | 'not-supported'
  | 'unknown';

export interface Failure {
  reason: FailureReason;
  /** True when trying again by itself can help. */
  retry: boolean;
  /** One sentence for the log and the status detail. */
  text: string;
}

/**
 * What a failed host or resolve means. `state` is a `ViroCloudAnchorState`
 * (`components/Types/ViroEvents.ts:462-499`), 'Timeout' (set by our own time limit) or
 * 'Exception'. Unknown states are retried: a new library version may add some.
 */
export function classifyFailure(state: string, error = ''): Failure {
  switch (state) {
    case 'ErrorResolvingLocalizationNoMatch':
    case 'Timeout':
    case 'TaskInProgress':
    case 'None':
    case 'ErrorCancelled':
      return { reason: 'not-recognised', retry: true, text: 'the place was not recognised from this view' };
    case 'ErrorHostingInsufficientVisualFeatures':
    case 'ErrorHostingDatasetProcessingFailed':
      return { reason: 'poor-view', retry: true, text: 'too little of the place was seen to save it' };
    case 'ErrorNetworkFailure':
    case 'ErrorHostingServiceUnavailable':
    case 'ErrorInternal':
      return { reason: 'network', retry: true, text: 'the cloud service did not answer' };
    case 'ErrorResourceExhausted':
      return { reason: 'quota', retry: true, text: 'the request limit of the cloud service was reached' };
    case 'ErrorCloudIdNotFound':
    case 'ErrorAnchorExpired':
      return { reason: 'gone', retry: false, text: 'the saved anchor is no longer in the cloud service' };
    case 'ErrorNotAuthorized':
    case 'ErrorAuthenticationFailed':
      return { reason: 'not-authorised', retry: false, text: 'this build is not authorised in the cloud service' };
    case 'ErrorResolvingSdkVersionTooOld':
    case 'ErrorResolvingSdkVersionTooNew':
      return { reason: 'incompatible', retry: false, text: 'the AR library of this phone does not fit the saved anchor' };
    case 'ErrorNotSupported':
      return { reason: 'not-supported', retry: false, text: 'cloud anchors are not available in this build' };
    case 'Exception':
      // The native side of ViroReact answers a disabled provider with a rejected call.
      return /disabled|not signed in|api key|provider/i.test(error)
        ? { reason: 'not-supported', retry: false, text: 'cloud anchors are switched off in this build' }
        : { reason: 'unknown', retry: true, text: 'the cloud anchor call failed' };
    default:
      return { reason: 'unknown', retry: true, text: `the cloud service answered "${state}"` };
  }
}
