// Local Expo config plugin: applied by `npx expo prebuild`, so the generated
// (git-ignored) `android/` folder never has to be edited by hand.
//
// 1. Writes build limits into android/gradle.properties that suit a 16 GB
//    development laptop shared with other heavy jobs:
//      - Gradle daemon heap capped (default option: 3 GB),
//      - at most N parallel Gradle workers (default: 4),
//      - native code built for the listed ABIs only (default: arm64-v8a, i.e. real
//        phones; add "x86_64" etc. in app.json if another ABI is ever needed).
//
// 2. Makes the DEBUG APK self-contained: the JS bundle is embedded, so the app
//    starts without a Metro dev server (an AR app is tested by walking around a
//    room, usually without a cable). A debug build still prefers Metro when one
//    is reachable, so the normal edit-reload workflow keeps working.
//    Opt out per build with:  gradlew assembleDebug -Pportal.bundleInDebug=false
const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

const BUNDLE_MARKER = '// @generated withAndroidBuildTuning: bundle JS in debug';

function setProperty(properties, key, value) {
  const existing = properties.find((item) => item.type === 'property' && item.key === key);
  if (existing) {
    existing.value = value;
  } else {
    properties.push({ type: 'property', key, value });
  }
}

function withGradleLimits(config, { jvmHeapMb, maxWorkers, architectures }) {
  return withGradleProperties(config, (cfg) => {
    const properties = cfg.modResults;
    setProperty(
      properties,
      'org.gradle.jvmargs',
      `-Xmx${jvmHeapMb}m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8`,
    );
    setProperty(properties, 'org.gradle.workers.max', String(maxWorkers));
    setProperty(properties, 'reactNativeArchitectures', architectures.join(','));
    return cfg;
  });
}

function withBundledDebug(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAndroidBuildTuning: android/app/build.gradle is not Groovy');
    }
    let contents = cfg.modResults.contents;
    if (contents.includes(BUNDLE_MARKER)) {
      return cfg;
    }
    const anchor = /^react \{\s*$/m;
    if (!anchor.test(contents)) {
      throw new Error('withAndroidBuildTuning: "react {" block not found in app/build.gradle');
    }
    // No variant listed as "debuggable" => the React Native Gradle plugin bundles the
    // JS (and compiles it with Hermes) for the debug variant as well.
    contents = contents.replace(
      anchor,
      [
        'react {',
        `    ${BUNDLE_MARKER}`,
        "    debuggableVariants = (findProperty('portal.bundleInDebug') ?: 'true').toBoolean() ? [] : ['debug']",
      ].join('\n'),
    );
    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = function withAndroidBuildTuning(config, options = {}) {
  const limits = {
    jvmHeapMb: options.jvmHeapMb ?? 3072,
    maxWorkers: options.maxWorkers ?? 4,
    architectures: options.architectures ?? ['arm64-v8a'],
  };
  config = withGradleLimits(config, limits);
  if (options.bundleInDebug ?? true) {
    config = withBundledDebug(config);
  }
  return config;
};
