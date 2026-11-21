/**
 * The wood of the door casing, WITHOUT a window: posts, corners, head and threshold, laid
 * out exactly as `environments/DoorCasing.tsx` lays them out (same models, same material).
 *
 * Why this exists next to `DoorCasing`: on the first full pass on a phone (2026-11-21) the
 * doorway with `DoorCasing` inside `<ViroPortal>` showed no world - only the wood. What
 * differed from the one arrangement that HAS been seen working (build 9cb8a8b) was the
 * window: there a flat face of one model with a texture of opaque and transparent texels,
 * here a separate box with a fully transparent texture among six other objects. The cause
 * could not be found without a phone, so the proven arrangement is restored instead: the
 * portal gets one flat window as its only child (`DoorPortal.tsx`), and the wood is drawn
 * here, as ordinary objects of the AR scene around it.
 *
 * Seen from inside the space the wood belongs to the real side: only what shows through
 * the opening is drawn.
 *
 * Local frame: origin in the CENTRE of the opening, +Y up, +Z towards the real side; the
 * floor is at y = -height / 2.
 */
import { Viro3DObject } from '@reactvision/react-viro';

// Importing the module registers its materials (`envDoorCasing`).
import '../environments/DoorCasing';

/** As in `DoorCasing.tsx`: the window reaches this far under the wood on each side. */
export const CASING_WINDOW_MARGIN = 0.008;

const MODELS = {
  postLeft: require('../../assets/environments/door_casing/casing_post_left.obj'),
  postRight: require('../../assets/environments/door_casing/casing_post_right.obj'),
  cornerLeft: require('../../assets/environments/door_casing/casing_corner_left.obj'),
  cornerRight: require('../../assets/environments/door_casing/casing_corner_right.obj'),
  head: require('../../assets/environments/door_casing/casing_head.obj'),
  threshold: require('../../assets/environments/door_casing/casing_threshold.obj'),
};

const WOOD = ['envDoorCasing'];

export function CasingWood({ width, height, onError }: { width: number; height: number; onError?: (message: string) => void }) {
  const hw = width / 2;
  const hh = height / 2;
  const fail = (event: { nativeEvent?: unknown } | undefined) => onError?.(JSON.stringify(event?.nativeEvent ?? {}));
  return (
    <>
      <Viro3DObject source={MODELS.postLeft} type="OBJ" materials={WOOD} position={[-hw, -hh, 0]} scale={[1, height, 1]} onError={fail} />
      <Viro3DObject source={MODELS.postRight} type="OBJ" materials={WOOD} position={[hw, -hh, 0]} scale={[1, height, 1]} onError={fail} />
      <Viro3DObject source={MODELS.cornerLeft} type="OBJ" materials={WOOD} position={[-hw, hh, 0]} onError={fail} />
      <Viro3DObject source={MODELS.cornerRight} type="OBJ" materials={WOOD} position={[hw, hh, 0]} onError={fail} />
      <Viro3DObject source={MODELS.head} type="OBJ" materials={WOOD} position={[0, hh, 0]} scale={[width, 1, 1]} onError={fail} />
      <Viro3DObject source={MODELS.threshold} type="OBJ" materials={WOOD} position={[0, -hh, 0]} scale={[width, 1, 1]} onError={fail} />
    </>
  );
}
