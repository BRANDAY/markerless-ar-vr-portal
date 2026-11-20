// Unit tests of the room model. Run with `npm test` (Node's built-in test runner).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildRoom,
  localPolygon,
  polygonAreaXZ,
  toPlaneAnchorData,
  type PlaneAnchorData,
} from './roomGeometry';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

/** A horizontal plane: local frame = world frame. */
function floor(id: string, y: number, half = 2): PlaneAnchorData {
  return {
    anchorId: id,
    position: [0, y, 0],
    rotation: [0, 0, 0],
    alignment: 'HorizontalUpward',
    vertices: [
      [-half, 0, -half],
      [half, 0, -half],
      [half, 0, half],
      [-half, 0, half],
    ],
  };
}

/**
 * A wall 3 m wide and 2.4 m high standing on y = 0, centred at `position` in XZ.
 * Rotation [90, yaw, 0]: Rx(90) turns the plane's +Y normal to +Z and its local Z to -Y,
 * then Ry(yaw) turns the wall about the vertical. So yaw 0 faces +Z, yaw 90 faces +X.
 */
function wall(id: string, x: number, z: number, yawDeg: number, halfWidth = 1.5): PlaneAnchorData {
  return {
    anchorId: id,
    position: [x, 1.2, z],
    rotation: [90, yawDeg, 0],
    alignment: 'Vertical',
    vertices: [
      [-halfWidth, 0, -1.2],
      [halfWidth, 0, -1.2],
      [halfWidth, 0, 1.2],
      [-halfWidth, 0, 1.2],
    ],
  };
}

describe('toPlaneAnchorData', () => {
  test('keeps planes, drops everything else', () => {
    assert.equal(toPlaneAnchorData(null), null);
    assert.equal(toPlaneAnchorData({ type: 'image', anchorId: 'a', position: [0, 0, 0] }), null);
    assert.equal(toPlaneAnchorData({ type: 'plane', anchorId: 'a' }), null);
    assert.equal(toPlaneAnchorData({ type: 'plane', anchorId: 'a', position: [0, NaN, 0] }), null);
    const plane = toPlaneAnchorData({
      type: 'plane',
      anchorId: 'a',
      position: [1, 2, 3],
      rotation: [0, 90, 0],
      width: 2,
      height: 1,
      alignment: 'Vertical',
      vertices: [[0, 0, 0], [1, 0, 0], 'junk', [1, 0, 1]],
    });
    assert.deepEqual(plane?.position, [1, 2, 3]);
    assert.equal(plane?.vertices?.length, 3);
    // Fewer than three usable vertices: fall back to the extent rectangle later.
    assert.equal(toPlaneAnchorData({ type: 'plane', anchorId: 'a', position: [0, 0, 0], vertices: [[0, 0, 0]] })?.vertices, undefined);
  });
});

describe('plane polygons', () => {
  test('extent rectangle when there are no vertices', () => {
    const polygon = localPolygon({ anchorId: 'a', position: [0, 0, 0], rotation: [0, 0, 0], center: [1, 0, 2], width: 4, height: 2 });
    assert.deepEqual(polygon, [
      [-1, 0, 1],
      [3, 0, 1],
      [3, 0, 3],
      [-1, 0, 3],
    ]);
    near(polygonAreaXZ(polygon), 8);
  });
  test('area does not depend on the winding', () => {
    const polygon = localPolygon(floor('f', 0, 1.5));
    near(polygonAreaXZ(polygon), 9);
    near(polygonAreaXZ([...polygon].reverse()), 9);
  });
});

describe('buildRoom', () => {
  test('empty', () => {
    const room = buildRoom([]);
    assert.equal(room.floorY, null);
    assert.equal(room.planes.length, 0);
    assert.equal(room.corners.length, 0);
  });

  test('floor, table and ceiling are told apart', () => {
    const room = buildRoom([
      floor('floor', -1.4),
      { ...floor('table', -0.65, 0.5) },
      { ...floor('ceiling', 1.1), alignment: 'HorizontalDownward' },
    ]);
    near(room.floorY ?? NaN, -1.4);
    assert.deepEqual(room.planes.map((p) => [p.anchorId, p.kind]), [
      ['floor', 'floor'],
      ['table', 'surface'],
      ['ceiling', 'ceiling'],
    ]);
    near(room.floorArea, 16);
  });

  test('a small low patch does not become the floor while a big plane exists', () => {
    const room = buildRoom([floor('floor', -1.4), floor('patch', -1.9, 0.2)]);
    near(room.floorY ?? NaN, -1.4);
  });

  test('a wall is transformed into the world frame', () => {
    const room = buildRoom([wall('w', 0, -2, 0)]);
    const plane = room.planes[0];
    assert.equal(plane.kind, 'wall');
    near(plane.normal[0], 0);
    near(plane.normal[1], 0);
    near(plane.normal[2], 1);
    near(plane.minY, 0);
    near(plane.maxY, 2.4);
    near(plane.area, 3 * 2.4);
    for (const v of plane.vertices) {
      near(v[2], -2);
      assert.ok(Math.abs(v[0]) <= 1.5 + 1e-6);
    }
  });

  test('two walls meeting at a right angle give one corner on the floor', () => {
    // Back wall along X at z = -2 (x from -1.5 to 1.5), side wall along Z at x = 1.6.
    const room = buildRoom([floor('floor', 0), wall('back', 0, -2, 0), wall('side', 1.6, -0.4, -90)]);
    assert.equal(room.wallCount, 2);
    assert.equal(room.corners.length, 1);
    const corner = room.corners[0];
    near(corner.position[0], 1.6);
    near(corner.position[1], 0);
    near(corner.position[2], -2);
    near(corner.height, 2.4);
    assert.deepEqual([...corner.wallIds].sort(), ['back', 'side']);
  });

  test('parallel walls and walls that do not reach each other give no corner', () => {
    assert.equal(buildRoom([wall('a', 0, -2, 0), wall('b', 0, 2, 180)]).corners.length, 0);
    // Perpendicular, but the side wall is 5 m beyond the end of the back wall.
    assert.equal(buildRoom([wall('back', 0, -2, 0), wall('far', 6.5, -0.4, -90)]).corners.length, 0);
  });

  test('without a floor the corner sits at the lowest point of the walls', () => {
    const room = buildRoom([wall('back', 0, -2, 0), wall('side', 1.6, -0.4, -90)]);
    assert.equal(room.floorY, null);
    near(room.corners[0].position[1], 0);
  });

  test('duplicate walls do not duplicate the corner', () => {
    const room = buildRoom([
      wall('back', 0, -2, 0),
      wall('back2', 0.2, -2.05, 0),
      wall('side', 1.6, -0.4, -90),
    ]);
    assert.equal(room.corners.length, 1);
  });

  test('orientation falls back to the normal when the alignment is missing', () => {
    const anchor = { ...wall('w', 0, -2, 0), alignment: undefined };
    assert.equal(buildRoom([anchor]).planes[0].kind, 'wall');
    assert.equal(buildRoom([{ ...floor('f', 0), alignment: undefined }]).planes[0].kind, 'floor');
  });
});
