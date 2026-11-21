/**
 * What the server says about a room: build jobs, the room plan (floor, walls, corners,
 * door openings) and the portal. Shapes follow `localization-server/docs/api-v2.md`.
 *
 * Pure TypeScript. The parsers take whatever JSON arrived and keep only well-formed
 * parts, so a server that adds fields - or sends something odd - cannot crash the app.
 */

export type V3 = [number, number, number];

function asV3(value: unknown): V3 | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (value as V3)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---- jobs -------------------------------------------------------------------------------

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ServerJob {
  jobId: string;
  kind: string;
  mapId: string;
  state: JobState;
  stage: string;
  stageIndex: number;
  stageCount: number;
  /** 0..1 overall. */
  progress: number;
  message: string;
  queuePosition: number;
  etaSeconds: number | null;
  error: { code: string; message: string } | null;
  /** Summary of a finished build; null until then. */
  result: {
    roomStatus: string;
    numWalls: number;
    numCorners: number;
    numOpenings: number;
    portalSource: string;
    warnings: string[];
    /** Frames of the recording the map was built from; null when the server did not say. */
    numImages: number | null;
    /** How long the build took, in seconds; null when the server did not say. */
    buildSeconds: number | null;
  } | null;
}

const JOB_STATES: readonly JobState[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

export function isFinalJobState(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/** Accepts a Job object or the `{"job": Job}` envelope of the upload answer. */
export function parseJob(body: unknown): ServerJob | null {
  const outer = asObject(body);
  const json = asObject(outer?.job) ?? outer;
  if (!json || typeof json.job_id !== 'string' || !JOB_STATES.includes(json.state as JobState)) {
    return null;
  }
  const error = asObject(json.error);
  const result = asObject(json.result);
  const room = asObject(result?.room);
  const portal = asObject(result?.portal);
  return {
    jobId: json.job_id,
    kind: asString(json.kind),
    mapId: asString(json.map_id),
    state: json.state as JobState,
    stage: asString(json.stage),
    stageIndex: asNumber(json.stage_index) ?? 0,
    stageCount: asNumber(json.stage_count) ?? 0,
    progress: Math.min(1, Math.max(0, asNumber(json.progress) ?? 0)),
    message: asString(json.message),
    queuePosition: asNumber(json.queue_position) ?? 0,
    etaSeconds: asNumber(json.eta_s),
    error: error ? { code: asString(error.code), message: asString(error.message) } : null,
    result: result
      ? {
          roomStatus: asString(room?.status) || 'unavailable',
          numWalls: asNumber(room?.num_walls) ?? 0,
          numCorners: asNumber(room?.num_corners) ?? 0,
          numOpenings: asNumber(room?.num_openings) ?? 0,
          portalSource: asString(portal?.source) || 'none',
          warnings: asList(result.warnings).filter((w): w is string => typeof w === 'string'),
          numImages: asNumber(result.num_images),
          buildSeconds: asNumber(result.build_time_s),
        }
      : null,
  };
}

/** The `{"jobs": [Job, ...]}` answer of `GET /jobs`; entries that are not jobs are dropped. */
export function parseJobs(body: unknown): ServerJob[] | null {
  const jobs = asObject(body)?.jobs;
  if (!Array.isArray(jobs)) {
    return null;
  }
  return jobs.map(parseJob).filter((job): job is ServerJob => job !== null);
}

/** What a failed build means for the person holding the phone. */
export function describeJobError(code: string, message: string): string {
  switch (code) {
    case 'bad_recording':
      return 'The server could not read the recording. Record the room again.';
    case 'too_few_frames':
      return 'The recording is too short or too blurred. Record again: 1-2 minutes, slowly.';
    case 'sfm_failed':
      return 'The room could not be reconstructed (too little texture or overlap). Record again, slower, walking along the walls.';
    case 'out_of_memory':
      return 'The server ran out of memory while building the map. Try again.';
    case 'server_restarted':
      return 'The server was restarted during the build. Upload the recording again.';
    default:
      return `The build failed${message ? `: ${message}` : ''}.`;
  }
}

/** One line for the scan panel. */
export function describeJob(job: ServerJob): string {
  const percent = `${Math.round(job.progress * 100)} %`;
  switch (job.state) {
    case 'queued':
      return job.queuePosition > 0 ? `waiting, ${job.queuePosition} build(s) ahead` : 'waiting to start';
    case 'running': {
      const step = job.stageCount > 0 ? `step ${job.stageIndex}/${job.stageCount} ${job.stage}` : job.stage;
      const eta =
        job.etaSeconds === null
          ? ''
          : job.etaSeconds >= 90
            ? `, about ${Math.round(job.etaSeconds / 60)} min left`
            : `, about ${Math.max(1, Math.round(job.etaSeconds))} s left`;
      return `${percent}, ${step}${eta}`;
    }
    case 'succeeded':
      return job.result
        ? `done: ${job.result.numWalls} walls, ${job.result.numCorners} corners, ${job.result.numOpenings} door opening(s)`
        : 'done';
    case 'failed':
      return describeJobError(job.error?.code ?? '', job.error?.message ?? '');
    case 'cancelled':
      return 'cancelled';
  }
}

// ---- room plan --------------------------------------------------------------------------

/** A wall or an opening: a vertical rectangle. */
export interface PlanRect {
  id: string;
  /** Pose of the rectangle's frame: origin at its centre, +X right, +Y up, +Z into the room. */
  position: V3;
  /** Euler degrees, usable as a ViroNode rotation. */
  rotation: V3;
  width: number;
  height: number;
  /** Bottom-left, bottom-right, top-right, top-left, seen from inside the room. */
  corners: V3[];
  confidence: number;
}

export interface PlanOpening extends PlanRect {
  state: string;
  /** False: the top of the opening was not seen and `height` is a default. */
  heightMeasured: boolean;
  /** The doorway frame: on the floor, middle of the threshold, +Z into the scanned room. */
  portalPosition: V3;
  portalRotation: V3;
}

export interface ServerRoom {
  status: 'ok' | 'partial' | 'unavailable';
  reason: string;
  /** "map" or "arworld". */
  frame: string;
  floorLevel: number | null;
  /** Closed polygon on the floor, or null. */
  floorOutline: V3[] | null;
  ceilingLevel: number | null;
  walls: PlanRect[];
  corners: { id: string; bottom: V3; top: V3 }[];
  openings: PlanOpening[];
  bestOpeningId: string | null;
}

function parseRect(value: unknown): PlanRect | null {
  const json = asObject(value);
  const pose = asObject(json?.pose);
  const position = asV3(pose?.position);
  const rotation = asV3(pose?.rotation_euler_deg);
  const width = asNumber(json?.width);
  const height = asNumber(json?.height);
  if (!json || !position || !rotation || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return {
    id: asString(json.id),
    position,
    rotation,
    width,
    height,
    corners: asList(json.corners).map(asV3).filter((c): c is V3 => c !== null),
    confidence: asNumber(json.confidence) ?? 0,
  };
}

/** Accepts a Room object or the `{"room": Room}` envelope of `GET /maps/{id}/room`. */
export function parseRoom(body: unknown): ServerRoom | null {
  const outer = asObject(body);
  const json = asObject(outer?.room) ?? outer;
  if (!json || typeof json.status !== 'string') {
    return null;
  }
  const status = json.status === 'ok' || json.status === 'partial' ? json.status : 'unavailable';
  const floor = asObject(json.floor);
  const ceiling = asObject(json.ceiling);
  const outline = asList(floor?.outline).map(asV3).filter((p): p is V3 => p !== null);

  const openings: PlanOpening[] = [];
  for (const item of asList(json.openings)) {
    const rect = parseRect(item);
    const raw = asObject(item);
    const portalPose = asObject(raw?.portal_pose);
    const portalPosition = asV3(portalPose?.position);
    const portalRotation = asV3(portalPose?.rotation_euler_deg);
    if (rect && raw && portalPosition && portalRotation) {
      openings.push({
        ...rect,
        state: asString(raw.state) || 'unknown',
        heightMeasured: raw.height_measured !== false,
        portalPosition,
        portalRotation,
      });
    }
  }

  const corners: ServerRoom['corners'] = [];
  for (const item of asList(json.corners)) {
    const raw = asObject(item);
    const bottom = asV3(raw?.bottom);
    const top = asV3(raw?.top);
    if (raw && bottom && top) {
      corners.push({ id: asString(raw.id), bottom, top });
    }
  }

  return {
    status,
    reason: asString(json.reason),
    frame: asString(json.frame),
    floorLevel: asNumber(floor?.level),
    floorOutline: outline.length >= 3 ? outline : null,
    ceilingLevel: asNumber(ceiling?.level),
    walls: asList(json.walls).map(parseRect).filter((w): w is PlanRect => w !== null),
    corners,
    openings,
    bestOpeningId: typeof json.best_opening_id === 'string' ? json.best_opening_id : null,
  };
}

// ---- portal -----------------------------------------------------------------------------

/** The doorway the server found by itself: a suggestion for the staff member who places the door. */
export interface SuggestedDoor {
  openingId: string | null;
  position: V3;
  rotation: V3;
  width: number | null;
  height: number | null;
  confidence: number | null;
}

export interface ServerPortal {
  /**
   * `manual`: placed by staff; `selected`: a found doorway accepted by staff; `auto`: found
   * by the server and confirmed by nobody; `none`: no door.
   */
  source: 'manual' | 'selected' | 'auto' | 'none';
  /** A person decided where the door stands (`manual`, `selected`): the door visitors get. */
  confirmed: boolean;
  openingId: string | null;
  /** Doorway frame; null when `source` is "none". */
  position: V3 | null;
  rotation: V3 | null;
  /** Size of the door, metres; null for a door saved without one. */
  width: number | null;
  height: number | null;
  confidence: number | null;
  /** ISO time the door was saved, or empty. */
  updatedUtc: string;
  /** What the server found by itself, next to a staff door too; null when it found nothing. */
  suggested: SuggestedDoor | null;
  reason: string;
}

function parseSuggested(value: unknown): SuggestedDoor | null {
  const json = asObject(value);
  const position = asV3(json?.position);
  const rotation = asV3(json?.rotation_euler_deg);
  if (!json || !position || !rotation) {
    return null;
  }
  return {
    openingId: typeof json.opening_id === 'string' ? json.opening_id : null,
    position,
    rotation,
    width: asNumber(json.width),
    height: asNumber(json.height),
    confidence: asNumber(json.confidence),
  };
}

export function parsePortal(body: unknown): ServerPortal | null {
  const json = asObject(body);
  if (!json || typeof json.source !== 'string') {
    return null;
  }
  const position = asV3(json.position);
  const rotation = asV3(json.rotation_euler_deg);
  const known = json.source === 'manual' || json.source === 'selected' || json.source === 'auto';
  // A portal without a usable pose is "none", whatever the server called it.
  if (!known || !position || !rotation) {
    return {
      source: 'none',
      confirmed: false,
      openingId: null,
      position: null,
      rotation: null,
      width: null,
      height: null,
      confidence: null,
      updatedUtc: '',
      suggested: parseSuggested(json.suggested),
      reason: asString(json.reason) || 'the server returned no doorway pose',
    };
  }
  const source = json.source as ServerPortal['source'];
  const saved = source === 'manual' || source === 'selected';
  return {
    source,
    // A server from before the two modes does not send the field: the source says the same.
    confirmed: typeof json.confirmed === 'boolean' ? json.confirmed && saved : saved,
    openingId: typeof json.opening_id === 'string' ? json.opening_id : null,
    position,
    rotation,
    width: asNumber(json.width),
    height: asNumber(json.height),
    confidence: asNumber(json.confidence),
    updatedUtc: asString(json.updated_utc),
    // A doorway found by the server and used as it is, is its own suggestion.
    suggested: parseSuggested(json.suggested) ?? (source === 'auto' ? parseSuggested(json) : null),
    reason: asString(json.reason),
  };
}

/** The answer of `PUT /maps/{id}/anchors/portal`: the door as visitors will get it. */
export interface SavedDoor {
  /** `recording_session`, `session_alignment`, `matrix` or `map`: how the server placed it. */
  alignmentUsed: string;
  /** The Door object in the map frame; null when the server did not send one. */
  portal: ServerPortal | null;
}

export function parseSavedDoor(body: unknown): SavedDoor | null {
  const json = asObject(body);
  if (!json) {
    return null;
  }
  return { alignmentUsed: asString(json.alignment_used), portal: parsePortal(json.portal) };
}

/** An answer whose content is not needed: any JSON object will do. */
export function parseAnyObject(body: unknown): true | null {
  return asObject(body) ? true : null;
}

// ---- /localize --------------------------------------------------------------------------

export interface LocalizeOutcome {
  /** "good", "weak" or "failed": quality of the image localisation itself. */
  quality: string;
  reason: string;
  numInliers: number;
  /** "ok" when the map could be placed in the current AR session. */
  alignmentStatus: string;
  portal: ServerPortal | null;
  room: ServerRoom | null;
}

export function parseLocalize(body: unknown): LocalizeOutcome | null {
  const json = asObject(body);
  if (!json || typeof json.success !== 'boolean') {
    return null;
  }
  const alignment = asObject(json.alignment);
  const ok = alignment?.status === 'ok';
  return {
    quality: asString(json.quality) || (json.success ? 'good' : 'failed'),
    reason: asString(json.reason),
    numInliers: asNumber(json.num_inliers) ?? 0,
    alignmentStatus: asString(alignment?.status) || 'none',
    portal: ok ? parsePortal(alignment?.portal) : null,
    room: ok ? parseRoom(alignment?.room) : null,
  };
}

// ---- /maps --------------------------------------------------------------------------------

/** One room of `GET /maps`, as far as the interface needs it. */
export interface ServerMapInfo {
  mapId: string;
  /** The name given when the room was scanned, or empty. */
  label: string;
  /** ISO time the map was built, or empty. */
  createdUtc: string;
  /** "ok", "partial" or "unavailable": whether the room has a plan. */
  roomStatus: string;
  /** "manual", "selected", "auto" or "none": how the doorway is known. */
  portalSource: string;
  /** Staff saved a door in this room: the room a visitor can be shown. */
  portalConfirmed: boolean;
}

export function parseMaps(body: unknown): ServerMapInfo[] | null {
  const json = asObject(body);
  if (!json || !Array.isArray(json.maps)) {
    return null;
  }
  const maps: ServerMapInfo[] = [];
  for (const entry of json.maps) {
    const map = asObject(entry);
    const mapId = asString(map?.map_id);
    if (!map || !mapId) {
      continue;
    }
    const portalSource = asString(map.portal_source) || 'none';
    maps.push({
      mapId,
      label: asString(map.label),
      createdUtc: asString(map.created_utc),
      roomStatus: asString(map.room_status) || 'unavailable',
      portalSource,
      portalConfirmed:
        typeof map.portal_confirmed === 'boolean' ? map.portal_confirmed : portalSource === 'manual' || portalSource === 'selected',
    });
  }
  return maps;
}
