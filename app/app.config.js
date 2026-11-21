/**
 * Expo configuration. `app.json` stays the base and is what a machine without any keys
 * builds from, unchanged.
 *
 * The one thing added here: the keys of ReactVision Advanced VPS, the second way to find
 * a room (`docs/cloud/cloud-connection.md`, section 4). The repository is public, so they
 * are read from a file OUTSIDE it when the native project is generated:
 *
 *   <secrets folder>/reactvision-app.json      { "rvProjectId": "...", "rvApiKey": "rv_client_..." }
 *
 * The secrets folder is `E:\VR-FESB\secrets`, or whatever the environment variable
 * `VRFESB_SECRETS_DIR` names.
 *
 *  - file there: the ViroReact plugin gets `provider: "reactvision"`, `rvApiKey` and
 *    `rvProjectId`; `expo prebuild` writes the two values into the generated
 *    `android/` project (git-ignored) and so into the APK. That is what a CLIENT key is
 *    for, but such an APK should not be attached to a public release;
 *  - no file: nothing changes (`provider: "none"`), and in the app the ReactVision way
 *    says that it is not set up in this build.
 *
 * Only the client key may be here. The secret key (`rv_secret_...`) belongs to the
 * server; a file that holds one stops the build instead of putting it into an APK.
 * Nothing read from the file is printed.
 */
const fs = require('fs');
const path = require('path');

const VIRO_PLUGIN = '@reactvision/react-viro';
const KEY_FILE = 'reactvision-app.json';
const DEFAULT_SECRETS_DIR = 'E:\\VR-FESB\\secrets';

/** The two values, or null when there is no usable file. */
function readReactVisionKeys() {
  const dir = process.env.VRFESB_SECRETS_DIR || DEFAULT_SECRETS_DIR;
  const file = path.join(dir, KEY_FILE);
  if (!fs.existsSync(file)) {
    return null;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    console.warn(`[app.config] ${file} is not valid JSON - building without ReactVision`);
    return null;
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const rvProjectId = text(json && json.rvProjectId);
  const rvApiKey = text(json && json.rvApiKey);
  if (rvApiKey.startsWith('rv_secret_') || rvProjectId.startsWith('rv_secret_')) {
    throw new Error(
      `[app.config] ${file} holds a SECRET key. The app takes the client key (rv_client_...) only; ` +
        'the secret key belongs to the server and must never be built into an APK.',
    );
  }
  if (!rvProjectId || !rvApiKey) {
    console.warn(`[app.config] ${file} has no "rvProjectId" / "rvApiKey" - building without ReactVision`);
    return null;
  }
  if (!rvApiKey.startsWith('rv_client_')) {
    console.warn(`[app.config] "rvApiKey" in ${file} does not look like a client key (rv_client_...); it is used as it is`);
  }
  return { rvProjectId, rvApiKey };
}

module.exports = ({ config }) => {
  const keys = readReactVisionKeys();
  if (!keys) {
    return config;
  }
  const plugins = (config.plugins || []).map((entry) => {
    if (Array.isArray(entry) && entry[0] === VIRO_PLUGIN) {
      return [entry[0], { ...(entry[1] || {}), provider: 'reactvision', rvApiKey: keys.rvApiKey, rvProjectId: keys.rvProjectId }];
    }
    return entry;
  });
  return { ...config, plugins };
};
