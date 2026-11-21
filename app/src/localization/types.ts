/**
 * Localization layer: everything that decides WHERE the doorway stands.
 *
 * The rest of the app never talks to ARCore anchors, a VPS or a server directly.
 * It only consumes `PoseUpdate`s from the active `LocalizationProvider` and writes
 * them into the single door-pose slot of the app store (see `state/appStore.ts`).
 *
 * Coordinate conventions (identical to ViroReact, so a pose can be passed straight
 * to a node's `position` / `rotation` props):
 *  - "AR world" = the ARCore session frame of the CURRENT app session: right-handed,
 *    metres, +Y up (gravity aligned), origin and heading where the session started.
 *    It is different in every session - turning a persistent room pose into this
 *    frame is exactly the job of a provider.
 *  - `rotation` = Euler angles in DEGREES, [x, y, z], applied as R = Rz * Ry * Rx
 *    (column vectors). A doorway only needs yaw (rotation about Y).
 *  - The doorway's local frame: origin on the floor in the middle of the threshold,
 *    +Y up, the opening lies in the local XY plane, local +Z points to the "AR side"
 *    (where the user stands before walking in), the virtual room extends to -Z.
 */

export type Vec3 = [number, number, number];

export interface Pose {
  /** Metres, AR-world coordinates of the current session. */
  position: Vec3;
  /** Euler degrees [x, y, z], ViroReact order (R = Rz * Ry * Rx). */
  rotation: Vec3;
}

/** Latest known device camera pose in AR-world coordinates. */
export interface CameraPose {
  position: Vec3;
  /** Euler degrees as reported by ViroReact. Prefer `forward` / `up`: they are unambiguous. */
  rotation: Vec3;
  /** Unit vector the camera looks along. */
  forward: Vec3;
  /** Unit vector pointing out of the top of the camera image. */
  up: Vec3;
}

export type TrackingState = 'unavailable' | 'limited' | 'normal';

export type LocalizationStatus =
  /** Not started, or stopped. */
  | 'idle'
  /** Started, waiting for AR tracking to become usable. */
  | 'waiting-for-tracking'
  /** The provider's back-end (server) is not reachable yet; it keeps trying. */
  | 'waiting-for-server'
  /** The back-end is reachable, but no pose has been requested or produced yet. */
  | 'connected'
  /** Tracking is fine, the provider is working on a pose (scanning, uploading, resolving...). */
  | 'localizing'
  /** A pose has been delivered and is believed to be valid. */
  | 'localized'
  /** A pose was delivered earlier but can no longer be trusted (tracking loss, anchor lost). */
  | 'lost'
  /** The provider cannot work (missing configuration, network error, not implemented). */
  | 'error';

/**
 * The status in a form the interface can turn into words of its own: the `detail` text
 * of a status is written for the developer log, this is what the screens read.
 */
export interface StatusMeta {
  /** The attempt of the current search that is running or comes next, and how many are allowed. */
  attempt?: number;
  attempts?: number;
  /** Why the status is what it is, where the interface has to tell cases apart. */
  code?:
    | 'no-server'
    | 'connecting'
    | 'server-offline'
    | 'incompatible'
    | 'no-room'
    | 'no-doorway'
    | 'not-recognised'
    | 'unconfirmed'
    | 'tracking-lost'
    | 'scale-unknown';
  /**
   * A first doorway pose of this session is on its way to being confirmed: it came from
   * a weak answer and is being checked. The interface shows an outline, not the door.
   */
  pending?: boolean;
}

export interface PoseQuality {
  /** 0..1, provider specific. Undefined when the provider cannot tell. */
  confidence?: number;
  /** Estimated position error in metres, when available. */
  positionErrorM?: number;
  /** Estimated heading error in degrees, when available. */
  headingErrorDeg?: number;
  /** Free-form detail for the debug overlay ("floor: detected plane", "42 inliers"...). */
  note?: string;
}

export interface PoseUpdate {
  /** Doorway pose in AR-world coordinates of the current session. */
  pose: Pose;
  /**
   * Size of the real doorway at that pose, metres - when the provider knows it (a server
   * that found the opening in the room). The frame is then made to fit it.
   */
  opening?: { width: number; height: number };
  quality?: PoseQuality;
  /**
   * True when the provider moves a doorway that is already shown on its own account (a
   * correction after re-localisation), not because the user asked. Such a move waits
   * while the user is on the virtual side of the portal.
   */
  automatic?: boolean;
  /** Which provider produced the pose. */
  source: ProviderId;
  /** `Date.now()` at the moment the pose was computed. */
  timestampMs: number;
}

export type ProviderId =
  | 'manual'
  | 'reactvision-vps'
  | 'arcore-cloud-anchor'
  | 'self-hosted';

/**
 * How one search for the doorway ended, for the measurement log (`measure/`). Reported
 * AFTER the pose (if any) has been emitted, so the door on screen is already the new one.
 */
export interface LocalizationReport {
  /**
   *  - `placed`: a door was put where there was none; `moved`: the door on screen was moved;
   *  - `confirmed`: a new answer agreed with the door on screen;
   *  - `kept`: the search gave nothing better, the trusted door stays;
   *  - `not-found`: the room was not recognised, the attempts are used up;
   *  - `no-doorway`: the room was recognised, but it has no door opening.
   */
  event: 'placed' | 'moved' | 'confirmed' | 'kept' | 'not-found' | 'no-doorway';
  /** Why the doorway was looked for: start, recovery, manual, confirm, build, by-hand. */
  reason: string;
  /** Requests to the back-end this search took (0 when none was needed). */
  attempts: number;
  /** From the start of the search to this result; null when nothing was searched. */
  elapsedMs: number | null;
  /** False for a pose that is shown but still being confirmed. */
  trusted: boolean;
  /** The back-end's own description of its answer, when there is a back-end. */
  server?: {
    quality: string;
    inliers: number | null;
    /** How the back-end knows the doorway ("auto", "manual"...). */
    source: string | null;
    confidence: number | null;
  };
}

export type Unsubscribe = () => void;

/**
 * What a provider may ask from the running AR session. Implemented by the AR scene
 * (`ar/PortalARScene.tsx`); providers must not import ViroReact components themselves.
 */
export interface LocalizationContext {
  /** Latest camera pose, or null before the first camera transform arrived. */
  getCameraPose(): CameraPose | null;
  getTrackingState(): TrackingState;
  onTrackingState(listener: (state: TrackingState) => void): Unsubscribe;
  /**
   * World Y of the lowest horizontal plane detected so far (best guess for the floor),
   * or null when no horizontal plane has been detected yet.
   */
  getFloorY(): number | null;
  /**
   * Handle to ViroReact's `arSceneNavigator` object (cloud-anchor / VPS calls live there).
   * Typed loosely on purpose: only the ARCore and ReactVision providers need it.
   */
  getArSceneNavigator(): unknown;
  /** Writes a line to the on-screen event log. */
  log(message: string): void;
  /** Tells the measurement log how a search for the doorway ended. */
  reportLocalization(report: LocalizationReport): void;
}

export interface LocalizationProvider {
  readonly id: ProviderId;
  readonly displayName: string;

  /** Begin producing poses. Must be safe to call again after `stop()`. */
  start(context: LocalizationContext): void;
  /** Release listeners, timers and (later) network resources. */
  stop(): void;

  getStatus(): LocalizationStatus;
  /** Human-readable detail for the current status (error text, progress...). */
  getStatusDetail(): string;
  onStatus(listener: (status: LocalizationStatus, detail: string, meta: StatusMeta) => void): Unsubscribe;

  /**
   * Doorway pose stream. A provider may emit more than once: every emission moves
   * the whole portal (refinement, re-localization after tracking loss).
   */
  onPose(listener: (update: PoseUpdate) => void): Unsubscribe;

  /**
   * Ask the provider to compute the pose again from the current camera view.
   * Manual provider: re-place in front of the camera. Real providers: re-localize.
   */
  relocalize(): void;
}
