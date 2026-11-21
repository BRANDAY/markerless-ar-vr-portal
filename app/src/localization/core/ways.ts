/**
 * Two ways of recognising one room - the venue's own server and ReactVision Advanced VPS
 * - and what links them (`localization-server/docs/api-v2.md`, section 11): which way to
 * take, how the service's answer becomes "where is the room", and which readings go into
 * a measurement of the bridge between the two. Pure TypeScript.
 */
import { matrixFromYaw, rowsFromMatrix } from '../../door/core/roomFrame';
import { type MapInSession, type Mat4, multiply } from './vpsAlignment';

/** The service's map in this AR session as a matrix (`T_arworld_from_service`). */
export function serviceInSession(map: MapInSession): Mat4 {
  return matrixFromYaw(map.shift, map.yawDeg);
}

/**
 * Where the ROOM lies in this AR session, from where the service's map lies in it and the
 * room's bridge: `T_arworld_from_room = T_arworld_from_service x T_service_from_map`.
 */
export function roomThroughBridge(map: MapInSession, serviceFromRoom: Mat4): Mat4 {
  return multiply(serviceInSession(map), serviceFromRoom);
}

export type Way = 'self-hosted' | 'reactvision-vps';

/**
 * The way a room is looked for. Staff set a preference (`ui-spec.md`, 5.15); when that way
 * cannot work, the other one is taken, so that a visitor sees no difference:
 *  - ReactVision preferred, but this build has no keys or the room has no place or no
 *    measured bridge there: the venue's server;
 *  - the venue's server preferred, but it is known to be unreachable, and the room can be
 *    recognised through ReactVision: ReactVision (the door then comes from the copy the
 *    phone kept). While the server is still being looked for, it stays the way.
 */
export function chooseWay(input: {
  preferred: 'server' | 'reactvision';
  /** Keys in the build, a place at the service and a bridge for the room's current frame. */
  cloudReady: boolean;
  server: 'connected' | 'trying' | 'unreachable';
}): Way {
  if (input.preferred === 'reactvision') {
    return input.cloudReady ? 'reactvision-vps' : 'self-hosted';
  }
  return input.server === 'unreachable' && input.cloudReady ? 'reactvision-vps' : 'self-hosted';
}

// ---- measuring the bridge -----------------------------------------------------------------

export const BRIDGE = {
  /** This many samples make a measurement... */
  samples: 8,
  /** ...and with this many it may be ended by hand. */
  enough: 4,
  /** A sample is taken at least this far from every earlier one (where the phone was)... */
  minApartM: 0.4,
  /** ...and this long after the one before. */
  minGapMs: 1500,
  /** The service has this long to recognise the place at all. */
  giveUpS: 120,
} as const;

/**
 * The samples of one bridge measurement: where the service's map lay in the session, seen
 * from different places in the room. The server asks for "several samples from different
 * places, a few seconds apart" and does the averaging itself.
 */
export class BridgeSamples {
  private taken: { at: number; camera: number[]; map: MapInSession }[] = [];

  /** Offers a steady reading taken with the phone at `camera`. True when it became a sample. */
  offer(map: MapInSession, camera: readonly number[], nowMs: number): boolean {
    if (this.complete) {
      return false;
    }
    const last = this.taken[this.taken.length - 1];
    if (last && nowMs - last.at < BRIDGE.minGapMs) {
      return false;
    }
    const near = this.taken.some(
      (sample) => Math.hypot(sample.camera[0] - camera[0], sample.camera[1] - camera[1], sample.camera[2] - camera[2]) < BRIDGE.minApartM,
    );
    if (near) {
      return false;
    }
    this.taken.push({ at: nowMs, camera: [camera[0], camera[1], camera[2]], map });
    return true;
  }

  get count(): number {
    return this.taken.length;
  }

  get complete(): boolean {
    return this.taken.length >= BRIDGE.samples;
  }

  /** Enough to send, if the staff member ends the walk here. */
  get enough(): boolean {
    return this.taken.length >= BRIDGE.enough;
  }

  /** The samples as `POST /maps/{id}/vps/bridge` takes them. */
  body(): { T_arworld_from_service: number[][] }[] {
    return this.taken.map((sample) => ({ T_arworld_from_service: rowsFromMatrix(serviceInSession(sample.map)) }));
  }

  reset(): void {
    this.taken = [];
  }
}
