/**
 * The one place that turns "the room was recognised" into "the door stands here"
 * (`localization-server/docs/api-v2.md`, section 5). Every way of recognising the room -
 * the venue's own server, ReactVision Advanced VPS - hands in the same thing, a room
 * transform; the door record is the same for all of them. Pure TypeScript: `DoorPlacer`
 * adds the screen, the log and the network.
 */
import { decide, type Decision, type DoorCandidate } from '../../localization/core/relocalization';
import { type Mat4, multiply } from '../../localization/core/vpsAlignment';
import type { PlanOpening, PlanRect, ServerPortal, ServerRoom, SuggestedDoor, V3 } from '../../server/core/roomPlan';
import { doorMayBeShown } from '../../ui/core/modes';
import {
  applyToPoint,
  matrixFromPose,
  poseInRoom,
  poseInSession,
  type Quat,
  quaternionFromViroEuler,
  scaleOf,
  viroEulerOf,
} from './roomFrame';

/** A length of the room in the session, to a tenth of a millimetre (a metric map's scale is 1 only up to rounding). */
const sized = (value: number | null, scale: number) => (value === null ? null : Math.round(value * scale * 1e4) / 1e4);

function suggestedInSession(room: Mat4, door: SuggestedDoor, scale: number): SuggestedDoor {
  const pose = poseInSession(room, door.position, door.quaternion ?? quaternionFromViroEuler(door.rotation));
  return { ...door, position: pose.position, rotation: pose.rotation, quaternion: pose.quaternion, width: sized(door.width, scale), height: sized(door.height, scale) };
}

/**
 * The door record of a room (frame of the room) as it stands in this AR session: the
 * door, and the doorway the server suggests next to it. Lengths follow the scale of the
 * transform (1 for a metric map).
 */
export function portalInSession(room: Mat4, record: ServerPortal): ServerPortal {
  const scale = scaleOf(room);
  const suggested = record.suggested ? suggestedInSession(room, record.suggested, scale) : null;
  if (!record.position || !record.rotation) {
    return { ...record, suggested };
  }
  const pose = poseInSession(room, record.position, record.quaternion ?? quaternionFromViroEuler(record.rotation));
  return {
    ...record,
    position: pose.position,
    rotation: pose.rotation,
    quaternion: pose.quaternion,
    width: sized(record.width, scale),
    height: sized(record.height, scale),
    suggested,
  };
}

function rectInSession<T extends PlanRect>(room: Mat4, rect: T, scale: number): T {
  const m = multiply(room, matrixFromPose(rect.position, quaternionFromViroEuler(rect.rotation)));
  return {
    ...rect,
    position: [m[12], m[13], m[14]],
    rotation: viroEulerOf(m),
    width: rect.width * scale,
    height: rect.height * scale,
    corners: rect.corners.map((corner) => applyToPoint(room, corner)),
  };
}

/**
 * The room plan (frame of the room) in this AR session - for a way of recognising the
 * room that does not hand the plan out itself. Levels are heights, so they are read off
 * a point at that height.
 */
export function roomInSession(room: Mat4, plan: ServerRoom): ServerRoom {
  const scale = scaleOf(room);
  const level = (y: number | null) => (y === null ? null : applyToPoint(room, [0, y, 0])[1]);
  const opening = (item: PlanOpening): PlanOpening => {
    const portal = poseInSession(room, item.portalPosition, quaternionFromViroEuler(item.portalRotation));
    return { ...rectInSession(room, item, scale), portalPosition: portal.position, portalRotation: portal.rotation };
  };
  return {
    ...plan,
    frame: 'arworld',
    floorLevel: level(plan.floorLevel),
    ceilingLevel: level(plan.ceilingLevel),
    floorOutline: plan.floorOutline ? plan.floorOutline.map((p) => applyToPoint(room, p)) : null,
    walls: plan.walls.map((wall) => rectInSession(room, wall, scale)),
    corners: plan.corners.map((corner) => ({ ...corner, bottom: applyToPoint(room, corner.bottom), top: applyToPoint(room, corner.top) })),
    openings: plan.openings.map(opening),
  };
}

/**
 * The door of a record as a pose that may be shown, or null: a door stands only where a
 * staff member saved one (`ui-spec.md`, 4.3 and 5.9). A doorway the server found by
 * itself is a suggestion for the placing screen.
 */
export function doorCandidate(portal: ServerPortal | null, strong: boolean): DoorCandidate | null {
  if (!portal || !doorMayBeShown(portal.source) || !portal.position || !portal.rotation) {
    return null;
  }
  return { position: portal.position, rotation: portal.rotation, strong };
}

export interface Settled {
  /** The record in this session's frame: what the placing screen and the plan read. */
  portal: ServerPortal;
  decision: Decision;
}

/**
 * What a recognised room means for the door on screen. `shown` / `shownTrusted`: the door
 * that stands now. `strong`: false when the way called its own answer weak. `always`: put
 * the door there whatever stands (the room was scanned in this very session).
 */
export function settle(
  shown: DoorCandidate | null,
  shownTrusted: boolean,
  room: Mat4,
  record: ServerPortal,
  strong: boolean,
  always = false,
  /** Nobody asked for this look: a jump beyond `MAX_JUMP_*` is not taken (see `decide`). */
  limitJump = false,
): Settled {
  const portal = portalInSession(room, record);
  const door = doorCandidate(portal, strong);
  if (always) {
    return { portal, decision: door ? { action: 'place', door } : { action: 'no-doorway' } };
  }
  const decision = decide(shown, shownTrusted, {
    quality: strong ? 'good' : 'weak',
    alignmentStatus: 'ok',
    door: door ? { position: door.position, rotation: door.rotation } : null,
  }, { limitJump });
  return { portal, decision };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** What `PUT /maps/{map_id}/anchors/portal` takes for a door given in the room's frame. */
export interface DoorRecordBody {
  position: V3;
  quaternion_xyzw: Quat;
  width?: number;
  height?: number;
}

/**
 * "Save door": the door as it stands in this AR session, written down in the room's frame.
 * The same for every way the room was recognised through. A server that does not store the
 * size is not sent one: other phones then draw the default door.
 */
export function doorRecordBody(
  room: Mat4,
  door: { position: readonly number[]; yaw: number; width: number; height: number },
  withSize: boolean,
): DoorRecordBody {
  const scale = scaleOf(room) || 1;
  const pose = poseInRoom(room, door.position, door.yaw);
  const body: DoorRecordBody = {
    position: pose.position.map((n) => round(n, 4)) as V3,
    quaternion_xyzw: pose.quaternion.map((n) => round(n, 6)) as Quat,
  };
  return withSize ? { ...body, width: round(door.width / scale, 3), height: round(door.height / scale, 3) } : body;
}
