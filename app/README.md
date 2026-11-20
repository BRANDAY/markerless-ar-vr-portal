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

> **Device status.** The first build (commit `9cb8a8b`) was tested once on a Xiaomi 14
> Ultra: camera feed, tracking, the door frame, the room seen through it, walking in and
> back out all worked. Three defects were found and addressed afterwards; **the fixes
> themselves have not been re-tested on the phone yet.** Details:
> [Verified on a device](#verified-on-a-device) and [Not verified yet](#not-verified-yet).

## Status against the assignment

| Task | State |
| --- | --- |
| 1. Camera feed and basic 3D objects in AR | Implemented (`src/ar/PortalARScene.tsx`); camera feed and tracking confirmed on a device |
| 2. Recognise a previously scanned room without markers | **Not implemented.** Interface + three stubs only (`src/localization/`) |
| 3. Doorway at the same real-world pose in every session | **Not implemented.** Depends on task 2; the doorway pose already flows through one place |
| 4. See a virtual room through the doorway, walk in and back out | Implemented (`src/ar/DoorPortal.tsx`, `src/ar/VirtualRoom.tsx`); confirmed on a device, one visual defect at the crossing (see below) |
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
  took 2–3 min. The debug APK is about **70 MB** (`arm64-v8a` only, unstripped debug
  libraries, Hermes bytecode bundle 1.9 MB).
- Disk used on that machine, measured after the build: Gradle user home 3.8 GB, npm
  cache 0.5 GB, the three SDK packages 2.6 GB (the NDK alone is 2.3 GB), `node_modules`
  0.8 GB (including the native build output of the modules), the generated `android/`
  folder with its build output 0.9 GB. Have roughly 10 GB free before the first build.
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

5. Grant the camera permission when the app asks. (If the app was started while the
   screen was locked, the dialog appears once the phone is unlocked and the app is in
   front; a *Grant camera access* button is shown as well.)
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
(starting from the embedded bundle is confirmed on a device; Metro taking priority is
standard React Native behaviour and has not been tried here):

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
  models/door_frame.obj       generated door frame (frame + transparent "tunnel")
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
        Viro3DObject door_frame.obj       frame + transparent "tunnel" through it
      ViroSkyBox (colour)                 background of the inner world
      ViroNode (down to floor level)
        VirtualRoom                       walls, floor, ceiling, objects, lights
```

Constraints taken from the renderer's source code (ReactVision/virocore and the Android
bridge) and built into the door model. The device test agrees with them (the room is
visible only through the doorway, the frame is opaque, the AR/VR switch happens at the
door plane), but they were derived by reading code, not by experiments:

- On Android the children of `ViroPortal` must be `Viro3DObject`s; primitives are rejected.
- The inner scene is drawn only where the frame model has geometry whose **diffuse texture**
  alpha is ≤ 0.1. An empty hole shows nothing. So the model contains transparent
  geometry in the opening that samples a fully transparent texel; the frame samples
  opaque texels of the same 16×16 texture. Every face maps all its vertices to one
  texel centre, so the result does not depend on mip level or distance.
- "Walking through" is detected by intersecting the camera's movement between two frames
  with the plane through the `ViroPortal` origin (normal = local Z); the hit must lie
  inside the frame's bounding box. The model origin is therefore the centre of the
  opening and the frame straddles z = 0.
- After a crossing the renderer keeps the frame two-sided until the camera is more than
  1 m from the frame origin — another reason for the origin to be in the middle of the
  opening and not on the floor.
- Lights are global in ViroReact, so the AR lights and the room lights are separated
  with `influenceBitMask` / `lightReceivingBitMask` (`doorGeometry.ts`).

**Crossing the doorway plane.** The renderer has a built-in measure against flicker: it
switches the active scene when the camera is still about 4 cm in front of the plane
(measured along the viewing direction) and renders the frame two-sided right after the
switch.

On the device this was not quite enough. Observed with the first build, whose door model
had a single transparent quad in the plane of the doorway: at the AR → VR crossing, in
one frame right before the switch, the top ~45 % of the screen showed the real camera
image while the lower part still showed the virtual room. Nothing comparable was seen on
the VR → AR crossing. The likely cause (an inference from the renderer code, not a
measurement): when the user walks fast with the phone tilted down, the camera of the
rendered frame is already past the quad — or within the near clip distance of it — before
the switch happens; the upper part of the view then no longer contains the quad, so no
portal content is drawn there.

Mitigation in the current model: the transparent part is a **tunnel** through the frame
instead of one quad — the window in the crossing plane, a second window 14 cm further
at the back of the frame, and four side walls hidden inside the frame. A camera that has
overshot the first window still looks at transparent faces in every direction, so the
room stays on screen until the switch. The frame was made deeper on the room side
(6 cm in front of the plane, 14 cm behind it) to give the tunnel that length, and the
room's front wall sits 1 cm behind the frame. All tunnel faces are wound towards the AR
side / the tunnel axis, because after the switch the renderer draws only back faces into
the stencil and a face seen from within the tunnel must not act as the way out.
**This mitigation has not been tested on the phone yet.** If a flash remains, the next
lever is in native code (the 4 cm constant in `VROPortalTraversalListener.cpp`), which
means a custom build of the renderer.

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

## Verified on a device

One test session of the first build (commit `9cb8a8b`, APK unchanged), judged from a
52-second screen recording and the on-screen debug overlay.

Device: Xiaomi 14 Ultra (model 24031PN0DC), Android 16 (SDK 36), `arm64-v8a`,
Google Play Services for AR 1.57.262640293. Installed with `adb install -r`.

Confirmed:

- the embedded JavaScript bundle loads without Metro; no crash;
- camera feed renders, tracking reaches NORMAL, a floor plane is found (floor y −0.58 m,
  later re-detected at −0.67 m);
- the door frame renders opaque, the virtual room is visible only through the doorway,
  the real world is visible around the frame;
- the AR/VR indicator flips at the door plane and matches the geometry (computed from
  camera position against door position and yaw: about 11 cm before the plane = AR,
  about 17 cm past it = VR);
- from inside, the real room is visible back through the doorway, and walking out
  forwards gives EXIT → AR;
- *Re-place door* works; attach modes `direct` and `parent` both render the door
  correctly; the three stub providers report "not implemented".

Defects found in that session and what was done about them:

| Defect | State |
| --- | --- |
| Started while the screen was locked, the app logged `Tried to use permissions API while not attached to an Activity` and never got the camera permission | Fixed in code: the dialog is requested only while the app is active, failed attempts are retried, and the state is re-checked whenever the app becomes active. Not re-tested on the phone |
| The event log panel was one entry behind (the newest line appeared only with the next one) | Fixed in code: scrolling now happens after layout (`onContentSizeChange`). Not re-tested on the phone |
| One-frame flash at the AR → VR crossing (top ~45 % of the screen showed the camera image) | Mitigation in the door model, see [How the portal works](#how-the-portal-works). Not re-tested on the phone |

## Not verified yet

- the three fixes above, and the look of the deeper door frame that came with the
  mitigation;
- long-term drift of the doorway while the app keeps running;
- behaviour when the parent node of the portal is actually *moved* by a provider (the
  attach-mode switch was only tried with a static pose), and whether auto-anchoring
  moves the portal;
- behaviour after tracking loss and re-localization;
- phones other than the one above;
- Metro taking priority over the embedded bundle in the development loop;
- details nobody looked at specifically: separation of AR and room lights by bit masks,
  3D text sizes, texture orientation;
- a clean clone built end to end with the documented commands (the steps were run
  individually on the development machine).

## Known issues and limitations

- The doorway position is **not persistent** (stage 1). Every start places it relative
  to the phone.
- A one-frame flash of the camera image was seen at the AR → VR crossing with the first
  build; a mitigation is in place but unconfirmed (see
  [How the portal works](#how-the-portal-works)).
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
