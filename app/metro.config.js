// Metro configuration: the Expo defaults plus 3D-model file types, so that
// `require('./assets/models/door_frame.obj')` is bundled as an asset.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

for (const ext of ['obj', 'mtl', 'vrx', 'glb', 'gltf', 'hdr']) {
  if (!config.resolver.assetExts.includes(ext)) {
    config.resolver.assetExts.push(ext);
  }
}

module.exports = config;
