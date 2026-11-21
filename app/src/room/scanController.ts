/**
 * Everything the room scan does through the AR engine and the file system: world-mesh
 * statistics, mesh snapshot, the session recording (video + poses) and the export of the
 * app's own plane model. What ends up in a capture folder is described in
 * `docs/capture-format.md`.
 *
 * The AR scene hands over the navigator object it receives from ViroReact; the overlay's
 * buttons call the functions here.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { appActions } from '../state/appStore';
import { getPlaneAnchors, getRoomScanState, roomActions, type MeshInfo } from './roomStore';
import { meshToPly, parseRvwm } from './meshFormat';

/** The subset of ViroReact's `arSceneNavigator` object used by the scan. */
interface ScanNavigator {
  getWorldMeshStats?: () => Promise<Record<string, unknown>>;
  resetWorldMesh?: () => Promise<boolean>;
  snapshotWorldMeshToFile?: (locationTransform: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  isRecordingSupported?: (options?: { depth?: boolean }) => Promise<boolean>;
  startRecording?: (outputDir: string, options?: { depth?: boolean }) => Promise<{ success: boolean; error?: string }>;
  stopRecording?: () => Promise<{
    success: boolean;
    error?: string;
    durationSec?: number;
    frames?: number;
    depthFrames?: number;
    gpsFixes?: number;
    bytes?: number;
  }>;
}

const MESH_POLL_INTERVAL_MS = 1000;
/**
 * `snapshotWorldMeshToFile` wants the transform of a hosted scan and writes the mesh "in
 * the scan's frame". The identity keeps the mesh in the AR world frame of this session,
 * which is the frame of the recording's poses.
 */
const IDENTITY_TRANSFORM = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
export const CAPTURE_FORMAT_VERSION = 1;

let navigator: ScanNavigator | null = null;
let meshTimer: ReturnType<typeof setInterval> | null = null;
let lastMeshSummary = '';
let captureDir: Directory | null = null;
let captureStartedUtc = '';
/** The newest capture with a video: what "Upload" sends. */
let lastCaptureDir: Directory | null = null;

const log = (text: string) => appActions.log(`scan: ${text}`);

/** `file:///data/...` -> `/data/...`, without a trailing slash: what native code expects. */
function nativePath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '');
}

function timestampName(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `capture-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function newCaptureDir(): Directory {
  const root = new Directory(Paths.document, 'captures');
  root.create({ intermediates: true, idempotent: true });
  const dir = new Directory(root, timestampName(new Date()));
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function describeFiles(dir: Directory): string {
  const parts: string[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof File) {
      parts.push(`${entry.name} ${(Number(entry.size ?? 0) / 1024).toFixed(0)} kB`);
    } else {
      parts.push(`${entry.name}/`);
    }
  }
  return parts.join(', ');
}

function toMeshInfo(raw: Record<string, unknown>): MeshInfo {
  return {
    available: raw.available === true,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    vertexCount: typeof raw.vertexCount === 'number' ? raw.vertexCount : 0,
    triangleCount: typeof raw.triangleCount === 'number' ? raw.triangleCount : 0,
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
    accumulated: raw.accumulated === true,
  };
}

async function pollMesh(): Promise<void> {
  if (!navigator?.getWorldMeshStats) {
    return;
  }
  try {
    const info = toMeshInfo(await navigator.getWorldMeshStats());
    roomActions.setMesh(info);
    // Log changes of kind, not every number.
    const summary = info.available
      ? `available, source ${info.source}${info.accumulated ? ', accumulated' : ''}`
      : `not available (${info.reason || 'no reason given'})`;
    if (summary !== lastMeshSummary) {
      lastMeshSummary = summary;
      log(`world mesh ${summary}`);
    }
  } catch (error) {
    const summary = `query failed: ${String(error)}`;
    if (summary !== lastMeshSummary) {
      lastMeshSummary = summary;
      log(`world mesh ${summary}`);
    }
  }
}

/**
 * The app's own model of the room: the detected planes, in the AR world frame.
 *
 * Writing and copying a file are asynchronous in expo-file-system (`write`, `copy`): every
 * one is awaited here, so that a capture folder is complete when it is handed on.
 */
async function writePlanes(dir: Directory): Promise<void> {
  const { room } = getRoomScanState();
  const file = new File(dir, 'planes.json');
  if (!file.exists) {
    file.create();
  }
  await file.write(
    JSON.stringify({
      format: 'arportal-planes',
      version: CAPTURE_FORMAT_VERSION,
      frame: 'AR world frame of the recording session: metres, right-handed, +Y up',
      rotation_convention: 'Euler degrees [x,y,z], R = Rz*Ry*Rx (ViroReact)',
      floor_y: room.floorY,
      planes: room.planes.map((plane) => ({
        id: plane.anchorId,
        kind: plane.kind,
        alignment: plane.alignment,
        classification: plane.classification,
        position: plane.position,
        rotation_euler_deg: plane.rotation,
        normal: plane.normal,
        area_m2: plane.area,
        vertices: plane.vertices,
        vertices_local: plane.localVertices,
      })),
      corners: room.corners.map((corner) => ({
        position: corner.position,
        height_m: corner.height,
        wall_ids: corner.wallIds,
      })),
      raw_anchors: getPlaneAnchors(),
    }),
  );
}

async function snapshotMeshInto(dir: Directory): Promise<string> {
  if (!navigator?.snapshotWorldMeshToFile) {
    return 'not offered by this ViroReact build';
  }
  const result = await navigator.snapshotWorldMeshToFile(IDENTITY_TRANSFORM);
  if (!result.success || !result.filePath) {
    return `not saved: ${result.error ?? 'no file path returned'}`;
  }
  const source = new File(result.filePath.startsWith('file://') ? result.filePath : `file://${result.filePath}`);
  if (!source.exists || !(Number(source.size ?? 0) > 0)) {
    return 'not saved: the engine wrote no mesh (the file it named is missing or empty)';
  }
  const extension = /\.([A-Za-z0-9]+)$/.exec(result.filePath)?.[1] ?? 'bin';
  const target = new File(dir, `world_mesh.${extension}`);
  if (target.exists) {
    target.delete();
  }
  // Awaited: the copy runs on another thread. Not waiting for it was why the guided scan
  // of 2026-11-21 saved "world_mesh.bin (0 kB)" - the source below was deleted, and the
  // copy measured and read, before a byte had been copied.
  await source.copy(target);
  try {
    source.delete(); // the engine writes every snapshot to a new file in the cache
  } catch {
    // left for Android's cache clean-up
  }
  const kB = (file: File) => `${(Number(new File(file.uri).size ?? 0) / 1024).toFixed(0)} kB`;
  let note = `saved ${target.name} (${kB(target)})`;
  // The server and mesh tools read PLY; the engine's own format is kept next to it.
  try {
    const mesh = parseRvwm(await target.bytes());
    if (mesh) {
      const ply = new File(dir, 'world_mesh.ply');
      if (ply.exists) {
        ply.delete();
      }
      ply.create();
      await ply.write(meshToPly(mesh));
      note += ` and world_mesh.ply (${kB(ply)}): ${mesh.vertexCount} vertices, ${mesh.triangleCount} triangles`;
    } else {
      note += '; not converted to PLY: the file is not an RVWM version 1 mesh';
    }
  } catch (error) {
    note += `; not converted to PLY (${String(error)})`;
  }
  return note;
}

/** The newest capture that can be uploaded, or null. */
export function getLastCaptureDir(): Directory | null {
  return lastCaptureDir;
}

/**
 * A capture folder by its name, if it still has a recording: what "Send again" uses for a
 * scan made before the app was restarted.
 */
export function findCaptureDir(name: string): Directory | null {
  if (!/^capture-[0-9-]+$/.test(name)) {
    return null;
  }
  try {
    const dir = new Directory(Paths.document, 'captures', name);
    return dir.exists && new File(dir, 'video.mp4').exists ? dir : null;
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Records a short clip (video + poses) for `/localize` into the cache folder. The caller
 * deletes the folder when it is done with it.
 */
export async function recordClip(seconds: number): Promise<{ dir: Directory } | { error: string }> {
  if (!navigator?.startRecording || !navigator.stopRecording) {
    return { error: 'recording is not offered by this ViroReact build' };
  }
  if (getRoomScanState().recording !== 'idle') {
    return { error: 'a recording is already running' };
  }
  roomActions.setRecording('starting');
  try {
    if ((await navigator.isRecordingSupported?.()) === false) {
      return { error: 'recording is not possible right now (the AR session must be tracking)' };
    }
    const root = new Directory(Paths.cache, 'localize');
    root.create({ intermediates: true, idempotent: true });
    const dir = new Directory(root, `clip-${Date.now()}`);
    dir.create({ intermediates: true, idempotent: true });
    const started = await navigator.startRecording(nativePath(dir.uri));
    if (!started.success) {
      return { error: `the clip did not start: ${started.error ?? 'no reason given'}` };
    }
    await wait(seconds * 1000);
    const stopped = await navigator.stopRecording();
    if (!stopped.success) {
      return { error: `the clip did not finish: ${stopped.error ?? 'no reason given'}` };
    }
    return { dir };
  } catch (error) {
    return { error: String(error) };
  } finally {
    roomActions.setRecording('idle');
  }
}

export const scanController = {
  /** Called by the AR scene with the object ViroReact injects as `arSceneNavigator`. */
  attach(value: unknown): void {
    navigator = value && typeof value === 'object' ? (value as ScanNavigator) : null;
  },

  setScanning(on: boolean): void {
    roomActions.setScanning(on);
    if (meshTimer !== null) {
      clearInterval(meshTimer);
      meshTimer = null;
    }
    lastMeshSummary = '';
    if (on) {
      const { room, planeCount, depthReady } = getRoomScanState();
      log(
        `room scan on: ${planeCount} planes known (${room.wallCount} walls), ` +
          `depth ${depthReady ? 'ready' : 'not reported yet'}`,
      );
      meshTimer = setInterval(() => void pollMesh(), MESH_POLL_INTERVAL_MS);
    } else {
      log('room scan off');
    }
  },

  toggleWireframe(): void {
    const next = !getRoomScanState().wireframe;
    roomActions.setWireframe(next);
    log(`mesh wireframe ${next ? 'on' : 'off'}`);
  },

  /** Forget the fused mesh. Planes belong to the AR session and cannot be reset from here. */
  async reset(): Promise<void> {
    try {
      const done = await navigator?.resetWorldMesh?.();
      log(`world mesh reset: ${done === undefined ? 'not offered' : done ? 'done' : 'refused'}`);
    } catch (error) {
      log(`world mesh reset failed: ${String(error)}`);
    }
  },

  /** Planes + mesh into a new capture folder, without a recording. */
  async snapshot(): Promise<void> {
    try {
      const dir = newCaptureDir();
      await writePlanes(dir);
      log(`mesh snapshot: ${await snapshotMeshInto(dir)}`);
      log(`${dir.name}: ${describeFiles(dir)}`);
    } catch (error) {
      log(`snapshot failed: ${String(error)}`);
    }
  },

  async toggleRecording(): Promise<void> {
    const phase = getRoomScanState().recording;
    if (phase === 'idle') {
      await startRecording();
    } else if (phase === 'recording') {
      await stopRecording();
    }
  },

  startRecording: (): Promise<boolean> => startRecording(),
  stopRecording: (): Promise<CaptureSummary | null> => stopRecording(),
  discardRecording: (): Promise<void> => discardRecording(),
};

/** What a finished recording left on the phone. */
export interface CaptureSummary {
  dir: Directory;
  seconds: number;
  frames: number | null;
}

/** The user left while the recording was still starting: it is thrown away once it runs. */
let discardWhenStarted = false;

/** Starts a recording into a new capture folder. False when it did not start (the log says why). */
async function startRecording(): Promise<boolean> {
  if (!navigator?.startRecording) {
    log('recording is not offered by this ViroReact build');
    return false;
  }
  if (getRoomScanState().recording !== 'idle') {
    return false;
  }
  discardWhenStarted = false;
  roomActions.setRecording('starting');
  try {
    const supported = await navigator.isRecordingSupported?.();
    if (supported === false) {
      log('recording not supported right now (the AR session must be tracking)');
      roomActions.setRecording('idle');
      return false;
    }
    const dir = newCaptureDir();
    const result = await navigator.startRecording(nativePath(dir.uri));
    if (!result.success) {
      log(`recording did not start: ${result.error ?? 'no reason given'}`);
      removeQuietly(dir);
      roomActions.setRecording('idle');
      return false;
    }
    captureDir = dir;
    captureStartedUtc = new Date().toISOString();
    roomActions.setRecording('recording');
    log(`recording into ${dir.name}`);
    if (discardWhenStarted) {
      await discardRecording();
      return false;
    }
    return true;
  } catch (error) {
    log(`recording failed to start: ${String(error)}`);
    roomActions.setRecording('idle');
    return false;
  }
}

function removeQuietly(dir: Directory): void {
  try {
    dir.delete();
  } catch {
    // a leftover folder does no harm
  }
}

/** Stops the running recording and deletes what it wrote. */
async function discardRecording(): Promise<void> {
  const phase = getRoomScanState().recording;
  if (phase === 'starting') {
    discardWhenStarted = true;
    return;
  }
  if (phase !== 'recording') {
    return;
  }
  roomActions.setRecording('stopping');
  const dir = captureDir;
  captureDir = null;
  try {
    await navigator?.stopRecording?.();
  } catch (error) {
    log(`recording failed to stop: ${String(error)}`);
  } finally {
    if (dir) {
      removeQuietly(dir);
      log(`recording discarded (${dir.name})`);
    }
    roomActions.setRecording('idle');
  }
}

/**
 * Stops the running recording and completes its capture folder (planes, mesh, summary).
 * Null when there is no usable recording.
 */
async function stopRecording(): Promise<CaptureSummary | null> {
  if (getRoomScanState().recording !== 'recording') {
    return null;
  }
  roomActions.setRecording('stopping');
  const dir = captureDir;
  captureDir = null;
  let summary: CaptureSummary | null = null;
  try {
    const result = await navigator?.stopRecording?.();
    if (!result?.success) {
      log(`recording stopped with an error: ${result?.error ?? 'no result'}`);
    } else {
      log(
        `recording stopped: ${Number(result.durationSec ?? 0).toFixed(1)} s, ${result.frames ?? '?'} frames` +
          (result.bytes ? `, ${(result.bytes / 1e6).toFixed(1)} MB` : ''),
      );
    }
    if (dir && result?.success) {
      lastCaptureDir = dir;
      roomActions.setLastCapture(dir.name);
      summary = { dir, seconds: Number(result.durationSec ?? 0), frames: typeof result.frames === 'number' ? result.frames : null };
    }
    if (dir) {
      await writePlanes(dir);
      // The mesh is an extra for the server's room plan: a scan without it is still sent.
      const meshNote = await snapshotMeshInto(dir).catch((error) => `not saved: ${String(error)}`);
      log(`mesh snapshot: ${meshNote}`);
      const meta = new File(dir, 'capture.json');
      if (!meta.exists) {
        meta.create();
      }
      await meta.write(
        JSON.stringify({
          format: 'arportal-capture',
          version: CAPTURE_FORMAT_VERSION,
          started_utc: captureStartedUtc,
          stopped_utc: new Date().toISOString(),
          recording: result ?? null,
          world_mesh: meshNote,
          mesh_stats: getRoomScanState().mesh,
        }),
      );
      log(`${dir.name}: ${describeFiles(dir)}`);
    }
  } catch (error) {
    log(`recording failed to stop: ${String(error)}`);
  } finally {
    roomActions.setRecording('idle');
  }
  return summary;
}
