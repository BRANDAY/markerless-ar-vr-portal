import { ViroBox, ViroNode, ViroPolygon, ViroPolyline } from '@reactvision/react-viro';

import type { PlaneKind, WorldPlane } from '../room/roomGeometry';
import { useRoomScan } from '../room/roomStore';
import './materials';

const FILL: Record<PlaneKind, string> = {
  wall: 'scanWall',
  floor: 'scanFloor',
  ceiling: 'scanCeiling',
  surface: 'scanSurface',
};
const OUTLINE: Record<PlaneKind, string> = {
  wall: 'scanWallLine',
  floor: 'scanFloorLine',
  ceiling: 'scanCeilingLine',
  surface: 'scanSurfaceLine',
};

const CORNER_CUBE_M = 0.14;
const CORNER_POST_M = 0.03;
const OUTLINE_THICKNESS_M = 0.015;

/**
 * Schematic highlight of the scanned room: every detected plane as a translucent polygon
 * with an outline (walls, floor, ceiling and other surfaces in different colours), and a
 * cube with a post at every corner where two walls meet.
 *
 * The planes come from the AR session, which keeps them while the phone looks elsewhere,
 * so the highlight stays in place when the user turns around.
 */
export function RoomScanLayer() {
  const scanning = useRoomScan((s) => s.scanning);
  const room = useRoomScan((s) => s.room);
  if (!scanning) {
    return null;
  }
  return (
    <>
      {room.planes.map((plane) => (
        <PlaneHighlight key={plane.anchorId} plane={plane} />
      ))}
      {room.corners.map((corner) => (
        <ViroNode key={corner.wallIds.join('+')} position={corner.position}>
          <ViroBox
            position={[0, CORNER_CUBE_M / 2, 0]}
            width={CORNER_CUBE_M}
            height={CORNER_CUBE_M}
            length={CORNER_CUBE_M}
            materials={['scanCorner']}
          />
          {corner.height > CORNER_CUBE_M ? (
            <ViroBox
              position={[0, corner.height / 2, 0]}
              width={CORNER_POST_M}
              height={corner.height}
              length={CORNER_POST_M}
              materials={['scanCorner']}
            />
          ) : null}
        </ViroNode>
      ))}
    </>
  );
}

function PlaneHighlight({ plane }: { plane: WorldPlane }) {
  // The plane spans its local X/Z. ViroPolygon and ViroPolyline are drawn in a node's X/Y,
  // so they sit in a node turned by -90 degrees about X: its (x, y) lands on the plane's
  // (x, -y), hence the sign of z below.
  const outline = plane.localVertices.map((v) => [v[0], -v[2]] as [number, number]);
  const closed = [...outline, outline[0]].map(([x, y]) => [x, y, 0] as [number, number, number]);
  return (
    <ViroNode position={plane.position} rotation={plane.rotation}>
      <ViroNode rotation={[-90, 0, 0]}>
        <ViroPolygon vertices={outline} holes={[]} materials={[FILL[plane.kind]]} />
        <ViroPolyline points={closed} thickness={OUTLINE_THICKNESS_M} materials={[OUTLINE[plane.kind]]} />
      </ViroNode>
    </ViroNode>
  );
}
