import { ViroNode, ViroPolyline } from '@reactvision/react-viro';
import { useMemo } from 'react';

import type { Pose, Vec3 } from '../localization/types';
import { useRoomScan } from '../room/roomStore';
import { useAppState } from '../state/appStore';
import { gridLines, gridStrength, nearestWall } from '../ui/core/insideView';
import './materials';

const CELL_M = 0.25;
const LINE_M = 0.012;

/**
 * The wall warning (`docs/product/ui-spec.md`, 3.4): while the user is inside the space,
 * a real wall of the room is drawn as a grid when the phone comes within 0.6 m of it, at
 * full strength from 0.3 m. The walls are those of the room plan the server sent with the
 * door's position, in the AR world frame of the session.
 *
 * This layer sits INSIDE the portal's inner scene (the real room is not visible from in
 * there), whose coordinates are the door's: `door` is the pose that carries the inner
 * scene, and the node below undoes it, so that everything under it is in world
 * coordinates again. Only a door that stands upright (yaw only) is handled; the door of
 * this app always does.
 */
export function WallGridLayer({ door }: { door: Pose }) {
  const inside = useAppState((s) => s.mode === 'VR');
  const camera = useAppState((s) => s.cameraPosition);
  const walls = useRoomScan((s) => s.serverPlan?.room?.walls);
  const near = inside && camera && walls ? nearestWall(camera, walls) : null;
  const strength = near ? gridStrength(near.distance) : 0;
  const wall = strength > 0 ? near?.wall : undefined;

  // World -> door: turn back by the door's yaw, then shift back by its position.
  const yaw = door.rotation[1];
  const undoPosition = useMemo<Vec3>(() => [-door.position[0], -door.position[1], -door.position[2]], [door]);

  const lines = useMemo(() => {
    if (!wall) {
      return [];
    }
    const { xs, ys } = gridLines(wall.width, wall.height, CELL_M);
    const hw = wall.width / 2;
    const hh = wall.height / 2;
    return [
      ...xs.map((x) => [
        [x, -hh, 0],
        [x, hh, 0],
      ]),
      ...ys.map((y) => [
        [-hw, y, 0],
        [hw, y, 0],
      ]),
    ] as [Vec3, Vec3][];
  }, [wall]);

  if (!wall) {
    return null;
  }
  return (
    <ViroNode rotation={[0, -yaw, 0]}>
      <ViroNode position={undoPosition}>
        {/* Lifted a little towards the room, so that it is not lost in the space's own wall. */}
        <ViroNode position={wall.position as Vec3} rotation={wall.rotation as Vec3} opacity={strength}>
          <ViroNode position={[0, 0, 0.02]}>
            {lines.map((points, index) => (
              <ViroPolyline key={index} points={points} thickness={LINE_M} materials={['scanPaintLine']} />
            ))}
          </ViroNode>
        </ViroNode>
      </ViroNode>
    </ViroNode>
  );
}
