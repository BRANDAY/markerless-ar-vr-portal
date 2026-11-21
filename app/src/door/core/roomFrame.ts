/**
 * The sum the whole door layer rests on (`localization-server/docs/api-v2.md`, section 5):
 *
 *   door in this AR session = (room in this AR session) x (door in the room)
 *
 * and the same sum backwards for a door that is being saved. "Room in this AR session" is
 * what a way of recognising the room answers (`RoomFix.transform`); "door in the room" is
 * the one record the venue's server keeps. Pure TypeScript.
 *
 * Matrices are 4x4, 16 numbers in column-major order (element (row, column) at
 * `column * 4 + row`), `p_session = T x p_room`. A room transform may carry a scale (a
 * map without metric scale); a door pose never does.
 */
import { type Mat4, multiply, type V3 } from '../../localization/core/vpsAlignment';

export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The length a metre of the room has in the session (1 for a metric map). */
export function scaleOf(m: Mat4): number {
  return Math.hypot(m[0], m[1], m[2]);
}

function isTransform(m: Mat4): boolean {
  if (m.length !== 16 || !m.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return false;
  }
  if (Math.abs(m[3]) > 1e-6 || Math.abs(m[7]) > 1e-6 || Math.abs(m[11]) > 1e-6 || Math.abs(m[15] - 1) > 1e-6) {
    return false;
  }
  // Three axes of the same length at right angles: a turn with a scale, nothing else.
  const s = scaleOf(m);
  if (!(s > 1e-6)) {
    return false;
  }
  const axis = (c: number) => [m[c * 4] / s, m[c * 4 + 1] / s, m[c * 4 + 2] / s];
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a: number[]) => Math.abs(dot(a, a) - 1) < 0.02;
  return unit(y) && unit(z) && Math.abs(dot(x, y)) < 0.01 && Math.abs(dot(x, z)) < 0.01 && Math.abs(dot(y, z)) < 0.01;
}

/** The server writes a matrix as four rows of four numbers. Null for anything that is not a room transform. */
export function matrixFromRows(value: unknown): Mat4 | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const m = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row++) {
    const numbers: unknown = value[row];
    if (!Array.isArray(numbers) || numbers.length !== 4) {
      return null;
    }
    for (let column = 0; column < 4; column++) {
      const n: unknown = numbers[column];
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return null;
      }
      m[column * 4 + row] = n;
    }
  }
  return isTransform(m) ? m : null;
}

export function rowsFromMatrix(m: Mat4): number[][] {
  return [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((column) => m[column * 4 + row]));
}

/** A matrix kept as 16 numbers (a copy on the phone). Null when it is not a room transform. */
export function asTransform(value: unknown): Mat4 | null {
  return Array.isArray(value) && isTransform(value as Mat4) ? (value as Mat4) : null;
}

export function matrixFromPose(position: readonly number[], q: readonly number[]): Mat4 {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [x, y, z, w] = [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    0,
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    0,
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
    0,
    position[0],
    position[1],
    position[2],
    1,
  ];
}

/** A pose that only turns about the vertical: `yawDeg` is where its +Z points on the floor plan. */
export function matrixFromYaw(position: readonly number[], yawDeg: number): Mat4 {
  const cos = Math.cos(yawDeg * DEG);
  const sin = Math.sin(yawDeg * DEG);
  return [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, position[0], position[1], position[2], 1];
}

/** The inverse of a turn with a scale and a shift. */
export function invertTransform(m: Mat4): Mat4 {
  const s2 = scaleOf(m) ** 2;
  // The inverse of `s R` is its transpose divided by `s` squared.
  const a = [m[0] / s2, m[4] / s2, m[8] / s2, m[1] / s2, m[5] / s2, m[9] / s2, m[2] / s2, m[6] / s2, m[10] / s2];
  const t = [m[12], m[13], m[14]];
  return [
    a[0],
    a[1],
    a[2],
    0,
    a[3],
    a[4],
    a[5],
    0,
    a[6],
    a[7],
    a[8],
    0,
    -(a[0] * t[0] + a[3] * t[1] + a[6] * t[2]),
    -(a[1] * t[0] + a[4] * t[1] + a[7] * t[2]),
    -(a[2] * t[0] + a[5] * t[1] + a[8] * t[2]),
    1,
  ];
}

export function applyToPoint(m: Mat4, p: readonly number[]): V3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Element (row, column) of the turn inside a transform, with the scale taken out. */
function turn(m: Mat4): (row: number, column: number) => number {
  const s = scaleOf(m) || 1;
  return (row, column) => m[column * 4 + row] / s;
}

/** The turn of a transform as a unit quaternion `[x, y, z, w]`. */
export function quaternionOf(m: Mat4): Quat {
  const r = turn(m);
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r(2, 1) - r(1, 2)) / s, (r(0, 2) - r(2, 0)) / s, (r(1, 0) - r(0, 1)) / s, s / 4];
  } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
    const s = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
    q = [s / 4, (r(0, 1) + r(1, 0)) / s, (r(0, 2) + r(2, 0)) / s, (r(2, 1) - r(1, 2)) / s];
  } else if (r(1, 1) > r(2, 2)) {
    const s = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
    q = [(r(0, 1) + r(1, 0)) / s, s / 4, (r(1, 2) + r(2, 1)) / s, (r(0, 2) - r(2, 0)) / s];
  } else {
    const s = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
    q = [(r(0, 2) + r(2, 0)) / s, (r(1, 2) + r(2, 1)) / s, s / 4, (r(1, 0) - r(0, 1)) / s];
  }
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/**
 * The turn of a transform as the Euler angles a ViroReact node takes: degrees `[x, y, z]`,
 * applied as R = Rz * Ry * Rx - the convention of the server's `rotation_euler_deg`.
 */
export function viroEulerOf(m: Mat4): V3 {
  const r = turn(m);
  const sinY = Math.max(-1, Math.min(1, -r(2, 0)));
  const y = Math.asin(sinY);
  if (Math.abs(sinY) < 0.999999) {
    return [Math.atan2(r(2, 1), r(2, 2)) / DEG, y / DEG, Math.atan2(r(1, 0), r(0, 0)) / DEG];
  }
  // Looking straight up or down: only the sum of x and z is defined; all of it goes into x.
  return [Math.atan2(r(0, 1) * Math.sign(sinY), r(1, 1)) / DEG, y / DEG, 0];
}

/** Euler angles of that convention as a quaternion (a record that came without one). */
export function quaternionFromViroEuler(eulerDeg: readonly number[]): Quat {
  const [hx, hy, hz] = [(eulerDeg[0] * DEG) / 2, (eulerDeg[1] * DEG) / 2, (eulerDeg[2] * DEG) / 2];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(hx), Math.sin(hx), Math.cos(hy), Math.sin(hy), Math.cos(hz), Math.sin(hz)];
  // q = qz * qy * qx
  return [
    cz * cy * sx - sz * sy * cx,
    cz * sy * cx + sz * cy * sx,
    sz * cy * cx - cz * sy * sx,
    cz * cy * cx + sz * sy * sx,
  ];
}

/** A pose kept in the room's frame, in this AR session: where it is and how a node is turned to it. */
export function poseInSession(
  roomInSession: Mat4,
  position: readonly number[],
  quaternion: readonly number[],
): { position: V3; rotation: V3; quaternion: Quat } {
  const m = multiply(roomInSession, matrixFromPose(position, quaternion));
  return { position: [m[12], m[13], m[14]], rotation: viroEulerOf(m), quaternion: quaternionOf(m) };
}

/**
 * The same sum backwards: a door that stands upright in this AR session at `position`,
 * its room side looking along `yawDeg`, in the room's frame - what the server stores.
 */
export function poseInRoom(roomInSession: Mat4, position: readonly number[], yawDeg: number): { position: V3; quaternion: Quat } {
  const m = multiply(invertTransform(roomInSession), matrixFromYaw(position, yawDeg));
  return { position: [m[12], m[13], m[14]], quaternion: quaternionOf(m) };
}
