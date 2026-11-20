# FESB AR Portal — markerless AR-to-VR portal (proof of concept)

A mobile app that shows a virtual doorway in augmented reality. Through the doorway the
user sees a simple virtual room, can physically walk through it into VR and walk back
out into AR. The final goal of the assignment is that the doorway appears at the same
real-world place in every app session, found without markers, QR codes, GPS or manual
placement.

**This repository is at stage 1**: a buildable Android app with the AR scene, the
walk-through portal and a pluggable localization layer. Real localization is not
implemented yet — the doorway is placed 2 m in front of the camera by a stand-in
provider (see [Status](#status-against-the-assignment)).

> **Nothing in this repository has been run on a phone yet.** The APK builds; tracking,
> portal rendering, the enter/exit events and the behaviour while crossing the doorway
> are unverified. See [Not verified yet](#not-verified-yet).

## Status against the assignment

| Task | State |
| --- | --- |
| 1. Camera feed and basic 3D objects in AR | Implemented (`src/ar/PortalARScene.tsx`), not device-tested |
| 2. Recognise a previously scanned room without markers | **Not implemented.** Interface + three stubs only (`src/localization/`) |
| 3. Doorway at the same real-world pose in every session | **Not implemented.** Depends on task 2; the doorway pose already flows through one place |
| 4. See a virtual room through the doorway, walk in and back out | Implemented (`src/ar/DoorPortal.tsx`, `src/ar/VirtualRoom.tsx`), not device-tested |
| 5. Tests: restart, angles, lighting, tracking loss | Not started (needs tasks 2–3 and a device) |

## Stack

| Component | Version | Note |
| --- | --- | --- |
| Expo SDK | 58 (`expo` 58.0.26) | prebuild / "bare" workflow, no Expo Go, no EAS |
| React Native | 0.88.1 | New Architecture (the only mode in this version) |
| React | 19.3.0 | |
| ViroReact | `@reactvision/react-viro` 3.2.2 | AR renderer on top of ARCore |
| TypeScript | 6.0.x | |
| Android | compileSdk 37, targetSdk 36, minSdk 24 | build-tools 37.0.0, NDK 27.1.12297006 |
| Gradle / AGP | 9.4.1 / 9.2.1 | downloaded by the wrapper |
| JDK | 21 | |

All npm dependencies are pinned to exact versions in `package.json` and locked in
`package-lock.json`. ViroReact 3.2.x requires exactly React Native 0.88 / Expo SDK 58;
the 3.1.x line (React Native 0.86 / Expo SDK 57) was the fallback and was not needed.

Android only: the development machine is Windows, and ViroReact does not run in the
Android emulator — **a real ARCore-capable phone is required**.

## Setup on Windows

### 1. Tools

- Node.js 24 (npm 11), Git.
- JDK 21, with `JAVA_HOME` pointing at it.
- Android SDK with `ANDROID_HOME` set and `platform-tools` on `PATH` (Android Studio is
  not needed, the command-line tools are enough). Required packages:

  ```powershell
  sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006"
  ```

  (about 4 GB; `sdkmanager` asks to accept the SDK licences on a fresh installation).

### 2. Keep the path short

Clone into a short path such as `C:\dev\app`. React Native's native build creates deep
directory trees and fails with "filename too long" errors under long paths. If the
project must live in a long path, enable Win32 long paths once (administrator
PowerShell, then reboot) — this is a system setting and is **not** done by any script
here:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

### 3. Optional: caches on another drive

The Gradle user home grows to several GB. To keep it (and the npm cache) off the system
drive for the current PowerShell session, edit the two paths in `scripts/env.ps1` and
dot-source it before the commands below:

```powershell
. .\scripts\env.ps1
```

It only sets `GRADLE_USER_HOME` and `npm_config_cache` for that shell; nothing permanent.

### 4. Install, generate the native project, build

```powershell
npm ci
```

```powershell
npx expo prebuild --platform android --no-install
```

```powershell
cd android; .\gradlew.bat assembleDebug --console=plain; cd ..
```

The APK is written to `android\app\build\outputs\apk\debug\app-debug.apk`.

- `android/` is **generated** by `expo prebuild` from `app.json` and the config plugins
  and is git-ignored. Do not edit it; change `app.json` or `plugins/` and run prebuild
  again (`npm run prebuild:clean` regenerates it from scratch).
- Measured on the development laptop (i7-8750H, 16 GB RAM, another CPU-heavy job running
  at the same time): the first build took **23 min** (downloads the Gradle distribution
  and all dependencies, compiles the native modules); a rebuild after a JavaScript change
  took **1 min 41 s**. The debug APK is **68 MB** (`arm64-v8a` only, unstripped debug
  libraries, Hermes bytecode bundle 1.9 MB).
- Disk used on that machine: Gradle user home 3.8 GB, npm cache 0.5 GB, the three SDK
  packages plus `node_modules` about 4 GB, build output inside the project (`android/`
  and `node_modules/*/android/build`) about 1.8 GB. Have roughly 10 GB free before the
  first build.
- The debug APK is **self-contained**: the JavaScript bundle is embedded, so the app
  starts without a development server (see `plugins/withAndroidBuildTuning.js`).
- Build limits written by that plugin into `android/gradle.properties`: Gradle heap
  3 GB, 4 workers, native code for `arm64-v8a` only. Change them in `app.json`.
- Gradle keeps a daemon alive after the build (up to 3 GB RAM); stop it with
  `cd android; .\gradlew.bat --stop`.

### 5. Phone

1. An Android phone from Google's [ARCore supported devices](https://developers.google.com/ar/devices)
   list with **Google Play Services for AR** installed/updated from the Play Store.
2. Enable developer mode (Settings → About phone → tap *Build number* 7 times), then
   Settings → Developer options → **USB debugging**. On Xiaomi/Redmi/POCO also enable
   *Install via USB*.
3. Connect by USB, accept the "Allow USB debugging" prompt, check that `adb devices`
   lists the phone as `device`.
4. Install and start:

   ```powershell
   adb install -r android\app\build\outputs\apk\debug\app-debug.apk
   ```

   ```powershell
   adb shell monkey -p hr.fesb.arportal -c android.intent.category.LAUNCHER 1
   ```

5. Grant the camera permission when the app asks.
6. Logs of the app (the on-screen event log is mirrored to logcat with the `[portal]`
   prefix):

   ```powershell
   adb logcat -s ReactNativeJS:V AndroidRuntime:E
   ```

   or everything the app process prints (native renderer included):

   ```powershell
   adb logcat --pid=$(adb shell pidof hr.fesb.arportal)
   ```

### Development loop (optional)

With the phone on USB, start Metro and forward its port; the debug build loads the
bundle from Metro when it is reachable and falls back to the embedded one otherwise
(this fallback is standard React Native behaviour, not yet confirmed on a device here):

```powershell
adb reverse tcp:8081 tcp:8081
```

```powershell
npx expo start
```

Other scripts: `npm run typecheck` (TypeScript), `npm run assets` (regenerate textures
and the door model).

## Using the app

- Top left: mode badge — green **AR** or purple **VR**. It is driven only by the
  portal's `onPortalEnter` / `onPortalExit` events.
- *Debug / Hide debug*: toggles the debug overlay (status panel, event log, buttons).
- Status panel: tracking state and reason, camera position and forward vector in
  AR-world coordinates, detected floor height, provider status, door pose, attach mode.
- Event log: tracking changes, provider status, door poses, portal enter/exit.
- *Re-place door*: asks the provider for a new pose; the manual provider puts the
  doorway 2 m in front of the camera again.
- *Attach: direct / parent*: how the portal is attached to the scene graph (below).
- *Provider: …*: cycles through the providers; all except `manual` are stubs.

Expected behaviour: move the phone slowly until tracking becomes NORMAL. A box, a
sphere and a text label appear about 1.2 m in front of the starting position; the door
frame appears 2 m ahead, standing on the floor and facing you, showing a violet room
with a checkerboard floor. Walk through the frame: the badge switches to VR and the
room surrounds you. Turn around: the doorway shows the camera image, with "EXIT TO AR"
above it. Walk back through it to return to AR.

## Project structure

```
App.tsx                       camera permission gate, AR navigator + overlay
index.ts                      entry point
app.json                      Expo config: ViroReact plugin options, build limits
metro.config.js               adds .obj (and other 3D formats) to Metro's asset types
plugins/
  withAndroidBuildTuning.js   config plugin: Gradle limits, JS bundle embedded in debug
scripts/
  env.ps1                     optional: caches on another drive for the current shell
  generate-assets.mjs         generates all textures and the door-frame OBJ
assets/
  models/door_frame.obj       generated door frame (frame + transparent "window")
  textures/*.png              generated textures
src/
  ar/
    PortalARScene.tsx         ViroARScene: task-1 objects, tracking/camera/plane feeds, provider life cycle
    DoorPortal.tsx            ViroPortalScene + ViroPortal + door model; the two attach modes
    VirtualRoom.tsx           the virtual room (primitives, own lights)
    doorGeometry.ts           door / room dimensions, light bit masks
    materials.ts              ViroMaterials and animations
  localization/
    types.ts                  LocalizationProvider interface, pose types, conventions
    BaseProvider.ts           listener bookkeeping shared by providers
    ManualPlacementProvider.ts  stage-1 stand-in
    stubs.ts                  ReactVision VPS / ARCore Cloud Anchor / self-hosted server (not implemented)
    math.ts                   small vector / Euler helpers
    index.ts                  provider registry
  state/appStore.ts           store shared by the AR scene and the overlay; holds THE door pose
  ui/Overlay.tsx              mode badge, status panel, event log, buttons
```

## Localization provider interface

Everything that decides *where the doorway stands* is behind one interface
(`src/localization/types.ts`):

```ts
interface LocalizationProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  start(context: LocalizationContext): void;
  stop(): void;
  getStatus(): LocalizationStatus;   // idle | waiting-for-tracking | localizing | localized | lost | error
  getStatusDetail(): string;
  onStatus(listener): Unsubscribe;
  onPose(listener: (update: PoseUpdate) => void): Unsubscribe;
  relocalize(): void;
}

interface PoseUpdate {
  pose: { position: Vec3; rotation: Vec3 };   // doorway pose in AR-world coordinates
  quality?: { confidence?; positionErrorM?; headingErrorDeg?; note? };
  source: ProviderId;
  timestampMs: number;
}
```

- **Pose convention** (same as ViroReact node props): metres, right-handed, +Y up, the
  AR-world frame of the *current* ARCore session; `rotation` is Euler degrees `[x, y, z]`
  applied as `R = Rz·Ry·Rx`. The doorway's own frame: origin on the floor in the middle
  of the threshold, opening in the local XY plane, local +Z towards the AR side, the
  virtual room towards −Z.
- **`LocalizationContext`** is what a provider may ask from the running AR session:
  latest camera pose, tracking state (+ change listener), detected floor height, the
  ViroReact `arSceneNavigator` handle (cloud-anchor / VPS calls) and a log function.
  Providers never import ViroReact components.
- **One place for the door pose**: `PortalARScene` subscribes to the active provider and
  writes every `PoseUpdate` to `appStore.door`; `DoorPortal` renders from that value.
  A provider update therefore moves the whole portal (frame, room, lights).

Providers:

| Provider | State |
| --- | --- |
| `ManualPlacementProvider` | Implemented. When tracking first becomes NORMAL: 2 m ahead of the camera along its horizontal heading, on the floor (lowest detected horizontal plane at least 0.8 m below the camera, otherwise 1.4 m below the camera), facing the user. **Not persistent across sessions — a stand-in only.** |
| `ReactVisionVpsProvider` | Stub, no network code. Needs a ReactVision API key + project id and plugin option `provider: "reactvision"`. |
| `ArCoreCloudAnchorProvider` | Stub, no network code. Needs a Google Cloud API key and plugin option `provider: "arcore"`. |
| `SelfHostedServerProvider` | Stub, no network code. Will talk to the separate `localization-server` project over HTTP on the local Wi-Fi. |

The ViroReact plugin is currently configured with `provider: "none"` and
`telemetry: false` (no anchor back-end, no usage ping); no API keys or accounts are used.

## How the portal works

Scene graph:

```
ViroARScene
  [ViroNode  ← door pose]                 only in attach mode "parent"
    ViroPortalScene passable              origin = centre of the opening
      ViroPortal
        Viro3DObject door_frame.obj       frame + transparent "window" quad
      ViroSkyBox (colour)                 background of the inner world
      ViroNode (down to floor level)
        VirtualRoom                       walls, floor, ceiling, objects, lights
```

Constraints taken from the renderer's source code (ReactVision/virocore and the Android
bridge) and built into the door model. They were read from the code, **not yet confirmed
on a device**:

- On Android the children of `ViroPortal` must be `Viro3DObject`s; primitives are rejected.
- The inner scene is drawn only where the frame model has geometry whose **diffuse texture**
  alpha is ≤ 0.1. An empty hole shows nothing. So the model contains a quad that fills
  the opening and samples a fully transparent texel; the frame samples opaque texels of
  the same 16×16 texture. Every face maps all its vertices to one texel centre, so the
  result does not depend on mip level or distance.
- "Walking through" is detected by intersecting the camera's movement between two frames
  with the plane through the `ViroPortal` origin (normal = local Z); the hit must lie
  inside the frame's bounding box. The model origin is therefore the centre of the
  opening and the frame straddles z = 0.
- After a crossing the renderer keeps the frame two-sided until the camera is more than
  1 m from the frame origin — another reason for the origin to be in the middle of the
  opening and not on the floor.
- Lights are global in ViroReact, so the AR lights and the room lights are separated
  with `influenceBitMask` / `lightReceivingBitMask` (`doorGeometry.ts`).

**Flicker when the camera crosses the doorway plane.** The renderer has a built-in
measure: it switches the active scene when the camera is still 4 cm in front of the
plane, before the near clip plane can cut the stencil quad, and renders the frame
two-sided right after the switch. This project adds nothing of its own beyond meeting
the model requirements above (window exactly in the crossing plane, origin in the
opening) and putting the room's front wall 7 cm behind that plane. Whether a flicker is
still visible **could not be judged without a device**. If it is, the tuning constant
lives in native code (`VROPortalTraversalListener.cpp`), which means a custom build of
the renderer.

**Way back.** Inside the room the doorway is in the middle of the front wall, shows the
camera image and has an "EXIT TO AR" label above it, so turning around is enough.

**Attach modes** (debug switch). `direct`: the `ViroPortalScene` is a direct child of
`ViroARScene` and carries the pose itself. `parent`: a `ViroNode` carries the pose and
the portal scene sits under it. Both should look identical. The switch exists because,
according to the ViroReact 3.2.1 release notes, direct children of `ViroARScene` are
attached to native AR anchors once tracking is NORMAL, and because localization
providers will later *move* the portal — which of the two attachments stays stable must
be decided on the device.

## Assets and licences

All 3D assets are original and generated by `scripts/generate-assets.mjs` (committed for
convenience; `npm run assets` reproduces them byte for byte). No third-party models,
textures or images of real places are used.

| File | Source | Licence |
| --- | --- | --- |
| `assets/models/door_frame.obj` | generated by this project | original work of this project |
| `assets/textures/door_frame.png` | generated by this project | original work of this project |
| `assets/textures/room_wall.png`, `room_floor.png`, `room_ceiling.png` | generated by this project | original work of this project |
| `assets/icon.png`, `assets/android-icon-*.png`, `assets/splash-icon.png` | default icons of the `create-expo-app` template (`expo-template-blank-typescript`) | MIT (Expo) |

Third-party code comes only through npm (see `package.json`); the main ones:
`@reactvision/react-viro` (MIT), `expo` (MIT), `react-native` (MIT). ViroReact ships
Google's ARCore client library as a binary, which is covered by Google's own terms.

## Not verified yet

Everything below needs a real ARCore phone. None of it has been run:

- that the app starts at all on a device (React Native 0.88 + ViroReact 3.2.2 is a very
  recent combination; the pull request that moved ViroReact to React Native 0.88 states
  that it was not run on a device);
- camera feed, tracking state callbacks, camera transform updates, plane detection;
- that the door model satisfies the portal renderer (inner room visible through the
  frame, frame opaque, nothing visible outside the opening);
- `onPortalEnter` / `onPortalExit` firing, and at the right moment;
- flicker or popping while crossing the doorway plane;
- the view back from inside (camera image through the doorway);
- separation of AR and room lights by bit masks; text sizes; texture orientation;
- the two attach modes, and whether auto-anchoring moves the portal;
- behaviour after tracking loss and re-localization;
- loading the embedded bundle without Metro, and Metro taking priority when present.

## Known issues and limitations

- The doorway position is **not persistent** (stage 1). Every start places it relative
  to the phone.
- The floor height is a guess until ARCore reports a horizontal plane; before that the
  doorway is placed 1.4 m below the camera. Use *Re-place door* after looking at the floor.
- The renderer does not check the crossing direction: walking through the frame from
  behind also counts as "entering", and you end up outside the room's walls.
- The portal must not move while the user is crossing it (the crossing test compares
  camera positions between frames). Providers should not emit pose updates at that moment.
- Open ViroReact issues on Android that may affect a particular phone:
  [#568](https://github.com/ReactVision/viro/issues/568) (Galaxy A56 / Android 16:
  tracking never settles), [#513](https://github.com/ReactVision/viro/issues/513)
  (Galaxy A54 + Expo: black camera), [#499](https://github.com/ReactVision/viro/issues/499)
  (Galaxy S24: camera texture).
- `npm ci` reports 4 moderate advisories in transitive development dependencies; they
  were left as they are (the fix npm proposes, `npm audit fix --force`, includes breaking
  changes).
- Only `arm64-v8a` is built. 32-bit phones and x86 emulators are not supported (the
  emulator cannot run ViroReact AR anyway).
