/**
 * Inside the space (`docs/product/ui-spec.md`, 5.9 "Inside the space" and 3.4): whether
 * the door is out of view, and how close the phone is to a real wall of the room. Pure;
 * everything is in the AR world frame of the running session.
 */

type V3 = readonly number[];

const DEG = Math.PI / 180;

/**
 * Half of the horizontal angle the phone shows in portrait, with a margin: a door further
 * than this from the middle of the view counts as "behind you".
 */
export const VIEW_HALF_ANGLE_DEG = 35;

/**
 * True when the door is outside the view: the angle between where the phone points and
 * where the door is, both taken on the floor plan, is larger than `halfAngleDeg`. False
 * when the phone points straight up or down, or stands on the door (no direction).
 */
export function doorOutOfView(camera: V3, forward: V3, door: V3, halfAngleDeg: number = VIEW_HALF_ANGLE_DEG): boolean {
  const fx = forward[0];
  const fz = forward[2];
  const dx = door[0] - camera[0];
  const dz = door[2] - camera[2];
  const fLen = Math.hypot(fx, fz);
  const dLen = Math.hypot(dx, dz);
  if (fLen < 1e-3 || dLen < 0.05) {
    return false;
  }
  const cos = (fx * dx + fz * dz) / (fLen * dLen);
  return cos < Math.cos(halfAngleDeg * DEG);
}

/** A wall of the room plan: centre, ViroReact Euler angles in degrees, size in metres. */
export interface WallRect {
  id: string;
  position: V3;
  rotation: V3;
  width: number;
  height: number;
}

/** Rotates a vector by ViroReact Euler angles (degrees, R = Rz * Ry * Rx). */
function rotate(v: V3, eulerDeg: V3): [number, number, number] {
  const [rx, ry, rz] = [eulerDeg[0] * DEG, eulerDeg[1] * DEG, eulerDeg[2] * DEG];
  // about X
  let x = v[0];
  let y = v[1] * Math.cos(rx) - v[2] * Math.sin(rx);
  let z = v[1] * Math.sin(rx) + v[2] * Math.cos(rx);
  // about Y
  const x2 = x * Math.cos(ry) + z * Math.sin(ry);
  const z2 = -x * Math.sin(ry) + z * Math.cos(ry);
  x = x2;
  z = z2;
  // about Z
  const x3 = x * Math.cos(rz) - y * Math.sin(rz);
  const y3 = x * Math.sin(rz) + y * Math.cos(rz);
  return [x3, y3, z];
}

/**
 * Distance from the phone to a wall, metres: to the wall's plane where the phone stands
 * in front of the wall, to the wall's nearer end otherwise. The wall's height is ignored
 * (a real wall goes on above and below what was measured).
 */
export function wallDistance(camera: V3, wall: WallRect): number {
  const normal = rotate([0, 0, 1], wall.rotation);
  const right = rotate([1, 0, 0], wall.rotation);
  const d = [camera[0] - wall.position[0], camera[1] - wall.position[1], camera[2] - wall.position[2]];
  const toPlane = d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2];
  const along = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
  const beyond = Math.max(0, Math.abs(along) - wall.width / 2);
  return Math.hypot(toPlane, beyond);
}

/** The wall nearest to the phone and its distance; null without walls. */
export function nearestWall<T extends WallRect>(camera: V3, walls: readonly T[]): { wall: T; distance: number } | null {
  let best: { wall: T; distance: number } | null = null;
  for (const wall of walls) {
    const distance = wallDistance(camera, wall);
    if (!best || distance < best.distance) {
      best = { wall, distance };
    }
  }
  return best;
}

export const WALL_WARNING = {
  /** The grid starts to show at this distance from a real wall... */
  startM: 0.6,
  /** ...and is at full strength from here on. */
  fullM: 0.3,
} as const;

/** How strongly the warning grid is drawn, 0..1, for a distance to the wall. */
export function gridStrength(distance: number): number {
  if (!Number.isFinite(distance) || distance >= WALL_WARNING.startM) {
    return 0;
  }
  if (distance <= WALL_WARNING.fullM) {
    return 1;
  }
  return (WALL_WARNING.startM - distance) / (WALL_WARNING.startM - WALL_WARNING.fullM);
}

/** The lines of a grid over a rectangle `width` x `height`, centred on its middle: x and y positions. */
export function gridLines(width: number, height: number, cell: number): { xs: number[]; ys: number[] } {
  const along = (size: number): number[] => {
    const count = Math.max(1, Math.round(size / cell));
    const step = size / count;
    return Array.from({ length: count + 1 }, (_, i) => -size / 2 + i * step);
  };
  return { xs: along(width), ys: along(height) };
}
