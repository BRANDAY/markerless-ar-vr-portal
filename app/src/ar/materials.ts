import { ViroAnimations, ViroMaterials } from '@reactvision/react-viro';

// Registered once, when the scene module is first imported.

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
});

ViroAnimations.registerAnimations({
  roomSpin: { properties: { rotateY: '+=90' }, duration: 1500 },
});
