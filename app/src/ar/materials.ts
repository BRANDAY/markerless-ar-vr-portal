import { ViroAnimations, ViroMaterials } from '@reactvision/react-viro';

// Registered once, when the scene module is first imported.

const SCAN_FILL = {
  lightingModel: 'Constant',
  cullMode: 'None',
  blendMode: 'Alpha',
  writesToDepthBuffer: false,
} as const;
const SCAN_LINE = { lightingModel: 'Constant', cullMode: 'None' } as const;

ViroMaterials.createMaterials({
  // ---- AR-side objects (Task 1) ----
  arBox: { lightingModel: 'Lambert', diffuseColor: '#ff8a00' },
  arSphere: { lightingModel: 'Blinn', diffuseColor: '#2d9cff', shininess: 2 },

  // ---- Door frame ----
  // One texture for the whole model: three opaque shades + one fully transparent texel
  // column that the "window" quad samples (that is what makes the inner scene visible).
  // Constant lighting: the frame must look the same in the AR world and from inside.
  doorFrame: {
    lightingModel: 'Constant',
    diffuseTexture: require('../../assets/textures/door_frame.png'),
    minificationFilter: 'Nearest',
    magnificationFilter: 'Nearest',
    mipFilter: 'Nearest',
  },

  // ---- Virtual room ----
  // Walls, floor and ceiling use Constant lighting so the room is visible even if the
  // room lights misbehave on some device; the objects inside are lit by the room lights.
  roomWall: {
    lightingModel: 'Constant',
    diffuseTexture: require('../../assets/textures/room_wall.png'),
    cullMode: 'None',
  },
  roomFloor: {
    lightingModel: 'Constant',
    diffuseTexture: require('../../assets/textures/room_floor.png'),
    cullMode: 'None',
  },
  roomCeiling: {
    lightingModel: 'Constant',
    diffuseTexture: require('../../assets/textures/room_ceiling.png'),
    cullMode: 'None',
  },
  roomFrontWall: { lightingModel: 'Constant', diffuseColor: '#3a1c78', cullMode: 'None' },
  roomPedestal: { lightingModel: 'Lambert', diffuseColor: '#e8e8f0' },
  roomCube: { lightingModel: 'Lambert', diffuseColor: '#ffd23f' },
  roomSphere: { lightingModel: 'Blinn', diffuseColor: '#19e6a6', shininess: 4 },
  roomCrate: { lightingModel: 'Lambert', diffuseColor: '#ff4f7b' },

  // ---- Room scan highlights ----
  // Translucent fills that neither hide what is behind them nor each other; unlit, so
  // they look the same in any room light.
  scanWall: { ...SCAN_FILL, diffuseColor: 'rgba(34, 211, 238, 0.30)' },
  scanFloor: { ...SCAN_FILL, diffuseColor: 'rgba(46, 204, 113, 0.28)' },
  scanCeiling: { ...SCAN_FILL, diffuseColor: 'rgba(167, 139, 250, 0.25)' },
  scanSurface: { ...SCAN_FILL, diffuseColor: 'rgba(250, 204, 21, 0.25)' },
  scanWallLine: { ...SCAN_LINE, diffuseColor: '#22d3ee' },
  scanFloorLine: { ...SCAN_LINE, diffuseColor: '#2ecc71' },
  scanCeilingLine: { ...SCAN_LINE, diffuseColor: '#a78bfa' },
  scanSurfaceLine: { ...SCAN_LINE, diffuseColor: '#facc15' },
  scanCorner: { lightingModel: 'Constant', diffuseColor: '#ff3b6b' },
});

ViroAnimations.registerAnimations({
  roomSpin: { properties: { rotateY: '+=90' }, duration: 1500 },
});
