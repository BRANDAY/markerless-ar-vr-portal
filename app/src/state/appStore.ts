/**
 * Tiny app-wide store shared by the ViroReact scene and the React Native overlay.
 *
 * The two live in different React trees (the scene is rendered by the
 * `ViroARSceneNavigator`), so plain props/context are awkward; an external store
 * with `useSyncExternalStore` keeps both sides in sync without extra libraries.
 *
 * `door` is THE single place holding the doorway pose: providers write it through
 * `setDoorPose`, the portal reads it. Nothing else positions the portal.
 */
import { useSyncExternalStore } from 'react';

import type {
  LocalizationStatus,
  PoseUpdate,
  ProviderId,
  TrackingState,
  Vec3,
} from '../localization/types';

export type ViewMode = 'AR' | 'VR';

/**
 * How the portal is attached to the scene graph (debug switch):
 *  - 'direct': the ViroPortalScene is a direct child of ViroARScene and carries the pose itself.
 *  - 'parent': a parent ViroNode carries the pose, the ViroPortalScene sits under it at identity.
 */
export type AttachMode = 'direct' | 'parent';

/**
 * What is behind the portal:
 *  - 'sponza': the atrium of the Sponza Palace (`src/environments/SponzaAtrium.tsx`);
 *  - 'test-room': the small room made of primitives from stage 1 (loads instantly; kept to
 *    tell a portal problem from a problem with the big model).
 */
export type EnvironmentId = 'sponza' | 'test-room';

/**
 * The door frame of the portal:
 *  - 'casing': the wooden casing built from parts that are stretched only along their own
 *    length, with a plank door (`src/environments/DoorCasing.tsx`);
 *  - 'simple': the one-piece frame from stage 1, scaled as a whole (its posts change
 *    thickness with the doorway). Seen working on a device; kept to tell a problem of the
 *    casing from a problem of the portal.
 */
export type FrameId = 'casing' | 'simple';

/**
 * The screens of the app (`docs/product/ui-spec.md`, section 4). There is no navigation
 * library: the current screen and the way back are part of this store. `ar` covers three
 * situations of one screen (finding the room, door in the room, inside the space), which
 * are derived from the provider status and the AR / VR mode.
 */
export type Screen =
  | 'welcome'
  | 'permission'
  | 'connect'
  | 'home'
  | 'scanPrepare'
  | 'scan'
  | 'build'
  | 'roomResult'
  | 'ar'
  | 'spaces'
  | 'rooms'
  | 'settings'
  | 'visitor'
  | 'problem'
  | 'diagnostics'
  | 'privacy'
  | 'credits';

/** Problems that take the whole screen (section 7.1). */
export type ProblemKind = 'camera' | 'device' | 'server' | 'wifi' | 'version';

export interface LogEntry {
  id: number;
  /** Seconds since app start. */
  t: number;
  text: string;
}

export interface AppState {
  trackingState: TrackingState;
  trackingReason: string;
  cameraPosition: Vec3 | null;
  cameraForward: Vec3 | null;
  floorY: number | null;

  mode: ViewMode;

  /** The screen shown, and the screens "back" leads through (oldest first). */
  screen: Screen;
  history: Screen[];
  /** Which problem the `problem` screen shows. */
  problem: ProblemKind | null;

  door: PoseUpdate | null;
  providerId: ProviderId;
  providerStatus: LocalizationStatus;
  providerDetail: string;
  /** Incremented by the UI to ask the active provider to re-localize / re-place. */
  relocalizeNonce: number;

  attachMode: AttachMode;
  environment: EnvironmentId;
  frame: FrameId;
  overlayVisible: boolean;
  logVisible: boolean;
  log: LogEntry[];
}

const MAX_LOG_ENTRIES = 200;
/** `Date.now()` when the app's JavaScript started (about a second after the icon was tapped). */
export const APP_STARTED_AT_MS = Date.now();
const startedAtMs = APP_STARTED_AT_MS;

let state: AppState = {
  trackingState: 'unavailable',
  trackingReason: '',
  cameraPosition: null,
  cameraForward: null,
  floorY: null,

  mode: 'AR',

  screen: 'ar',
  history: [],
  problem: null,

  door: null,
  providerId: 'manual',
  providerStatus: 'idle',
  providerDetail: '',
  relocalizeNonce: 0,

  attachMode: 'direct',
  environment: 'sponza',
  frame: 'casing',
  // The developer tools over the camera; shown only with developer options on.
  overlayVisible: false,
  logVisible: true,
  log: [],
};

const listeners = new Set<() => void>();
let nextLogId = 1;

type LogListener = (text: string, timeMs: number) => void;
const logListeners = new Set<LogListener>();

/** Called for every line of the event log, e.g. to forward it to the server's monitoring panel. */
export function addLogListener(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppState(): AppState {
  return state;
}

/** Subscribe a component to one slice of the state. Selectors must return stored values, not new objects. */
export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export const appActions = {
  log(text: string): void {
    const now = Date.now();
    const entry: LogEntry = { id: nextLogId++, t: (now - startedAtMs) / 1000, text };
    logListeners.forEach((listener) => listener(text, now));
    // Mirrored to logcat (tag ReactNativeJS) so a device session can be analysed afterwards.
    console.log(`[portal] ${entry.t.toFixed(1)}s ${text}`);
    const log = [...state.log, entry];
    setState({ log: log.length > MAX_LOG_ENTRIES ? log.slice(-MAX_LOG_ENTRIES) : log });
  },

  /**
   * A machine-readable line for the device log and logcat only: it would only clutter
   * the small log on the screen.
   */
  logData(text: string): void {
    const now = Date.now();
    logListeners.forEach((listener) => listener(text, now));
    console.log(`[portal] ${((now - startedAtMs) / 1000).toFixed(1)}s ${text}`);
  },

  setTracking(trackingState: TrackingState, trackingReason: string): void {
    if (trackingState !== state.trackingState || trackingReason !== state.trackingReason) {
      setState({ trackingState, trackingReason });
    }
  },

  setCamera(cameraPosition: Vec3, cameraForward: Vec3): void {
    setState({ cameraPosition, cameraForward });
  },

  setFloorY(floorY: number | null): void {
    if (floorY !== state.floorY) {
      setState({ floorY });
    }
  },

  setMode(mode: ViewMode): void {
    if (mode !== state.mode) {
      setState({ mode });
    }
  },

  // ---- screens --------------------------------------------------------------------------

  /** Opens a screen; "back" returns to the current one. */
  go(screen: Screen): void {
    if (screen !== state.screen) {
      setState({ screen, history: [...state.history, state.screen] });
    }
  },

  /** Opens a screen in place of the current one: "back" skips the current one. */
  replace(screen: Screen): void {
    if (screen !== state.screen) {
      setState({ screen });
    }
  },

  /** Opens a screen as the start of a new path: there is nothing to go back to. */
  resetTo(screen: Screen): void {
    setState({ screen, history: [] });
  },

  /** One screen back. False when there is none (the caller then leaves the app). */
  back(): boolean {
    const previous = state.history[state.history.length - 1];
    if (previous === undefined) {
      return false;
    }
    setState({ screen: previous, history: state.history.slice(0, -1) });
    return true;
  },

  showProblem(problem: ProblemKind): void {
    setState({ problem });
    appActions.go('problem');
  },

  /** The only writer of the doorway pose. Called with every provider update. */
  setDoorPose(door: PoseUpdate | null): void {
    setState({ door });
  },

  setProvider(providerId: ProviderId): void {
    if (providerId !== state.providerId) {
      setState({ providerId, providerStatus: 'idle', providerDetail: '', door: null, mode: 'AR' });
    }
  },

  setProviderStatus(providerStatus: LocalizationStatus, providerDetail: string): void {
    setState({ providerStatus, providerDetail });
  },

  requestRelocalize(): void {
    setState({ relocalizeNonce: state.relocalizeNonce + 1 });
  },

  setAttachMode(attachMode: AttachMode): void {
    if (attachMode !== state.attachMode) {
      // Re-mounting the portal resets the native "inside the portal" state.
      setState({ attachMode, mode: 'AR' });
    }
  },

  setEnvironment(environment: EnvironmentId): void {
    if (environment !== state.environment) {
      // The portal is re-mounted with the new world; that resets "inside the portal".
      setState({ environment, mode: 'AR' });
    }
  },

  setFrame(frame: FrameId): void {
    if (frame !== state.frame) {
      // Re-mounted like a change of the world.
      setState({ frame, mode: 'AR' });
    }
  },

  toggleOverlay(): void {
    setState({ overlayVisible: !state.overlayVisible });
  },

  toggleLog(): void {
    setState({ logVisible: !state.logVisible });
  },

  clearLog(): void {
    setState({ log: [] });
  },
};
