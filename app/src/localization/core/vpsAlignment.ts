/**
 * Where an external positioning service's map lies in the running AR session, and how a
 * door goes from one frame to the other (ReactVision Advanced VPS; `docs/cloud/cloud-connection.md`,
 * section 5). Pure TypeScript.
 *
 * The service reports the CAMERA's pose in the frame of its map (`renderPose`, a 4x4
 * matrix as 16 numbers in column-major order). The AR engine knows the camera's pose in
 * the session at the same moment. From the two:
 *
 *   session-from-map = (camera in the session) x inverse(camera in the map)
 *
 * Both frames are in metres with Y up, so the result is a turn about the vertical and a
 * shift. One reading is taken from two poses that were not measured at exactly the same
 * instant, so several readings are collected while the phone is steady and averaged; a
 * reading that tilts the map is thrown away.
 *
 * NOT VERIFIED against the service: that `renderPose` uses the same camera convention as
 * the AR engine (X right, Y up, -Z forward) and that the map's Y axis is the vertical.
 */

export type V3 = [number, number, number];
/** 16 numbers, column-major: element (row, column) is at `column * 4 + row`. */
export type Mat4 = number[];

const DEG = Math.PI / 180;

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: readonly number[]): V3 | null {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

/** A 4x4 matrix from the three axes of a frame and its origin. */
function fromAxes(x: readonly number[], y: readonly number[], z: readonly number[], origin: readonly number[]): Mat4 {
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
}

/**
 * The camera's pose in the session as a matrix, from what the AR engine reports: where
 * the camera is, where it looks and where its top points. Null when the two directions
 * do not define a frame.
 */
export function cameraMatrix(position: readonly number[], forward: readonly number[], up: readonly number[]): Mat4 | null {
  const f = normalize(forward);
  const right = f ? normalize(cross(f, up)) : null;
  if (!f || !right) {
    return null;
  }
  const trueUp = cross(right, f);
  return fromAxes(right, trueUp, [-f[0], -f[1], -f[2]], position);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Whether a matrix is a pose: 16 finite numbers, three axes of length one at right angles
 * to each other (a matrix with a scale or a shear in it is not one), right-handed.
 */
export function isPose(m: unknown, tolerance = 0.02): m is Mat4 {
  if (!Array.isArray(m) || m.length !== 16 || !m.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return false;
  }
  const x = [m[0], m[1], m[2]];
  const y = [m[4], m[5], m[6]];
  const z = [m[8], m[9], m[10]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: number[]) => Math.abs(dot(a, a) - 1) <= 2 * tolerance;
  if (!unit(x) || !unit(y) || !unit(z)) {
    return false;
  }
  if (Math.abs(dot(x, y)) > tolerance || Math.abs(dot(x, z)) > tolerance || Math.abs(dot(y, z)) > tolerance) {
    return false;
  }
  const handed = cross(x, y);
  return dot(handed, z) > 0.9 && Math.abs(m[3]) < 1e-6 && Math.abs(m[7]) < 1e-6 && Math.abs(m[11]) < 1e-6 && Math.abs(m[15] - 1) < 1e-6;
}

/** The inverse of a pose (turn transposed, shift turned back). */
export function invertPose(m: Mat4): Mat4 {
  const t = [m[12], m[13], m[14]];
  // Rows of the turn become its columns.
  const x = [m[0], m[4], m[8]];
  const y = [m[1], m[5], m[9]];
  const z = [m[2], m[6], m[10]];
  const origin = [
    -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]),
    -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]),
    -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]),
  ];
  return fromAxes(x, y, z, origin);
}

/**
 * How the map lies in the session, when both have the same vertical: the map turned by
 * `yawDeg` about Y (positive = anticlockwise seen from above), then shifted.
 */
export interface MapInSession {
  yawDeg: number;
  shift: V3;
}

/** Above this tilt between the two verticals a reading is not believed. */
export const MAX_TILT_DEG = 4;

/**
 * One reading: the camera in the session and in the map at (nearly) the same moment.
 * Null when one of them is not a pose, or when the result would tilt the map by more
 * than `MAX_TILT_DEG` (the two poses did not belong together, or a frame is not upright).
 */
export function mapInSession(cameraInSession: Mat4 | null, cameraInMap: unknown): MapInSession | null {
  if (!cameraInSession || !isPose(cameraInSession) || !isPose(cameraInMap)) {
    return null;
  }
  const m = multiply(cameraInSession, invertPose(cameraInMap));
  // The map's vertical, seen in the session.
  const tilt = Math.acos(Math.max(-1, Math.min(1, m[5]))) / DEG;
  if (tilt > MAX_TILT_DEG) {
    return null;
  }
  // The map's +Z, seen in the session, on the floor plan.
  return { yawDeg: Math.atan2(m[8], m[10]) / DEG, shift: [m[12], m[13], m[14]] };
}

/** A door on the floor: where it stands and where its room side looks. */
export interface FlatPose {
  position: V3;
  yawDeg: number;
}

function wrap(deg: number): number {
  const turned = ((((deg + 180) % 360) + 360) % 360) - 180;
  return turned === -180 ? 180 : turned;
}

/** A pose given in the map, in the session. */
export function toSession(map: MapInSession, inMap: FlatPose): FlatPose {
  const cos = Math.cos(map.yawDeg * DEG);
  const sin = Math.sin(map.yawDeg * DEG);
  const [x, y, z] = inMap.position;
  return {
    position: [x * cos + z * sin + map.shift[0], y + map.shift[1], -x * sin + z * cos + map.shift[2]],
    yawDeg: wrap(inMap.yawDeg + map.yawDeg),
  };
}

/** A pose given in the session, in the map: what is saved for every other phone. */
export function toMap(map: MapInSession, inSession: FlatPose): FlatPose {
  const cos = Math.cos(map.yawDeg * DEG);
  const sin = Math.sin(map.yawDeg * DEG);
  const x = inSession.position[0] - map.shift[0];
  const y = inSession.position[1] - map.shift[1];
  const z = inSession.position[2] - map.shift[2];
  return { position: [x * cos - z * sin, y, x * sin + z * cos], yawDeg: wrap(inSession.yawDeg - map.yawDeg) };
}

/** A heading as the quaternion `[x, y, z, w]` the server stores, and back. */
export function quaternionFromYaw(yawDeg: number): [number, number, number, number] {
  const half = (yawDeg * DEG) / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/** Where the +Z of a rotation points on the floor plan; null for something that is not a rotation. */
export function yawFromQuaternion(q: unknown): number | null {
  if (!Array.isArray(q) || q.length !== 4 || !q.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length < 1e-9) {
    return null;
  }
  const [x, y, z, w] = [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) / DEG;
}

// ---- steady readings ----------------------------------------------------------------------

export const STEADY = {
  /** This many readings in a row have to agree... */
  readings: 4,
  /** ...to within this distance and this turn, measured at the door. */
  distanceM: 0.04,
  angleDeg: 2,
  /** Readings older than this are forgotten. */
  maxAgeMs: 4000,
} as const;

function average(readings: MapInSession[]): MapInSession {
  const n = readings.length;
  // Headings are averaged as directions, so that 179 and -179 give 180 and not 0.
  const sin = readings.reduce((sum, r) => sum + Math.sin(r.yawDeg * DEG), 0);
  const cos = readings.reduce((sum, r) => sum + Math.cos(r.yawDeg * DEG), 0);
  return {
    yawDeg: Math.atan2(sin, cos) / DEG,
    shift: [0, 1, 2].map((i) => readings.reduce((sum, r) => sum + r.shift[i], 0) / n) as V3,
  };
}

/**
 * Collects readings and says when the last few agree. Agreement is judged where it
 * matters: at `at`, the place of the door in the map (a small error in the turn is a
 * large one far from the map's origin).
 */
export class SteadyAlignment {
  private readings: { at: number; value: MapInSession }[] = [];

  /** Adds a reading; returns the averaged alignment once enough readings agree, else null. */
  add(reading: MapInSession, nowMs: number, at: FlatPose = { position: [0, 0, 0], yawDeg: 0 }): MapInSession | null {
    this.readings = this.readings.filter((r) => nowMs - r.at <= STEADY.maxAgeMs);
    this.readings.push({ at: nowMs, value: reading });
    const latest = this.readings.slice(-STEADY.readings).map((r) => r.value);
    if (latest.length < STEADY.readings) {
      return null;
    }
    const mean = average(latest);
    const centre = toSession(mean, at);
    for (const value of latest) {
      const here = toSession(value, at);
      const apart = Math.hypot(
        here.position[0] - centre.position[0],
        here.position[1] - centre.position[1],
        here.position[2] - centre.position[2],
      );
      if (apart > STEADY.distanceM || Math.abs(wrap(here.yawDeg - centre.yawDeg)) > STEADY.angleDeg) {
        return null;
      }
    }
    return mean;
  }

  reset(): void {
    this.readings = [];
  }

  get count(): number {
    return this.readings.length;
  }
}

/**
 * The service's `renderPose`: "16 comma-separated floats, a 4x4 matrix in column-major
 * order". Null for anything else.
 */
export function parseRenderPose(text: unknown): Mat4 | null {
  if (typeof text !== 'string') {
    return null;
  }
  const numbers = text.split(',').map((part) => Number(part.trim()));
  return numbers.length === 16 && numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}
