import { ViroNode, ViroPolyline } from '@reactvision/react-viro';
import { useMemo } from 'react';

import type { Pose } from '../localization/types';
import './materials';

const THICKNESS_M = 0.02;
/** Just above the floor, so that the lines do not flicker in it. */
const LIFT_M = 0.01;

type P3 = [number, number, number];

/**
 * What lies on the floor under a door that is being placed (`ui-spec.md`, 5.14): an amber
 * outline around the threshold, and a short arrow from the room into the space, so that
 * the staff member sees which side visitors come from.
 *
 * Polylines are drawn in a node's X/Y, so they sit in a node turned by -90 degrees about
 * X: its (x, y) is the door's (x, -z). The room side of the door is +Z.
 */
export function PlaceMarker({ pose, width }: { pose: Pose; width: number }) {
  const { outline, shaft, head } = useMemo(() => {
    const half = width / 2 + 0.08;
    const depth = 0.22;
    const onFloor = (x: number, z: number): P3 => [x, -z, 0];
    return {
      outline: [onFloor(-half, depth), onFloor(half, depth), onFloor(half, -depth), onFloor(-half, -depth), onFloor(-half, depth)],
      shaft: [onFloor(0, 0.95), onFloor(0, 0.4)],
      head: [onFloor(-0.14, 0.58), onFloor(0, 0.4), onFloor(0.14, 0.58)],
    };
  }, [width]);
  return (
    <ViroNode position={pose.position} rotation={pose.rotation}>
      <ViroNode position={[0, LIFT_M, 0]} rotation={[-90, 0, 0]}>
        <ViroPolyline points={outline} thickness={THICKNESS_M} materials={['doorOutline']} />
        <ViroPolyline points={shaft} thickness={THICKNESS_M} materials={['doorOutline']} />
        <ViroPolyline points={head} thickness={THICKNESS_M} materials={['doorOutline']} />
      </ViroNode>
    </ViroNode>
  );
}
