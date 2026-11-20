/**
 * State of the room scan, shared by the AR scene (which feeds plane anchors and draws the
 * highlights), the navigator (world-mesh switches) and the overlay (buttons, numbers).
 * Same pattern as `state/appStore.ts`.
 */
import { useSyncExternalStore } from 'react';

import { buildRoom, EMPTY_ROOM, type PlaneAnchorData, type RoomModel } from './roomGeometry';

/** What the AR engine says about its fused room mesh. */
export interface MeshInfo {
  available: boolean;
  /** Why not, when `available` is false. */
  reason: string;
  vertexCount: number;
  triangleCount: number;
  /** "depth", "plane", "monocular", "lidar" or "unknown". */
  source: string;
  accumulated: boolean;
}

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RoomScanState {
  /** Scan mode: highlights drawn, world mesh switched on. */
  scanning: boolean;
  /** The AR engine's own wireframe of the room mesh. */
  wireframe: boolean;
  room: RoomModel;
  planeCount: number;
  /** The AR engine reported that depth data is available. */
  depthReady: boolean;
  mesh: MeshInfo | null;
  recording: RecordingPhase;
  /** `Date.now()` when the running recording started. */
  recordingSince: number | null;
}

/** The room model is rebuilt at most this often while planes keep changing. */
const REBUILD_INTERVAL_MS = 300;

let state: RoomScanState = {
  scanning: false,
  wireframe: false,
  room: EMPTY_ROOM,
  planeCount: 0,
  depthReady: false,
  mesh: null,
  recording: 'idle',
  recordingSince: null,
};

const anchors = new Map<string, PlaneAnchorData>();
const listeners = new Set<() => void>();
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function setState(patch: Partial<RoomScanState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function scheduleRebuild(): void {
  if (rebuildTimer !== null) {
    return;
  }
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    setState({ room: buildRoom(anchors.values()), planeCount: anchors.size });
  }, REBUILD_INTERVAL_MS);
}

export function getRoomScanState(): RoomScanState {
  return state;
}

/** The plane anchors as last reported, for the capture export. */
export function getPlaneAnchors(): PlaneAnchorData[] {
  return Array.from(anchors.values());
}

export function useRoomScan<T>(selector: (s: RoomScanState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => selector(state),
    () => selector(state),
  );
}

export const roomActions = {
  /** Planes are collected all the time, so the scan starts with what is already known. */
  upsertPlane(anchor: PlaneAnchorData): void {
    anchors.set(anchor.anchorId, anchor);
    scheduleRebuild();
  },

  removePlane(anchorId: string): void {
    if (anchors.delete(anchorId)) {
      scheduleRebuild();
    }
  },

  clearPlanes(): void {
    anchors.clear();
    scheduleRebuild();
  },

  setScanning(scanning: boolean): void {
    if (scanning !== state.scanning) {
      setState(scanning ? { scanning } : { scanning, mesh: null });
    }
  },

  setWireframe(wireframe: boolean): void {
    if (wireframe !== state.wireframe) {
      setState({ wireframe });
    }
  },

  setDepthReady(): void {
    if (!state.depthReady) {
      setState({ depthReady: true });
    }
  },

  setMesh(mesh: MeshInfo | null): void {
    setState({ mesh });
  },

  setRecording(recording: RecordingPhase): void {
    setState({
      recording,
      recordingSince: recording === 'recording' ? (state.recordingSince ?? Date.now()) : null,
    });
  },
};
