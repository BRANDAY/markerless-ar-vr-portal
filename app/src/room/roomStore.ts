/**
 * State of the room scan, shared by the AR scene (which feeds plane anchors and draws the
 * highlights), the navigator (world-mesh switches) and the overlay (buttons, numbers).
 * Same pattern as `state/appStore.ts`.
 */
import { useSyncExternalStore } from 'react';

import type { MapInSession } from '../localization/core/vpsAlignment';
import type { ServerPortal, ServerRoom } from '../server/core/roomPlan';
import type { BuildFailure } from '../ui/core/buildView';
import type { DoorDraft } from '../ui/core/doorEdit';
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

/**
 * The server's result for this room, already in the AR world frame of the CURRENT session:
 * either straight from a build (the recording was made in this session, so the map frame
 * is this session's frame) or from `/localize`.
 */
export interface ServerPlan {
  mapId: string;
  origin: 'build' | 'localize';
  room: ServerRoom | null;
  portal: ServerPortal | null;
}

/**
 * The room has been recognised in the running AR session, by whatever way: its frame lies
 * in the session as `transform` says. A door placed now can be saved - it is written down
 * in the room's frame through this transform (`door/core/placement.ts`). Written by the
 * door layer (`door/DoorPlacer.ts`); gone as soon as tracking is interrupted, because the
 * session's frame may have changed.
 */
export interface FoundRoom {
  mapId: string;
  /** The name of the room's frame the transform refers to, or empty. */
  frameId: string;
  /** Room to this AR session, `p_session = T x p_room`: 16 numbers, column-major. */
  transform: number[];
  /** False when the way that recognised the room called its own answer weak. */
  strong: boolean;
  /** The room plan, the door and the suggested doorway, in this session's frame. */
  plan: ServerPlan;
  /**
   * Set when the room was found through ReactVision Advanced VPS instead: how that
   * service's map lies in this session. A door is then saved in the frame of that map
   * (`sessionId` is empty and not used).
   */
  vps?: { locationId: string; map: MapInSession };
}

/** Sending a capture to the server and waiting for the map. */
export interface UploadState {
  phase: 'idle' | 'uploading' | 'building' | 'done' | 'failed';
  /** One line for the panel. */
  text: string;
  /** 0..1, or null when unknown. */
  progress: number | null;
}

/** The room a scan is for. */
export interface ScanTarget {
  mapId: string;
  /** The name the user gave it; stored on the server as the room's label. */
  label: string;
  /** The room exists and this scan replaces its map. */
  replace: boolean;
}

/**
 * Sending a scan and building its map, in the form the product screens read
 * (`ui/core/buildView.ts`). `upload` above is the same thing as one line of text for the
 * developer tools.
 */
export interface BuildProgress {
  phase: 'idle' | 'uploading' | 'queued' | 'running' | 'lost-contact' | 'done' | 'failed' | 'cancelled';
  target: ScanTarget | null;
  /** Size of what is sent. */
  megabytes: number;
  /** 0..1 */
  uploadFraction: number;
  jobId: string | null;
  /** The server's own progress of the build, 0..1. */
  jobProgress: number;
  queuePosition: number;
  etaSeconds: number | null;
  /** Why it failed, when `phase` is `failed`. */
  failure: BuildFailure | null;
  /** Of a finished build: frames used and seconds taken (null when not known). */
  frames: number | null;
  seconds: number | null;
}

export const NO_BUILD: BuildProgress = {
  phase: 'idle',
  target: null,
  megabytes: 0,
  uploadFraction: 0,
  jobId: null,
  jobProgress: 0,
  queuePosition: 0,
  etaSeconds: null,
  failure: null,
  frames: null,
  seconds: null,
};

/** A scan is being sent or its map is being built. */
export function isBuilding(build: BuildProgress): boolean {
  return build.phase === 'uploading' || build.phase === 'queued' || build.phase === 'running' || build.phase === 'lost-contact';
}

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
  /** Name of the newest capture that has a video, i.e. can be uploaded. */
  lastCapture: string | null;
  upload: UploadState;
  build: BuildProgress;
  /** The room the guided scan is for; null outside the scan flow. */
  scanTarget: ScanTarget | null;
  serverPlan: ServerPlan | null;
  /** Draw the server's plan in the scene. */
  planVisible: boolean;
  /** See `FoundRoom`; null while the room is not found in this AR session. */
  found: FoundRoom | null;
  /** "Place the door": the door as the staff member has it now, in this session's frame. */
  doorDraft: DoorDraft | null;
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
  lastCapture: null,
  upload: { phase: 'idle', text: '', progress: null },
  build: NO_BUILD,
  scanTarget: null,
  serverPlan: null,
  planVisible: true,
  found: null,
  doorDraft: null,
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

export function subscribeRoomScan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoomScan<T>(selector: (s: RoomScanState) => T): T {
  return useSyncExternalStore(
    subscribeRoomScan,
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

  setLastCapture(lastCapture: string | null): void {
    setState({ lastCapture });
  },

  setUpload(upload: UploadState): void {
    setState({ upload });
  },

  /** Changes parts of the build's progress; `phase: 'uploading'` with a target starts a new one. */
  setBuild(patch: Partial<BuildProgress>): void {
    setState({ build: { ...state.build, ...patch } });
  },

  resetBuild(): void {
    setState({ build: NO_BUILD });
  },

  setScanTarget(scanTarget: ScanTarget | null): void {
    setState({ scanTarget });
  },

  setServerPlan(serverPlan: ServerPlan | null): void {
    setState({ serverPlan });
  },

  setFound(found: FoundRoom | null): void {
    if (found !== state.found) {
      setState({ found });
    }
  },

  setDoorDraft(doorDraft: DoorDraft | null): void {
    if (doorDraft !== state.doorDraft) {
      setState({ doorDraft });
    }
  },

  togglePlan(): void {
    setState({ planVisible: !state.planVisible });
  },

  setRecording(recording: RecordingPhase): void {
    setState({
      recording,
      recordingSince: recording === 'recording' ? (state.recordingSince ?? Date.now()) : null,
    });
  },
};
