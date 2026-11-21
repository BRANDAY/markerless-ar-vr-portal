import { ViroNode, ViroPolyline } from '@reactvision/react-viro';
import { useMemo } from 'react';

import type { Pose } from '../localization/types';
import { DOOR, doorwayDashes } from './doorGeometry';
import './materials';

const THICKNESS_M = 0.012;

/**
 * An amber dashed outline of the doorway, drawn in place of the door while the first
 * door position of a session is still being checked (`ui-spec.md`, 3.4): the user sees
 * where the door is about to stand, but cannot yet walk into a space that may still move.
 */
export function DoorOutline({ pose, opening }: { pose: Pose; opening?: { width: number; height: number } }) {
  const width = opening?.width ?? DOOR.openingWidth;
  const height = opening?.height ?? DOOR.openingHeight;
  const dashes = useMemo(() => doorwayDashes(width, height), [width, height]);
  return (
    <ViroNode position={pose.position} rotation={pose.rotation}>
      {dashes.map((points, index) => (
        <ViroPolyline key={index} points={points} thickness={THICKNESS_M} materials={['doorOutline']} />
      ))}
    </ViroNode>
  );
}
