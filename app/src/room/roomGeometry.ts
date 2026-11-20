/**
 * Room model built from the planes the AR session detects. Pure TypeScript, unit-tested.
 *
 * Input: plane anchors as ViroReact reports them (metres; `position` and `rotation` are
 * the plane's pose in the AR world frame, `vertices` a polygon in the plane's own frame
 * with the plane spanning local X/Z and local +Y as its normal).
 * Output: the same planes in AR-world coordinates, sorted into floor / walls / ceiling,
 * plus the room corners (where two walls meet at the floor).
 *
 * Conventions as everywhere in the app: right-handed, +Y up, Euler degrees R = Rz*Ry*Rx.
 */
import { add, rotateByViroEuler } from '../localization/math';
import type { Vec3 } from '../localization/types';

/** One plane anchor, reduced to what the room model needs. */
export interface PlaneAnchorData {
  anchorId: string;
  position: Vec3;
  /** Euler degrees. */
  rotation: Vec3;
  /** Offset of the plane's centre from `position`, in the plane's frame. */
  center?: Vec3;
  /** Extent along local X / local Z, metres. */
  width?: number;
  height?: number;
  alignment?: string;
  classification?: string;
  /** Boundary polygon in the plane's frame; only x and z are used. */
  vertices?: Vec3[];
}

export type PlaneKind = 'floor' | 'ceiling' | 'wall' | 'surface';

export interface WorldPlane {
  anchorId: string;
  kind: PlaneKind;
  alignment: string;
  classification: string;
  /** Pose of the plane's own frame in the AR world frame (Euler degrees). */
  position: Vec3;
  rotation: Vec3;
  /** Unit normal in the AR world frame. */
  normal: Vec3;
  /** Boundary polygon in the plane's frame, y = 0. */
  localVertices: Vec3[];
  /** The same polygon in the AR world frame. */
  vertices: Vec3[];
  centroid: Vec3;
  /** Square metres. */
  area: number;
  minY: number;
  maxY: number;
}

export interface RoomCorner {
  /** On the floor (or at the walls' lowest point when no floor is known). */
  position: Vec3;
  /** Height of the lower of the two walls above `position`. */
  height: number;
  wallIds: [string, string];
}

export interface RoomModel {
  planes: WorldPlane[];
  /** World Y of the floor, null until a floor plane is known. */
  floorY: number | null;
  corners: RoomCorner[];
  wallCount: number;
  floorArea: number;
}

/** A horizontal plane this far above the lowest one is furniture, not floor. */
const FLOOR_BAND_M = 0.15;
/** Walls whose normals differ by less than this are treated as the same direction. */
const MIN_CORNER_ANGLE_DEG = 30;
/** A corner may lie this far beyond the detected end of a wall (planes grow slowly). */
const CORNER_REACH_M = 0.6;
const MERGE_CORNERS_M = 0.3;

function isFiniteVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Keeps only what the model needs from a ViroReact anchor; null for anything unusable. */
export function toPlaneAnchorData(anchor: unknown): PlaneAnchorData | null {
  if (!anchor || typeof anchor !== 'object') {
    return null;
  }
  const a = anchor as Record<string, unknown>;
  if (a.type !== 'plane' || typeof a.anchorId !== 'string' || !isFiniteVec3(a.position)) {
    return null;
  }
  const vertices = Array.isArray(a.vertices) ? a.vertices.filter(isFiniteVec3) : undefined;
  return {
    anchorId: a.anchorId,
    position: a.position,
    rotation: isFiniteVec3(a.rotation) ? a.rotation : [0, 0, 0],
    center: isFiniteVec3(a.center) ? a.center : undefined,
    width: typeof a.width === 'number' ? a.width : undefined,
    height: typeof a.height === 'number' ? a.height : undefined,
    alignment: typeof a.alignment === 'string' ? a.alignment : undefined,
    classification: typeof a.classification === 'string' ? a.classification : undefined,
    vertices: vertices && vertices.length >= 3 ? vertices : undefined,
  };
}

/** The boundary in the plane's frame: the reported polygon, or the extent rectangle. */
export function localPolygon(anchor: PlaneAnchorData): Vec3[] {
  if (anchor.vertices && anchor.vertices.length >= 3) {
    return anchor.vertices.map((v) => [v[0], 0, v[2]] as Vec3);
  }
  const [cx, , cz] = anchor.center ?? [0, 0, 0];
  const hw = Math.max(anchor.width ?? 0, 0.05) / 2;
  const hh = Math.max(anchor.height ?? 0, 0.05) / 2;
  return [
    [cx - hw, 0, cz - hh],
    [cx + hw, 0, cz - hh],
    [cx + hw, 0, cz + hh],
    [cx - hw, 0, cz + hh],
  ];
}

/** Area of a polygon lying in the XZ plane (shoelace formula). */
export function polygonAreaXZ(polygon: Vec3[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twice += a[0] * b[2] - b[0] * a[2];
  }
  return Math.abs(twice) / 2;
}

function planeToWorld(anchor: PlaneAnchorData): Omit<WorldPlane, 'kind'> {
  const localVertices = localPolygon(anchor);
  const vertices = localVertices.map((v) => add(anchor.position, rotateByViroEuler(v, anchor.rotation)));
  const centroid: Vec3 = [0, 0, 0];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    centroid[0] += v[0] / vertices.length;
    centroid[1] += v[1] / vertices.length;
    centroid[2] += v[2] / vertices.length;
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
  }
  return {
    anchorId: anchor.anchorId,
    alignment: anchor.alignment ?? '',
    classification: anchor.classification ?? '',
    position: anchor.position,
    rotation: anchor.rotation,
    normal: rotateByViroEuler([0, 1, 0], anchor.rotation),
    localVertices,
    vertices,
    centroid,
    area: polygonAreaXZ(localVertices),
    minY,
    maxY,
  };
}

/**
 * Vertical: |normal.y| small. The alignment string is used when present, the normal
 * otherwise, so the model does not depend on how a platform names its alignments.
 */
function orientation(plane: Omit<WorldPlane, 'kind'>): 'vertical' | 'up' | 'down' {
  if (plane.alignment === 'Vertical') {
    return 'vertical';
  }
  if (plane.alignment === 'HorizontalDownward') {
    return 'down';
  }
  if (plane.alignment.startsWith('Horizontal')) {
    return 'up';
  }
  if (Math.abs(plane.normal[1]) < 0.5) {
    return 'vertical';
  }
  return plane.normal[1] > 0 ? 'up' : 'down';
}

interface WallLine {
  id: string;
  /** A point of the wall, in XZ. */
  px: number;
  pz: number;
  /** Unit normal in XZ. */
  nx: number;
  nz: number;
  /** Extent along the tangent (-nz, nx), relative to (px, pz). */
  tMin: number;
  tMax: number;
  minY: number;
  maxY: number;
}

function wallLine(plane: WorldPlane): WallLine | null {
  const horizontal = Math.hypot(plane.normal[0], plane.normal[2]);
  if (horizontal < 0.5) {
    return null;
  }
  const nx = plane.normal[0] / horizontal;
  const nz = plane.normal[2] / horizontal;
  const px = plane.centroid[0];
  const pz = plane.centroid[2];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const v of plane.vertices) {
    const t = (v[0] - px) * -nz + (v[2] - pz) * nx;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  return { id: plane.anchorId, px, pz, nx, nz, tMin, tMax, minY: plane.minY, maxY: plane.maxY };
}

function findCorners(walls: WorldPlane[], floorY: number | null): RoomCorner[] {
  const lines = walls.map(wallLine).filter((line): line is WallLine => line !== null);
  const minSin = Math.sin((MIN_CORNER_ANGLE_DEG * Math.PI) / 180);
  const corners: RoomCorner[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const cross = a.nx * b.nz - a.nz * b.nx;
      if (Math.abs(cross) < minSin) {
        continue; // parallel or nearly so: no corner
      }
      // Point X with na.(X - pa) = 0 and nb.(X - pb) = 0.
      const da = a.nx * a.px + a.nz * a.pz;
      const db = b.nx * b.px + b.nz * b.pz;
      const x = (da * b.nz - db * a.nz) / cross;
      const z = (a.nx * db - b.nx * da) / cross;
      const ta = (x - a.px) * -a.nz + (z - a.pz) * a.nx;
      const tb = (x - b.px) * -b.nz + (z - b.pz) * b.nx;
      const reaches = (t: number, line: WallLine) =>
        t >= line.tMin - CORNER_REACH_M && t <= line.tMax + CORNER_REACH_M;
      if (!reaches(ta, a) || !reaches(tb, b)) {
        continue;
      }
      const y = floorY ?? Math.min(a.minY, b.minY);
      const height = Math.max(0, Math.min(a.maxY, b.maxY) - y);
      if (corners.some((c) => Math.hypot(c.position[0] - x, c.position[2] - z) < MERGE_CORNERS_M)) {
        continue;
      }
      corners.push({ position: [x, y, z], height, wallIds: [a.id, b.id] });
    }
  }
  return corners;
}

/** Builds the room model from the planes currently known to the AR session. */
export function buildRoom(anchors: Iterable<PlaneAnchorData>): RoomModel {
  const raw = Array.from(anchors, planeToWorld);
  const upward = raw.filter((plane) => orientation(plane) === 'up');
  // The floor is the lowest upward-facing plane; small planes are ignored while a
  // bigger one exists, because a patch detected on a dark rug is often too low or high.
  const sizeable = upward.filter((plane) => plane.area >= 0.5);
  const candidates = sizeable.length > 0 ? sizeable : upward;
  const floorY = candidates.length > 0 ? Math.min(...candidates.map((plane) => plane.centroid[1])) : null;

  const planes: WorldPlane[] = raw.map((plane) => {
    const kind: PlaneKind = (() => {
      switch (orientation(plane)) {
        case 'vertical':
          return 'wall';
        case 'down':
          return 'ceiling';
        default:
          return floorY !== null && plane.centroid[1] <= floorY + FLOOR_BAND_M ? 'floor' : 'surface';
      }
    })();
    return { ...plane, kind };
  });

  const walls = planes.filter((plane) => plane.kind === 'wall');
  return {
    planes,
    floorY,
    corners: findCorners(walls, floorY),
    wallCount: walls.length,
    floorArea: planes.filter((plane) => plane.kind === 'floor').reduce((sum, plane) => sum + plane.area, 0),
  };
}

export const EMPTY_ROOM: RoomModel = { planes: [], floorY: null, corners: [], wallCount: 0, floorArea: 0 };
