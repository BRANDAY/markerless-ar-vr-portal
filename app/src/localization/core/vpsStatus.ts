/**
 * What the states and errors of ReactVision Advanced VPS mean for the app (the library's
 * `<ViroVPS>`; `docs/cloud/cloud-connection.md`). Pure TypeScript.
 *
 * The service never says "attempt 2 of 5": it searches until it tracks. So the coach
 * lines of the search follow the time spent, and after a while the search is declared
 * unsuccessful, as a search through the venue's own server is after its attempts.
 */

/** The library's tracking states. */
export type VpsState = 'idle' | 'searching' | 'mapLoaded' | 'tracking' | 'lost' | 'error' | 'unsupported';

/** Why the cloud way cannot work, in the terms the screens tell apart. */
export type VpsProblem =
  /** The build has no keys, or the service refuses them: staff have to set something up. */
  | 'not-set-up'
  /** No answer from the service: the phone is offline, or the service is. */
  | 'offline'
  /** The service answered and refused: plan, spend limit, no map for the place. */
  | 'refused'
  /** This phone or this build of the AR engine cannot do it. */
  | 'unsupported';

/**
 * The library's error codes (`ViroVPS.tsx`, `ViroVPSErrorDetail.code`) sorted into the
 * problems above. `SUPERSEDED` is no problem: a newer start replaced this one.
 */
export function vpsProblem(code: string | null | undefined): VpsProblem | null {
  switch (code) {
    case 'SUPERSEDED':
      return null;
    case 'CREDENTIALS_UNAVAILABLE':
    case 'VPS_SERVER_NOT_CONFIGURED':
    case 'INVALID_APP_USER_ID':
    case 'ENDPOINT_NOT_ALLOWED':
    case 'API_KEY_TYPE_NOT_ALLOWED':
      return 'not-set-up';
    case 'NETWORK_ERROR':
    case 'HTTP_ERROR':
      return 'offline';
    case 'UNSUPPORTED':
      return 'unsupported';
    default:
      // NO_LOCATION, NO_ASSET, NO_SERVER_MAP, MAP_LOAD_FAILED, PAID_PLAN_REQUIRED,
      // COMPUTE_SPEND_LIMIT_REACHED, LOCALIZATION_UNAVAILABLE, UNKNOWN and whatever comes later.
      return 'refused';
  }
}

/** The search through the service, by the seconds it has taken. */
export const VPS_SEARCH = {
  /** "Try another view" from here on... */
  anotherViewS: 15,
  /** ..."Still looking" from here on... */
  stillLookingS: 40,
  /** ...and here the search is given up: "This doesn't look like {room}". */
  giveUpS: 90,
} as const;

/**
 * The number the screens read as "attempt" (1 = "Point at the room and hold still",
 * 2-3 = "Try another view", 4-5 = "Still looking"), or null when the search has taken
 * too long.
 */
export function vpsSearchAttempt(elapsedS: number): number | null {
  if (elapsedS >= VPS_SEARCH.giveUpS) {
    return null;
  }
  if (elapsedS >= VPS_SEARCH.stillLookingS) {
    return 4;
  }
  return elapsedS >= VPS_SEARCH.anotherViewS ? 2 : 1;
}

/** A door that is shown is moved only when the new place really differs (as in `relocalization.ts`). */
export const VPS_MOVE = { distanceM: 0.15, angleDeg: 6 } as const;

/** An alignment that differs by less than this from the one that is published is not published again. */
export const VPS_REPUBLISH = { distanceM: 0.01, angleDeg: 0.5 } as const;

export function differs(
  a: { position: readonly number[]; yawDeg: number },
  b: { position: readonly number[]; yawDeg: number },
  limit: { distanceM: number; angleDeg: number },
): boolean {
  const apart = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
  const turned = Math.abs(((((a.yawDeg - b.yawDeg + 180) % 360) + 360) % 360) - 180);
  return apart > limit.distanceM || turned > limit.angleDeg;
}
