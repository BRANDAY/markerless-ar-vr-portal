/**
 * Where the local AR anchor comes from that is uploaded as a cloud anchor.
 *
 * `hostCloudAnchor(anchorId, ttlDays)` uploads an anchor that already exists in the AR
 * session; ViroReact 3.2.2 has no call that creates one at an arbitrary pose. The two
 * ways to an anchor id are:
 *  - `ViroARScene.createAnchoredNode(hitResult)` after a hit test
 *    (`components/AR/ViroARScene.tsx:368-449`) - a real anchor on a real surface;
 *  - the `anchorId` of a plane ARCore detected (`onAnchorFound`).
 * Both are behind `LocalAnchorSource`, which the AR scene provides. No ViroReact import:
 * the scene is taken as `unknown` and its methods are found by name.
 */
import { distanceM, type RigidPose, type Vec3 } from './anchorMath';

export interface LocalAnchor {
  /** Id the AR session knows the anchor by. */
  anchorId: string;
  /** Pose of the anchor in the current session, when the source knows it. */
  pose: RigidPose | null;
  /** For the log: how the anchor was obtained. */
  origin: string;
}

export interface LocalAnchorSource {
  /**
   * An anchor on a real surface as close as possible to `point` (AR world, metres), or
   * null when there is none. Must not throw.
   */
  anchorNear(point: Vec3): Promise<LocalAnchor | null>;
}

type AnyFunction = (...args: unknown[]) => unknown;

function method(target: unknown, name: string): AnyFunction | null {
  if (typeof target !== 'object' || target === null) {
    return null;
  }
  const value = (target as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as AnyFunction).bind(target) : null;
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }
  const v = value.slice(0, 3);
  return v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;
}

function asPose(transform: unknown): RigidPose | null {
  if (typeof transform !== 'object' || transform === null) {
    return null;
  }
  const t = transform as Record<string, unknown>;
  const position = asVec3(t.position);
  if (!position) {
    return null;
  }
  return { position, rotation: asVec3(t.rotation) ?? [0, 0, 0] };
}

/** A hit farther than this from the wanted point is another surface, not the floor there. */
export const MAX_HIT_OFFSET_M = 0.6;

/** The hit-test result closest to `point`, or null when none is close enough. */
export function nearestHit(results: unknown, point: Vec3, maxOffsetM = MAX_HIT_OFFSET_M): { hit: unknown; pose: RigidPose } | null {
  if (!Array.isArray(results)) {
    return null;
  }
  let best: { hit: unknown; pose: RigidPose; offset: number } | null = null;
  for (const hit of results) {
    if (typeof hit !== 'object' || hit === null) {
      continue;
    }
    const h = hit as Record<string, unknown>;
    const pose = asPose(h.transform);
    if (!pose || typeof h._hitResultId !== 'string' || !h._hitResultId) {
      continue; // without the id no anchor can be made from the hit
    }
    const offset = distanceM(pose.position, point);
    if (offset <= maxOffsetM && (!best || offset < best.offset)) {
      best = { hit, pose, offset };
    }
  }
  return best ? { hit: best.hit, pose: best.pose } : null;
}

/**
 * Anchors made by a hit test straight down through the wanted point: the ray starts
 * above it and ends below it, so it meets the floor there whatever the camera looks at.
 * `getScene` returns the mounted `ViroARScene` (its ref), or null.
 */
export function hitTestAnchorSource(getScene: () => unknown, log: (message: string) => void = () => {}): LocalAnchorSource {
  return {
    async anchorNear(point) {
      const scene = getScene();
      const hitTest = method(scene, 'performARHitTestWithWorldPoints');
      const createAnchor = method(scene, 'createAnchoredNode');
      if (!hitTest || !createAnchor) {
        log('cloud: the AR scene has no hit test / createAnchoredNode');
        return null;
      }
      try {
        const above: Vec3 = [point[0], point[1] + 1.0, point[2]];
        const below: Vec3 = [point[0], point[1] - 0.5, point[2]];
        const found = nearestHit(await hitTest(above, below), point);
        if (!found) {
          log('cloud: no surface found under the doorway - let the phone see the floor there');
          return null;
        }
        const node = (await createAnchor(found.hit)) as Record<string, unknown> | null;
        const anchorId = node && typeof node.anchorId === 'string' ? node.anchorId : '';
        if (!anchorId) {
          log('cloud: the AR session did not create an anchor at the hit');
          return null;
        }
        return { anchorId, pose: asPose(node?.transform) ?? found.pose, origin: 'hit test under the doorway' };
      } catch (error) {
        log(`cloud: making a local anchor failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
  };
}

/** A plane the AR session reports (`onAnchorFound` / `onAnchorUpdated`). */
export interface KnownPlane {
  anchorId: string;
  position: Vec3;
  rotation?: Vec3;
  /** 'Horizontal', 'HorizontalUpward', 'Vertical'... as ViroReact names it. */
  alignment?: string;
}

/** A detected plane farther than this from the doorway is not used as its anchor. */
export const MAX_PLANE_DISTANCE_M = 3;

/**
 * Fallback: the detected plane whose centre is closest to the point. Its pose is NOT
 * passed on (the centre of a plane moves while the plane grows), so the save flow
 * measures the anchor pose by resolving the hosted anchor once.
 */
export function planeAnchorSource(listPlanes: () => readonly KnownPlane[]): LocalAnchorSource {
  return {
    async anchorNear(point) {
      let best: { plane: KnownPlane; d: number } | null = null;
      for (const plane of listPlanes()) {
        if (!plane.anchorId || !plane.position.every(Number.isFinite)) {
          continue;
        }
        const d = distanceM(plane.position, point);
        if (d <= MAX_PLANE_DISTANCE_M && (!best || d < best.d)) {
          best = { plane, d };
        }
      }
      return best ? { anchorId: best.plane.anchorId, pose: null, origin: `detected plane ${best.d.toFixed(1)} m away` } : null;
    },
  };
}

/** Tries the sources in order and returns the first anchor. */
export function firstAnchorSource(sources: readonly LocalAnchorSource[]): LocalAnchorSource {
  return {
    async anchorNear(point) {
      for (const source of sources) {
        const anchor = await source.anchorNear(point);
        if (anchor) {
          return anchor;
        }
      }
      return null;
    },
  };
}
