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

  door: PoseUpdate | null;
  providerId: ProviderId;
  providerStatus: LocalizationStatus;
  providerDetail: string;
  /** Incremented by the UI to ask the active provider to re-localize / re-place. */
  relocalizeNonce: number;

  attachMode: AttachMode;
  overlayVisible: boolean;
  logVisible: boolean;
  log: LogEntry[];
}

const MAX_LOG_ENTRIES = 200;
const startedAtMs = Date.now();

let state: AppState = {
  trackingState: 'unavailable',
  trackingReason: '',
  cameraPosition: null,
  cameraForward: null,
  floorY: null,

  mode: 'AR',

  door: null,
  providerId: 'manual',
  providerStatus: 'idle',
  providerDetail: '',
  relocalizeNonce: 0,

  attachMode: 'direct',
  overlayVisible: true,
  logVisible: true,
  log: [],
};

const listeners = new Set<() => void>();
let nextLogId = 1;

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
    const entry: LogEntry = { id: nextLogId++, t: (Date.now() - startedAtMs) / 1000, text };
    // Mirrored to logcat (tag ReactNativeJS) so a device session can be analysed afterwards.
    console.log(`[portal] ${entry.t.toFixed(1)}s ${text}`);
    const log = [...state.log, entry];
    setState({ log: log.length > MAX_LOG_ENTRIES ? log.slice(-MAX_LOG_ENTRIES) : log });
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
