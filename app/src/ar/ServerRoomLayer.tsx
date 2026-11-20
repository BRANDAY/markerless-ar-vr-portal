import { ViroBox, ViroNode, ViroPolygon, ViroPolyline } from '@reactvision/react-viro';

import { useRoomScan } from '../room/roomStore';
import type { PlanRect } from '../server/core/roomPlan';
import './materials';

const CORNER_CUBE_M = 0.16;
const CORNER_POST_M = 0.035;
const LINE_M = 0.02;

/**
 * The room as the SERVER reconstructed it: walls, room corners, the floor outline and the
 * door openings, drawn in the AR world frame of the current session.
 *
 * Orange = server plan (the cyan/green highlights of `RoomScanLayer` are what the phone
 * itself detects), white = door openings.
 */
export function ServerRoomLayer() {
  const plan = useRoomScan((s) => s.serverPlan);
  const visible = useRoomScan((s) => s.planVisible);
  const room = plan?.room;
  if (!visible || !room || room.status === 'unavailable') {
    return null;
  }
  return (
    <>
      {room.walls.map((wall) => (
        <Rectangle key={`wall-${wall.id}`} rect={wall} fill="planWall" line="planWallLine" lift={0} />
      ))}
      {room.openings.map((opening) => (
        // Lifted a little towards the room so that it is not hidden in its wall.
        <Rectangle key={`opening-${opening.id}`} rect={opening} fill="planOpening" line="planOpeningLine" lift={0.02} />
      ))}
      {room.corners.map((corner) => {
        const height = Math.max(0, corner.top[1] - corner.bottom[1]);
        return (
          <ViroNode key={`corner-${corner.id}`} position={corner.bottom}>
            <ViroBox
              position={[0, CORNER_CUBE_M / 2, 0]}
              width={CORNER_CUBE_M}
              height={CORNER_CUBE_M}
              length={CORNER_CUBE_M}
              materials={['planCorner']}
            />
            {height > CORNER_CUBE_M ? (
              <ViroBox
                position={[0, height / 2, 0]}
                width={CORNER_POST_M}
                height={height}
                length={CORNER_POST_M}
                materials={['planCorner']}
              />
            ) : null}
          </ViroNode>
        );
      })}
      {room.floorOutline ? (
        // A polyline is drawn in a node's X/Y: turned by -90 degrees about X, its (x, y)
        // lands on the world's (x, -y) in the horizontal plane at the outline's height.
        <ViroNode position={[0, room.floorOutline[0][1] + 0.01, 0]} rotation={[-90, 0, 0]}>
          <ViroPolyline
            points={[...room.floorOutline, room.floorOutline[0]].map((p) => [p[0], -p[2], 0] as [number, number, number])}
            thickness={LINE_M}
            materials={['planFloorLine']}
          />
        </ViroNode>
      ) : null}
    </>
  );
}

/** A wall or an opening. Its frame has +X to the right, +Y up and +Z into the room. */
function Rectangle(props: { rect: PlanRect; fill: string; line: string; lift: number }) {
  const { rect } = props;
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const outline: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return (
    <ViroNode position={rect.position} rotation={rect.rotation}>
      <ViroNode position={[0, 0, props.lift]}>
        <ViroPolygon vertices={outline} holes={[]} materials={[props.fill]} />
        <ViroPolyline
          points={[...outline, outline[0]].map(([x, y]) => [x, y, 0] as [number, number, number])}
          thickness={LINE_M}
          materials={[props.line]}
        />
      </ViroNode>
    </ViroNode>
  );
}
