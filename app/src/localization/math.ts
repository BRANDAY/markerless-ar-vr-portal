import type { Vec3 } from './types';

const RAD_TO_DEG = 180 / Math.PI;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Projects a direction onto the horizontal plane (drops Y) and normalizes it.
 * Returns null when the direction is (almost) vertical, i.e. the phone points
 * straight up or down and the heading is undefined.
 */
export function horizontalDirection(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[2]);
  if (len < 1e-3) {
    return null;
  }
  return [v[0] / len, 0, v[2] / len];
}

/**
 * Yaw (degrees, rotation about +Y, ViroReact convention) that turns a node's
 * local +Z axis towards the given horizontal direction.
 * With R = Ry(yaw): local +Z -> (sin(yaw), 0, cos(yaw)).
 */
export function yawFacing(direction: Vec3): number {
  return Math.atan2(direction[0], direction[2]) * RAD_TO_DEG;
}

/**
 * Converts a unit quaternion [x, y, z, w] to ViroReact Euler degrees [x, y, z]
 * (R = Rz * Ry * Rx). For the providers that receive quaternions from a service.
 */
export function quaternionToViroEuler(q: [number, number, number, number]): Vec3 {
  const [x, y, z, w] = q;
  // Rotation matrix elements needed for the ZYX (yaw-pitch-roll style) extraction.
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r10 = 2 * (x * y + w * z);
  const r00 = 1 - 2 * (y * y + z * z);

  const sinY = Math.max(-1, Math.min(1, -r20));
  const ey = Math.asin(sinY);
  let ex: number;
  let ez: number;
  if (Math.abs(sinY) < 0.999999) {
    ex = Math.atan2(r21, r22);
    ez = Math.atan2(r10, r00);
  } else {
    // Gimbal lock: only the sum/difference of x and z is defined; put it all in x.
    // With z = 0: r01 = sin(x) * sin(y), r11 = cos(x).
    const r01 = 2 * (x * y - w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    ex = Math.atan2(r01 * Math.sign(sinY), r11);
    ez = 0;
  }
  return [ex * RAD_TO_DEG, ey * RAD_TO_DEG, ez * RAD_TO_DEG];
}

export function formatVec3(v: Vec3 | null | undefined, digits = 2): string {
  if (!v) {
    return '-';
  }
  return `${v[0].toFixed(digits)}, ${v[1].toFixed(digits)}, ${v[2].toFixed(digits)}`;
}

/**
 * Rotates a vector by ViroReact Euler angles (degrees, R = Rz * Ry * Rx).
 * Used to turn an offset given in the doorway's local frame into AR-world coordinates.
 */
export function rotateByViroEuler(v: Vec3, eulerDeg: Vec3): Vec3 {
  const [ax, ay, az] = eulerDeg.map((d) => d / RAD_TO_DEG);
  const [cx, sx] = [Math.cos(ax), Math.sin(ax)];
  const [cy, sy] = [Math.cos(ay), Math.sin(ay)];
  const [cz, sz] = [Math.cos(az), Math.sin(az)];
  // Rx
  const x1 = v[0];
  const y1 = cx * v[1] - sx * v[2];
  const z1 = sx * v[1] + cx * v[2];
  // Ry
  const x2 = cy * x1 + sy * z1;
  const y2 = y1;
  const z2 = -sy * x1 + cy * z1;
  // Rz
  return [cz * x2 - sz * y2, sz * x2 + cz * y2, z2];
}
