/**
 * A room plan as a flat drawing: the server's walls, corners and door openings seen from
 * above, fitted into a box of screen points (`docs/product/ui-spec.md`, 5.4 and 5.8).
 * Pure; the component that draws it only places lines.
 */

type V3 = readonly [number, number, number] | readonly number[];

/** The parts of the server's room plan the drawing needs. */
export interface PlanSource {
  walls: { id: string; corners: V3[]; width: number }[];
  corners: { bottom: V3 }[];
  openings: { id: string; corners: V3[]; width: number; height: number; heightMeasured: boolean; state: string; portalPosition: V3 }[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

export interface PlanLayout {
  walls: (Segment & { id: string; lengthM: number })[];
  corners: Point[];
  openings: (Segment & {
    id: string;
    /** "A", "B", "C" in the server's order (best first). */
    letter: string;
    chosen: boolean;
    widthM: number;
    heightM: number;
    heightMeasured: boolean;
    state: string;
    middle: Point;
  })[];
  /** The door staff saved, as a segment across its width; null when there is none. */
  door: Segment | null;
  /** Screen points per metre. */
  scale: number;
  /** A one-metre bar: its length in screen points. */
  metreBar: number;
}

/** Position on the floor: the server's X to the right, its Z down the drawing. */
function floor(p: V3): Point {
  return { x: p[0], y: p[2] };
}

/** The saved door on the floor plan: where it stands, where its room side looks, how wide it is. */
export interface PlanDoor {
  position: V3;
  /** Degrees about the vertical; the door's own +X is (cos, 0, -sin) of it. */
  yaw: number;
  width: number;
}

/**
 * @param chosenAt  the position of the doorway in use, in the plan's frame; the opening
 *                  nearest to it within half a metre is marked as chosen
 * @param door      the door staff saved; it need not stand in a doorway
 */
export function planLayout(
  source: PlanSource,
  boxWidth: number,
  boxHeight: number,
  chosenAt: V3 | null = null,
  padding = 16,
  door: PlanDoor | null = null,
): PlanLayout | null {
  let doorSegment: Segment | null = null;
  if (door) {
    const half = door.width / 2;
    const along = { x: Math.cos((door.yaw * Math.PI) / 180), y: -Math.sin((door.yaw * Math.PI) / 180) };
    const middle = floor(door.position);
    doorSegment = {
      a: { x: middle.x - along.x * half, y: middle.y - along.y * half },
      b: { x: middle.x + along.x * half, y: middle.y + along.y * half },
    };
  }
  const wallSegments = source.walls
    .filter((wall) => wall.corners.length >= 2)
    .map((wall) => ({ id: wall.id, a: floor(wall.corners[0]), b: floor(wall.corners[1]), lengthM: wall.width }));
  const openingSegments = source.openings
    .filter((opening) => opening.corners.length >= 2)
    .map((opening) => ({ opening, a: floor(opening.corners[0]), b: floor(opening.corners[1]) }));
  const points: Point[] = [
    ...wallSegments.flatMap((s) => [s.a, s.b]),
    ...openingSegments.flatMap((s) => [s.a, s.b]),
    ...source.corners.map((c) => floor(c.bottom)),
    ...(doorSegment ? [doorSegment.a, doorSegment.b] : []),
  ];
  if (points.length < 2) {
    return null;
  }
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);
  const scale = Math.min((boxWidth - 2 * padding) / spanX, (boxHeight - 2 * padding) / spanY);
  // Centred in the box.
  const offsetX = (boxWidth - spanX * scale) / 2;
  const offsetY = (boxHeight - spanY * scale) / 2;
  const place = (p: Point): Point => ({ x: offsetX + (p.x - minX) * scale, y: offsetY + (p.y - minY) * scale });

  let chosenId: string | null = null;
  if (chosenAt) {
    let best = 0.5;
    for (const { opening } of openingSegments) {
      const d = Math.hypot(opening.portalPosition[0] - chosenAt[0], opening.portalPosition[2] - chosenAt[2]);
      if (d <= best) {
        best = d;
        chosenId = opening.id;
      }
    }
  }

  return {
    walls: wallSegments.map((s) => ({ id: s.id, a: place(s.a), b: place(s.b), lengthM: s.lengthM })),
    corners: source.corners.map((c) => place(floor(c.bottom))),
    openings: openingSegments.map(({ opening, a, b }, index) => {
      const pa = place(a);
      const pb = place(b);
      return {
        id: opening.id,
        letter: String.fromCharCode(65 + index),
        chosen: opening.id === chosenId,
        widthM: opening.width,
        heightM: opening.height,
        heightMeasured: opening.heightMeasured,
        state: opening.state,
        a: pa,
        b: pb,
        middle: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
      };
    }),
    door: doorSegment ? { a: place(doorSegment.a), b: place(doorSegment.b) } : null,
    scale,
    metreBar: scale,
  };
}

/** A segment as a rotated bar: centre, length and angle, for a view with `rotate`. */
export function segmentBar(segment: Segment): { cx: number; cy: number; length: number; angleDeg: number } {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  return {
    cx: (segment.a.x + segment.b.x) / 2,
    cy: (segment.a.y + segment.b.y) / 2,
    length: Math.hypot(dx, dy),
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}
