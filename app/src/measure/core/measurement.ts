/**
 * Measuring where the doorway stands, for the persistence tests of assignment task 5
 * (restart, approach angle, lighting, tracking loss, walking through).
 *
 * Every app session has its own AR world frame, so door poses of two sessions cannot be
 * compared directly. What stays the same between sessions is the real door opening. The
 * user therefore marks the two bottom corners of the real opening (where the door jambs
 * meet the floor) in the CURRENT session, and the door the app has placed is compared
 * with those marks: a distance in centimetres and a heading difference in degrees.
 *
 * Pure TypeScript: the geometry, the record format and the summary are unit-tested and
 * are also used on the PC by `report.cli.ts`.
 *
 * Conventions as in `localization/types.ts`: metres, +Y up, a doorway with yaw `a` has
 * its local +Z (the side the user stands on, "AR side") along (sin a, 0, cos a) and its
 * local +X (to the right, seen from that side) along (cos a, 0, -sin a).
 */

export type V3 = [number, number, number];

const DEG = Math.PI / 180;

/**
 * The test a record belongs to; chosen with a button. `baseline` is the control: the door
 * measured in the very session the room was scanned in.
 */
export const CONDITIONS = ['baseline', 'restart', 'angle', 'lighting', 'tracking-loss', 'walk-through'] as const;
export type Condition = (typeof CONDITIONS)[number];

export function isCondition(value: unknown): value is Condition {
  return typeof value === 'string' && (CONDITIONS as readonly string[]).includes(value);
}

export function nextCondition(condition: Condition): Condition {
  return CONDITIONS[(CONDITIONS.indexOf(condition) + 1) % CONDITIONS.length];
}

/**
 * When a measured door counts as "in the same place". OUR ASSUMPTION: the assignment
 * gives no tolerance. 10 cm is about a ninth of a 90 cm door and of the order published
 * for phone AR (see `docs/test-protocol.md`); 5 degrees moves the far jamb of such a
 * door by about 8 cm.
 */
export const TOLERANCE = { positionCm: 10, headingDeg: 5 } as const;
export type Tolerance = { positionCm: number; headingDeg: number };

// ---- marking a point on the floor --------------------------------------------------------

/** The phone must look at least this far below the horizon when a corner is aimed at. */
export const MIN_AIM_PITCH_DEG = 25;
export const MAX_AIM_DISTANCE_M = 4;

export type AimResult =
  | { ok: true; point: V3; distanceM: number; pitchDeg: number }
  | { ok: false; reason: string };

/**
 * The point of the floor the middle of the screen looks at: the camera's viewing ray cut
 * with the horizontal plane `y = floorY`. An error of the floor height moves the point
 * along the ray's ground track by `error / tan(pitch)`, hence the minimum pitch.
 */
export function aimPointOnFloor(position: V3, forward: V3, floorY: number): AimResult {
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  if (!(length > 1e-6)) {
    return { ok: false, reason: 'the camera direction is not known yet' };
  }
  const f: V3 = [forward[0] / length, forward[1] / length, forward[2] / length];
  const drop = position[1] - floorY;
  if (drop < 0.05) {
    return { ok: false, reason: 'the phone is not above the floor plane' };
  }
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, -f[1]))) / DEG;
  if (pitchDeg < MIN_AIM_PITCH_DEG) {
    return {
      ok: false,
      reason: `aim more steeply down (now ${pitchDeg.toFixed(0)} deg below the horizon, at least ${MIN_AIM_PITCH_DEG} needed): step closer to the corner`,
    };
  }
  const distanceM = drop / -f[1];
  if (distanceM > MAX_AIM_DISTANCE_M) {
    return { ok: false, reason: `the corner is ${distanceM.toFixed(1)} m away: step closer` };
  }
  return {
    ok: true,
    point: [position[0] + f[0] * distanceM, floorY, position[2] + f[2] * distanceM],
    distanceM,
    pitchDeg,
  };
}

/** The point of the floor straight below the phone (the phone is held at the corner). */
export function phonePointOnFloor(position: V3, floorY: number): V3 {
  return [position[0], floorY, position[2]];
}

// ---- the reference and the door ----------------------------------------------------------

/** The marked bottom corners of the real opening, "left" and "right" as seen from the AR side. */
export interface Reference {
  left: V3 | null;
  right: V3 | null;
}

export interface DoorPose {
  /** On the floor, middle of the threshold. */
  position: V3;
  yawDeg: number;
  /** Width of the opening, metres. */
  widthM: number;
}

export function horizontalDistance(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function axisX(yawDeg: number): V3 {
  return [Math.cos(yawDeg * DEG), 0, -Math.sin(yawDeg * DEG)];
}

function axisZ(yawDeg: number): V3 {
  return [Math.sin(yawDeg * DEG), 0, Math.cos(yawDeg * DEG)];
}

/** Difference of two headings in (-180, 180]. */
export function signedYawDifferenceDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) {
    d -= 360;
  } else if (d <= -180) {
    d += 360;
  }
  return d;
}

/** Marks closer together than this cannot be the two corners of a doorway. */
const MIN_MARKED_WIDTH_M = 0.3;

/** Middle of the threshold, heading and width of the real opening, from both marks. */
export function referenceFrame(reference: Reference): { middle: V3; yawDeg: number; widthM: number } | null {
  const { left, right } = reference;
  if (!left || !right) {
    return null;
  }
  const widthM = horizontalDistance(left, right);
  if (widthM < MIN_MARKED_WIDTH_M) {
    return null;
  }
  const x: V3 = [(right[0] - left[0]) / widthM, 0, (right[2] - left[2]) / widthM];
  return {
    middle: [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2],
    yawDeg: Math.atan2(-x[2], x[0]) / DEG,
    widthM,
  };
}

/** The bottom corners of the opening of a placed door. */
export function doorCorners(door: DoorPose): { left: V3; right: V3 } {
  const x = axisX(door.yawDeg);
  const half = door.widthM / 2;
  const p = door.position;
  return {
    left: [p[0] - x[0] * half, p[1], p[2] - x[2] * half],
    right: [p[0] + x[0] * half, p[1], p[2] + x[2] * half],
  };
}

export interface Comparison {
  /** What was compared: the middle of the threshold (both marks) or one corner. */
  basis: 'both-corners' | 'left-corner' | 'right-corner';
  /** Horizontal distance between the door and the real opening, the headline number. */
  positionCm: number;
  /** Along the wall; + = the door stands to the right of the real opening (seen from the AR side). */
  alongCm: number;
  /** Through the wall; + = the door stands towards the AR side. */
  acrossCm: number;
  /** + = the door's threshold is above the marked floor. */
  heightCm: number;
  /** Door heading minus real heading; null with one mark. */
  headingDeg: number | null;
  /** Door width minus marked width; null with one mark. */
  widthCm: number | null;
  /** Horizontal distance of each door corner from its mark, where marked. */
  leftCm: number | null;
  rightCm: number | null;
  /** Inside the tolerance (position, and heading when it is known). */
  pass: boolean;
}

const cm = (metres: number) => Math.round(metres * 1000) / 10;
const tenth = (value: number) => Math.round(value * 10) / 10;

/** How far the placed door is from the marked opening; null without any mark. */
export function compareDoor(door: DoorPose, reference: Reference, tolerance: Tolerance = TOLERANCE): Comparison | null {
  const corners = doorCorners(door);
  const frame = referenceFrame(reference);
  const leftCm = reference.left ? cm(horizontalDistance(corners.left, reference.left)) : null;
  const rightCm = reference.right ? cm(horizontalDistance(corners.right, reference.right)) : null;

  let basis: Comparison['basis'];
  let from: V3;
  let to: V3;
  let frameYaw: number;
  let headingDeg: number | null = null;
  let widthCm: number | null = null;
  if (frame) {
    basis = 'both-corners';
    from = frame.middle;
    to = door.position;
    frameYaw = frame.yawDeg;
    headingDeg = tenth(signedYawDifferenceDeg(door.yawDeg, frame.yawDeg));
    widthCm = cm(door.widthM - frame.widthM);
  } else if (reference.left) {
    basis = 'left-corner';
    from = reference.left;
    to = corners.left;
    frameYaw = door.yawDeg;
  } else if (reference.right) {
    basis = 'right-corner';
    from = reference.right;
    to = corners.right;
    frameYaw = door.yawDeg;
  } else {
    return null;
  }
  const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const x = axisX(frameYaw);
  const z = axisZ(frameYaw);
  const positionCm = cm(Math.hypot(d[0], d[2]));
  return {
    basis,
    positionCm,
    alongCm: cm(d[0] * x[0] + d[2] * x[2]),
    acrossCm: cm(d[0] * z[0] + d[2] * z[2]),
    heightCm: cm(d[1]),
    headingDeg,
    widthCm,
    leftCm,
    rightCm,
    pass: positionCm <= tolerance.positionCm && (headingDeg === null || Math.abs(headingDeg) <= tolerance.headingDeg),
  };
}

// ---- records -----------------------------------------------------------------------------

/**
 * What a record reports:
 *  - `placed` / `moved` / `confirmed` / `kept`: a localisation ended with a door on screen;
 *  - `not-found`: the room was not recognised (the attempts of an episode were used up);
 *  - `no-doorway`: the room was recognised, but its map has no door opening;
 *  - `check`: the user pressed "Measure" - the result of one trial.
 */
export type MeasureEvent = 'placed' | 'moved' | 'confirmed' | 'kept' | 'not-found' | 'no-doorway' | 'check';

/** The localisation a record belongs to (for a `check`: the latest one). */
export interface Placement {
  event: Exclude<MeasureEvent, 'check'>;
  /** Why the room was looked for: start, recovery, manual, confirm, build, by-hand. */
  reason: string;
  /** Requests to the server this took. */
  attempts: number;
  /** From the start of the search to its result; null when nothing was searched. */
  elapsedMs: number | null;
  /**
   * From the start of the app (its JavaScript) to the moment the door on screen was put
   * where it stands; for a search that ended without a door, to its end.
   */
  sinceStartMs: number;
  /** False for a pose from a weak answer that is still being confirmed. */
  trusted: boolean;
  /** The server's own words about its answer; null for a provider without a server. */
  quality: string | null;
  inliers: number | null;
  /** How the server knows the doorway: "auto", "manual"... */
  source: string | null;
  confidence: number | null;
}

export interface MeasurementRecord {
  v: 1;
  kind: 'door-measurement';
  /** App run (`SESSION_ID`), device installation id, number of the record in the run. */
  run: string;
  device: string;
  seq: number;
  /** ISO time of the record. */
  time: string;
  condition: Condition;
  event: MeasureEvent;
  provider: string;
  /** Tracking state at the moment of the record. */
  tracking: string;
  placement: Placement | null;
  /** The door on screen, in the AR world frame of this session; null when there is none. */
  door: { position: V3; yawDeg: number; widthM: number; heightM: number; sizeFromServer: boolean } | null;
  reference: {
    left: V3 | null;
    right: V3 | null;
    /** "aim" (ray to the floor) or "phone" (phone held at the corner). */
    method: string;
    /** The marks were made before tracking was interrupted: the frame may have shifted since. */
    beforeInterruption: boolean;
  } | null;
  comparison: Comparison | null;
  /** A correction of the door was being held back (user inside the virtual room): `door` is the old pose. */
  held: boolean;
}

/** What the summary needs from a record; also what fits into one line of the device log. */
export interface Trial {
  run: string;
  seq: number;
  condition: string;
  event: MeasureEvent;
  /** Event of the localisation the trial belongs to. */
  placementEvent: string | null;
  reason: string | null;
  attempts: number | null;
  elapsedMs: number | null;
  sinceStartMs: number | null;
  quality: string | null;
  inliers: number | null;
  positionCm: number | null;
  alongCm: number | null;
  acrossCm: number | null;
  heightCm: number | null;
  headingDeg: number | null;
  widthCm: number | null;
  pass: boolean | null;
  /** The marks predate an interruption of tracking. */
  stale: boolean;
}

export function trialFromRecord(record: MeasurementRecord): Trial {
  const p = record.placement;
  const c = record.comparison;
  return {
    run: record.run,
    seq: record.seq,
    condition: record.condition,
    event: record.event,
    placementEvent: p?.event ?? null,
    reason: p?.reason ?? null,
    attempts: p?.attempts ?? null,
    elapsedMs: p?.elapsedMs ?? null,
    sinceStartMs: p?.sinceStartMs ?? null,
    quality: p?.quality ?? null,
    inliers: p?.inliers ?? null,
    positionCm: c?.positionCm ?? null,
    alongCm: c?.alongCm ?? null,
    acrossCm: c?.acrossCm ?? null,
    heightCm: c?.heightCm ?? null,
    headingDeg: c?.headingDeg ?? null,
    widthCm: c?.widthCm ?? null,
    pass: c?.pass ?? null,
    stale: record.reference?.beforeInterruption ?? false,
  };
}

/** Prefix of the machine-readable line in the app's event log (and so in the server's device log). */
export const DATA_PREFIX = 'measure-data ';

const round3 = (values: readonly number[]) => values.map((v) => Math.round(v * 1000) / 1000);

/**
 * One line with everything the summary needs plus the raw poses, short enough for the
 * device log (500 characters per message).
 */
export function compactLine(record: MeasurementRecord): string {
  const t = trialFromRecord(record);
  const data: Record<string, unknown> = {
    v: 1,
    run: t.run,
    seq: t.seq,
    c: t.condition,
    e: t.event,
    pe: t.placementEvent,
    pr: t.reason,
    att: t.attempts,
    ms: t.elapsedMs,
    st: t.sinceStartMs,
    q: t.quality,
    inl: t.inliers,
    pos: t.positionCm,
    al: t.alongCm,
    ac: t.acrossCm,
    up: t.heightCm,
    hd: t.headingDeg,
    wd: t.widthCm,
    ok: t.pass === null ? null : t.pass ? 1 : 0,
    stale: t.stale ? 1 : 0,
    door: record.door ? round3([...record.door.position, record.door.yawDeg, record.door.widthM]) : null,
    L: record.reference?.left ? round3(record.reference.left) : null,
    R: record.reference?.right ? round3(record.reference.right) : null,
  };
  // Nulls are left out: they are the default when the line is read back.
  for (const key of Object.keys(data)) {
    if (data[key] === null) {
      delete data[key];
    }
  }
  return DATA_PREFIX + JSON.stringify(data);
}

const EVENTS: readonly string[] = ['placed', 'moved', 'confirmed', 'kept', 'not-found', 'no-doorway', 'check'];

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function trialFromCompact(json: Record<string, unknown>): Trial | null {
  const run = str(json.run);
  const seq = num(json.seq);
  const event = str(json.e);
  if (!run || seq === null || !event || !EVENTS.includes(event)) {
    return null;
  }
  return {
    run,
    seq,
    condition: str(json.c) ?? '?',
    event: event as MeasureEvent,
    placementEvent: str(json.pe),
    reason: str(json.pr),
    attempts: num(json.att),
    elapsedMs: num(json.ms),
    sinceStartMs: num(json.st),
    quality: str(json.q),
    inliers: num(json.inl),
    positionCm: num(json.pos),
    alongCm: num(json.al),
    acrossCm: num(json.ac),
    heightCm: num(json.up),
    headingDeg: num(json.hd),
    widthCm: num(json.wd),
    pass: json.ok === 1 ? true : json.ok === 0 ? false : null,
    stale: json.stale === 1,
  };
}

/**
 * Reads trials from any of the places they end up in, one JSON object per line:
 *  - the app's own files (`measurements/<run>.jsonl`, full records);
 *  - the server's device log (`work/device-logs/<device>.jsonl`, or the `events` of
 *    `GET /devices/{id}/log` written one per line): events whose message is a
 *    `measure-data {...}` line;
 *  - plain text with such lines (a saved logcat).
 * The same record found twice (phone file and server log) is counted once.
 */
export function parseTrials(text: string): Trial[] {
  const byKey = new Map<string, Trial>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    let trial: Trial | null = null;
    let json: unknown = null;
    if (line.startsWith('{')) {
      try {
        json = JSON.parse(line);
      } catch {
        json = null;
      }
    }
    let message: string | null = null;
    if (json && typeof json === 'object') {
      const object = json as Record<string, unknown>;
      if (object.kind === 'door-measurement' && object.v === 1 && typeof object.run === 'string') {
        trial = trialFromRecord(object as unknown as MeasurementRecord);
      } else {
        message = str(object.message);
      }
    } else {
      message = line;
    }
    if (!trial && message) {
      const at = message.indexOf(DATA_PREFIX);
      if (at >= 0) {
        try {
          trial = trialFromCompact(JSON.parse(message.slice(at + DATA_PREFIX.length)) as Record<string, unknown>);
        } catch {
          trial = null;
        }
      }
    }
    if (trial) {
      byKey.set(`${trial.run}#${trial.seq}`, trial);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.run === b.run ? a.seq - b.seq : a.run < b.run ? -1 : 1));
}

// ---- words -------------------------------------------------------------------------------

const signed = (value: number, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

/** The comparison in one line, for the panel and the log. */
export function describeComparison(c: Comparison, tolerance: Tolerance = TOLERANCE): string {
  const what = c.basis === 'both-corners' ? 'door' : c.basis === 'left-corner' ? 'left corner' : 'right corner';
  let text = `${what} ${c.positionCm.toFixed(1)} cm from the real opening (along ${signed(c.alongCm)}, across ${signed(c.acrossCm)}, up ${signed(c.heightCm)})`;
  if (c.headingDeg !== null) {
    text += `, heading ${signed(c.headingDeg)} deg`;
    if (Math.abs(c.headingDeg) > 150) {
      text += ' (about 180: the door faces the other way, or the left and right marks are swapped)';
    }
  }
  if (c.widthCm !== null) {
    text += `, width ${signed(c.widthCm)} cm`;
  }
  return `${text} - ${c.pass ? 'inside' : 'OUTSIDE'} the tolerance of ${tolerance.positionCm} cm / ${tolerance.headingDeg} deg`;
}

export function describePlacement(p: Placement): string {
  const parts: string[] = [`${p.event} (${p.reason})`];
  if (p.elapsedMs !== null) {
    parts.push(`search ${(p.elapsedMs / 1000).toFixed(1)} s`);
  }
  if (p.attempts > 0) {
    parts.push(`${p.attempts} attempt${p.attempts === 1 ? '' : 's'}`);
  }
  parts.push(`${(p.sinceStartMs / 1000).toFixed(1)} s after app start`);
  if (p.quality) {
    parts.push(`server ${p.quality}${p.inliers === null ? '' : `, ${p.inliers} inliers`}`);
  }
  if (!p.trusted && p.event !== 'not-found' && p.event !== 'no-doorway') {
    parts.push('not confirmed');
  }
  return parts.join(', ');
}

/** One readable line for the event log. */
export function describeRecord(record: MeasurementRecord): string {
  const head = `measure ${record.condition} #${record.seq} ${record.event}`;
  const parts: string[] = [];
  if (record.comparison) {
    parts.push(describeComparison(record.comparison));
    if (record.reference?.beforeInterruption) {
      parts.push('marks made before tracking was interrupted');
    }
  } else if (record.door) {
    parts.push('no marks of the real opening in this session, so no distance');
  } else {
    parts.push('no door on screen');
  }
  if (record.placement) {
    parts.push(describePlacement(record.placement));
  }
  if (record.held) {
    parts.push('a correction is held back while the user is inside');
  }
  return `${head}: ${parts.join('; ')}`;
}

// ---- summary -----------------------------------------------------------------------------

export interface ConditionSummary {
  condition: string;
  /** Trials: presses of "Measure" plus localisations that ended without a door. */
  trials: number;
  /** Trials in which the door came back and was measured against marks. */
  measured: number;
  /** Trials in which the door did not come back (room not recognised, no doorway). */
  notFound: number;
  /** Presses of "Measure" without marks or without a door: nothing to compare. */
  unmeasured: number;
  /** Measured trials inside the tolerance. */
  passed: number;
  positionCm: Stats | null;
  /** Of the absolute heading difference. */
  headingDeg: Stats | null;
  /** Seconds from app start to the door, of the trials that have it. */
  sinceStartS: Stats | null;
  /** Seconds one search took. */
  searchS: Stats | null;
}

export interface Stats {
  n: number;
  mean: number;
  median: number;
  max: number;
}

export function stats(values: number[]): Stats | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    n: sorted.length,
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted[sorted.length - 1],
  };
}

/**
 * Results per test condition. A trial is one press of "Measure" (the door was there and
 * was compared with the marks) or one search that ended without a door. The automatic
 * records of a search that did end with a door (`placed`, `moved`...) are not trials of
 * their own: the `check` that follows carries their timing.
 */
export function summarize(trials: Trial[], tolerance: Tolerance = TOLERANCE): ConditionSummary[] {
  const order: string[] = [...CONDITIONS];
  const groups = new Map<string, Trial[]>();
  for (const trial of trials) {
    if (trial.event !== 'check' && trial.event !== 'not-found' && trial.event !== 'no-doorway') {
      continue;
    }
    if (!groups.has(trial.condition)) {
      groups.set(trial.condition, []);
      if (!order.includes(trial.condition)) {
        order.push(trial.condition);
      }
    }
    groups.get(trial.condition)?.push(trial);
  }
  const result: ConditionSummary[] = [];
  for (const condition of order) {
    const group = groups.get(condition);
    if (!group) {
      continue;
    }
    const checks = group.filter((t) => t.event === 'check');
    const measured = checks.filter((t) => t.positionCm !== null);
    const inside = (t: Trial) =>
      (t.positionCm as number) <= tolerance.positionCm &&
      (t.headingDeg === null || Math.abs(t.headingDeg) <= tolerance.headingDeg);
    result.push({
      condition,
      trials: group.length,
      measured: measured.length,
      notFound: group.length - checks.length,
      unmeasured: checks.length - measured.length,
      passed: measured.filter(inside).length,
      positionCm: stats(measured.map((t) => t.positionCm as number)),
      headingDeg: stats(measured.filter((t) => t.headingDeg !== null).map((t) => Math.abs(t.headingDeg as number))),
      sinceStartS: stats(checks.filter((t) => t.sinceStartMs !== null).map((t) => (t.sinceStartMs as number) / 1000)),
      searchS: stats(checks.filter((t) => t.elapsedMs !== null).map((t) => (t.elapsedMs as number) / 1000)),
    });
  }
  return result;
}

function cell(s: Stats | null, digits = 1): string {
  return s ? `${s.median.toFixed(digits)} / ${s.mean.toFixed(digits)} / ${s.max.toFixed(digits)}` : '-';
}

/** The summary as a Markdown table (median / mean / max). */
export function formatSummary(summaries: ConditionSummary[], tolerance: Tolerance = TOLERANCE): string {
  const lines = [
    `Tolerance: ${tolerance.positionCm} cm and ${tolerance.headingDeg} deg (our assumption). Cells with three numbers are median / mean / max.`,
    '',
    '| Test | Trials | Door came back | Measured | Inside tolerance | Position, cm | Heading, deg | App start to door, s | One search, s |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summaries) {
    const back = s.trials - s.notFound;
    lines.push(
      `| ${s.condition} | ${s.trials} | ${back} of ${s.trials} | ${s.measured} | ` +
        `${s.measured ? `${s.passed} of ${s.measured}` : '-'} | ${cell(s.positionCm)} | ${cell(s.headingDeg)} | ` +
        `${cell(s.sinceStartS)} | ${cell(s.searchS)} |`,
    );
  }
  if (summaries.length === 0) {
    lines.push('| (no trials found) | | | | | | | | |');
  }
  return lines.join('\n');
}
