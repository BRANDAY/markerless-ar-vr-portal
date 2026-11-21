/**
 * Placing the door by hand (`docs/product/ui-spec.md`, 5.14): where "Put it here" puts
 * it, and the steps of the adjust panel. Pure. The door stands on the floor, upright: a
 * position and a yaw. Its own axes are those of the doorway frame of the app: +X along
 * the door (to the right, seen from the room), +Z into the room, where the visitor stands.
 */

type V3 = readonly [number, number, number] | readonly number[];

export interface DoorDraft {
  position: [number, number, number];
  /** Degrees about the vertical, as in a ViroReact rotation `[0, yaw, 0]`. */
  yaw: number;
  width: number;
  height: number;
}

export const DOOR_EDIT = {
  moveM: 0.05,
  turnDeg: 5,
  sizeM: 0.05,
  minWidth: 0.6,
  maxWidth: 1.4,
  minHeight: 1.8,
  maxHeight: 2.4,
  defaultWidth: 0.9,
  defaultHeight: 2.0,
} as const;

const DEG = Math.PI / 180;
const mm = (value: number) => Math.round(value * 1000) / 1000;
const cm = (value: number) => Math.round(value * 100) / 100;

/** A yaw in (-180, 180]. */
export function normalizeYaw(yaw: number): number {
  const turned = ((((yaw + 180) % 360) + 360) % 360) - 180;
  return turned === -180 ? 180 : Math.round(turned * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A size within what a door can be; anything unusable becomes the default. */
export function doorSize(width: number | null | undefined, height: number | null | undefined): { width: number; height: number } {
  const usable = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  return {
    width: cm(clamp(usable(width) ? width : DOOR_EDIT.defaultWidth, DOOR_EDIT.minWidth, DOOR_EDIT.maxWidth)),
    height: cm(clamp(usable(height) ? height : DOOR_EDIT.defaultHeight, DOOR_EDIT.minHeight, DOOR_EDIT.maxHeight)),
  };
}

/**
 * "Put it here": the door on the aimed spot of the floor, turned to face the camera. The
 * side the staff member stands on is the room side (+Z).
 */
export function doorAt(spot: V3, camera: V3, size: { width: number; height: number }): DoorDraft {
  const dx = camera[0] - spot[0];
  const dz = camera[2] - spot[2];
  // Standing on the spot gives no direction: the door then faces along -Z of the session.
  const yaw = Math.hypot(dx, dz) < 0.05 ? 0 : Math.atan2(dx, dz) / DEG;
  return { position: [mm(spot[0]), mm(spot[1]), mm(spot[2])], yaw: normalizeYaw(yaw), ...size };
}

/**
 * Moves the door by steps of 5 cm: `along` to the right (+) or left (-) along the door,
 * `towardsRoom` towards the room (+) or away from it (-).
 */
export function moveDoor(door: DoorDraft, along: number, towardsRoom: number): DoorDraft {
  const lx = along * DOOR_EDIT.moveM;
  const lz = towardsRoom * DOOR_EDIT.moveM;
  const cos = Math.cos(door.yaw * DEG);
  const sin = Math.sin(door.yaw * DEG);
  return {
    ...door,
    position: [mm(door.position[0] + lx * cos + lz * sin), door.position[1], mm(door.position[2] - lx * sin + lz * cos)],
  };
}

/** Turns the door by steps of 5 degrees (positive = anticlockwise seen from above). */
export function turnDoor(door: DoorDraft, steps: number): DoorDraft {
  return { ...door, yaw: normalizeYaw(door.yaw + steps * DOOR_EDIT.turnDeg) };
}

/** Swaps the room side and the space side. */
export function turnAround(door: DoorDraft): DoorDraft {
  return { ...door, yaw: normalizeYaw(door.yaw + 180) };
}

/** Changes the size by steps of 5 cm, within 0.60-1.40 m and 1.80-2.40 m. */
export function resizeDoor(door: DoorDraft, widthSteps: number, heightSteps: number): DoorDraft {
  return {
    ...door,
    width: cm(clamp(door.width + widthSteps * DOOR_EDIT.sizeM, DOOR_EDIT.minWidth, DOOR_EDIT.maxWidth)),
    height: cm(clamp(door.height + heightSteps * DOOR_EDIT.sizeM, DOOR_EDIT.minHeight, DOOR_EDIT.maxHeight)),
  };
}

/**
 * The heading of a door the server describes with ViroReact Euler degrees (R = Rz·Ry·Rx):
 * where its +Z points on the floor plan. The same upright door can arrive as [0, 200, 0]
 * or as [180, -20, 180], so the middle number alone is not the heading.
 */
export function yawFromEuler(rotation: V3): number {
  const [x, y, z] = [rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG];
  const towardsX = Math.cos(x) * Math.sin(y) * Math.cos(z) + Math.sin(x) * Math.sin(z);
  const towardsZ = Math.cos(x) * Math.cos(y);
  return normalizeYaw(Math.atan2(towardsX, towardsZ) / DEG);
}

/** A door of the server (saved, or a found doorway) as a draft to edit. */
export function draftFromServer(door: {
  position: V3;
  rotation: V3;
  width?: number | null;
  height?: number | null;
}): DoorDraft {
  return {
    position: [mm(door.position[0]), mm(door.position[1]), mm(door.position[2])],
    yaw: yawFromEuler(door.rotation),
    ...doorSize(door.width, door.height),
  };
}

/** Where a door is put when nothing says otherwise, and what counts as a floor under the phone. */
export const PLACING = {
  /** "On the floor 2 m in front of the camera". */
  frontM: 2,
  /** A floor plane closer than this under the phone is a table, not the floor. */
  minFloorBelowCameraM: 0.4,
  /** The floor when none is known: this far under the phone. */
  assumedCameraHeightM: 1.4,
  /** "Put it here" follows the aim only when the phone points at least this far down... */
  minAimDownDeg: 8,
  /** ...at a spot no further away than this. */
  maxAimM: 6,
} as const;

/** The height of the floor to stand the door on: the detected one if it can be the floor. */
export function floorUnder(camera: V3, floorY: number | null): number {
  return floorY !== null && camera[1] - floorY >= PLACING.minFloorBelowCameraM ? floorY : camera[1] - PLACING.assumedCameraHeightM;
}

/**
 * The door on the floor two metres in front of the camera, facing it. Null when the phone
 * points straight up or down: there is no "in front" then.
 */
export function doorInFront(camera: V3, forward: V3, floorY: number | null, size: { width: number; height: number }): DoorDraft | null {
  const flat = Math.hypot(forward[0], forward[2]);
  if (!(flat > 1e-3)) {
    return null;
  }
  const spot = [
    camera[0] + (forward[0] / flat) * PLACING.frontM,
    floorUnder(camera, floorY),
    camera[2] + (forward[2] / flat) * PLACING.frontM,
  ];
  return doorAt(spot, camera, size);
}

/** The spot on the floor the middle of the camera picture looks at, or null when it looks at no usable one. */
export function aimedSpot(camera: V3, forward: V3, floorY: number | null): [number, number, number] | null {
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  if (!(length > 1e-6)) {
    return null;
  }
  const f = [forward[0] / length, forward[1] / length, forward[2] / length];
  if (-f[1] < Math.sin(PLACING.minAimDownDeg * DEG)) {
    return null;
  }
  const floor = floorUnder(camera, floorY);
  const along = (camera[1] - floor) / -f[1];
  if (along * Math.hypot(f[0], f[2]) > PLACING.maxAimM) {
    return null;
  }
  return [camera[0] + f[0] * along, floor, camera[2] + f[2] * along];
}

/**
 * "Put it here": the door on the aimed spot of the floor, facing the camera. When the
 * phone is not aimed at the floor, the door goes two metres in front of the camera.
 */
export function putHere(camera: V3, forward: V3, floorY: number | null, size: { width: number; height: number }): DoorDraft | null {
  const spot = aimedSpot(camera, forward, floorY);
  return spot ? doorAt(spot, camera, size) : doorInFront(camera, forward, floorY, size);
}

/** What the server is sent for a door placed in the running AR session (api-v2, section 5). */
export function doorSaveBody(
  door: DoorDraft,
  sessionId: string,
  withSize: boolean,
): {
  ar_pose: { position: [number, number, number]; rotation: [number, number, number] };
  session_id: string;
  width?: number;
  height?: number;
} {
  const body = {
    ar_pose: { position: [...door.position] as [number, number, number], rotation: [0, door.yaw, 0] as [number, number, number] },
    session_id: sessionId,
  };
  // A server that does not store the size is not sent one: other phones draw 0.90 x 2.00 m.
  return withSize ? { ...body, width: door.width, height: door.height } : body;
}

/** Whether two drafts are the same door (to know if there is something to save). */
export function sameDoor(a: DoorDraft, b: DoorDraft): boolean {
  return (
    Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) < 0.002 &&
    Math.abs(normalizeYaw(a.yaw - b.yaw)) < 0.2 &&
    Math.abs(a.width - b.width) < 0.005 &&
    Math.abs(a.height - b.height) < 0.005
  );
}

/** "0.85 × 2.05 m" */
export function sizeLabel(door: { width: number; height: number }): string {
  return `${door.width.toFixed(2)} × ${door.height.toFixed(2)} m`;
}
