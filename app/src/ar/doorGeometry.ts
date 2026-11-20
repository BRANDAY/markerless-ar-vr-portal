/**
 * Dimensions of the doorway and of the virtual room, in metres.
 * The DOOR numbers must match `scripts/generate-assets.mjs`, which builds the OBJ.
 */
export const DOOR = {
  openingWidth: 0.9,
  openingHeight: 2.0,
  postWidth: 0.08,
  lintelHeight: 0.08,
  thresholdHeight: 0.02,
  /** Frame thickness on the AR side of the crossing plane (local z > 0). */
  depthFront: 0.06,
  /** Frame thickness on the room side (local z < 0). */
  depthBack: 0.14,
} as const;

/**
 * The door model's origin is the CENTRE OF THE OPENING (the portal renderer needs that,
 * see README), while a door pose from a provider means "on the floor, middle of the
 * threshold". This is the distance between the two.
 */
export const DOOR_ORIGIN_HEIGHT = DOOR.openingHeight / 2 + DOOR.thresholdHeight;

/** Outer size of the frame, used to cut the matching hole into the room's front wall. */
export const DOOR_OUTER_HALF_WIDTH = DOOR.openingWidth / 2 + DOOR.postWidth;
export const DOOR_OUTER_HEIGHT = DOOR.thresholdHeight + DOOR.openingHeight + DOOR.lintelHeight;

/** The virtual room: a closed box behind the doorway (door-local -Z), floor at y = 0. */
export const ROOM = {
  width: 4,
  height: 2.8,
  depth: 5,
  /** Z of the wall that contains the doorway: just behind the back face of the frame. */
  frontZ: -(DOOR.depthBack + 0.01),
} as const;

/**
 * Light bit masks. ViroReact lights are global to the whole scene graph (a light inside the
 * portal would also light the AR objects and vice versa), so the two worlds are separated
 * with `influenceBitMask` / `lightReceivingBitMask`.
 */
export const LIGHT_MASK_AR = 1;
export const LIGHT_MASK_ROOM = 2;
