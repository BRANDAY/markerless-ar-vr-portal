/**
 * Geometry of a doorway that is remembered relative to a cloud anchor.
 *
 * A cloud service gives back the pose of an ANCHOR in the AR world of the current
 * session. It knows nothing about the doorway. So when the doorway is saved, its pose is
 * written down in the anchor's own frame (`relativeTo`), and when the anchor is found
 * again in a later session the doorway is rebuilt from it (`applyRelative`).
 *
 * Conventions are those of `localization/types.ts`: metres, +Y up, Euler angles in
 * degrees [x, y, z] applied as R = Rz * Ry * Rx (column vectors). Pure TypeScript.
 */

export type Vec3 = [number, number, number];

/** Row-major 3x3 rotation matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface RigidPose {
  position: Vec3;
  /** Euler degrees [x, y, z], R = Rz * Ry * Rx. */
  rotation: Vec3;
}

const DEG = Math.PI / 180;

export function eulerToMatrix(rotation: Vec3): Mat3 {
  const [ax, ay, az] = [rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG];
  const [cx, sx] = [Math.cos(ax), Math.sin(ax)];
  const [cy, sy] = [Math.cos(ay), Math.sin(ay)];
  const [cz, sz] = [Math.cos(az), Math.sin(az)];
  // Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

export function matrixToEuler(m: Mat3): Vec3 {
  const sinY = Math.max(-1, Math.min(1, -m[6]));
  const ey = Math.asin(sinY);
  let ex: number;
  let ez: number;
  if (Math.abs(sinY) < 0.999999) {
    ex = Math.atan2(m[7], m[8]);
    ez = Math.atan2(m[3], m[0]);
  } else {
    // Gimbal lock: only x -/+ z is defined; put it all in x (z = 0).
    // With z = 0: m[1] = sin(y) * sin(x), m[4] = cos(x).
    ex = Math.atan2(m[1] * Math.sign(sinY), m[4]);
    ez = 0;
  }
  return [ex / DEG, ey / DEG, ez / DEG];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function rotate(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** `pose` written in the frame of `frame`: frame^-1 * pose. */
export function relativeTo(frame: RigidPose, pose: RigidPose): RigidPose {
  const inverse = transpose(eulerToMatrix(frame.rotation));
  const delta: Vec3 = [
    pose.position[0] - frame.position[0],
    pose.position[1] - frame.position[1],
    pose.position[2] - frame.position[2],
  ];
  return {
    position: rotate(inverse, delta),
    rotation: matrixToEuler(multiply(inverse, eulerToMatrix(pose.rotation))),
  };
}

/** The pose that sits at `relative` inside `frame`: frame * relative. */
export function applyRelative(frame: RigidPose, relative: RigidPose): RigidPose {
  const r = eulerToMatrix(frame.rotation);
  const offset = rotate(r, relative.position);
  return {
    position: [
      frame.position[0] + offset[0],
      frame.position[1] + offset[1],
      frame.position[2] + offset[2],
    ],
    rotation: matrixToEuler(multiply(r, eulerToMatrix(relative.rotation))),
  };
}

/**
 * A doorway stands upright: only its heading is kept. The heading is where the doorway's
 * local +Z points after the rotation, projected on the floor. Returns null when that axis
 * is (almost) vertical, i.e. the pose is not a standing doorway at all.
 */
export function uprightYawDeg(rotation: Vec3): number | null {
  const z = rotate(eulerToMatrix(rotation), [0, 0, 1]);
  if (Math.hypot(z[0], z[2]) < 0.2) {
    return null;
  }
  return Math.atan2(z[0], z[2]) / DEG;
}

/** How far a rotation leans away from upright, degrees (0 = local +Y is world +Y). */
export function tiltDeg(rotation: Vec3): number {
  const y = rotate(eulerToMatrix(rotation), [0, 1, 0]);
  return Math.acos(Math.max(-1, Math.min(1, y[1]))) / DEG;
}

/**
 * Doorway pose in the current session from the anchor found in it and the offset saved
 * when the doorway was hosted. The result is forced upright. Null when the rebuilt pose
 * is not a standing doorway (the anchor came back with a wrong orientation).
 */
export function doorFromAnchor(anchorNow: RigidPose, doorInAnchor: RigidPose): RigidPose | null {
  const raw = applyRelative(anchorNow, doorInAnchor);
  const yaw = uprightYawDeg(raw.rotation);
  if (yaw === null || !raw.position.every(Number.isFinite)) {
    return null;
  }
  return { position: raw.position, rotation: [0, yaw, 0] };
}

export function distanceM(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
