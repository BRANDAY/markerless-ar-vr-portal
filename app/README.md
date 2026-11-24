# FESB AR Portal — markerless AR-to-VR portal (proof of concept)

A mobile app that shows a doorway in augmented reality. Through the doorway the user sees
a virtual world - the atrium of the Sponza Palace in Dubrovnik -, can physically walk
through it into VR and walk back out into AR. The goal of the assignment is that the
doorway appears at the same real-world place in every app session, found without
markers, QR codes or GPS: a staff member scans the room once and a self-hosted server
builds a map and a plan of the room from the recording; the staff member then puts the
door where it should stand and saves it to the server. From then on every phone that
opens the app in that room gets the door from the server, in the same place.

**Where this stands (2026-11-20).** Everything is written and unit-tested. On a phone
(Xiaomi 14 Ultra) these parts have been seen working: the AR scene and the walk-through
portal (with the first, simple room), the connection to the server, the room mesh, the
recording, and the upload with its progress. **Not yet seen on a phone:** a map built
from a real room recording, the doorway in the real opening, finding the room again
after a restart, the atrium and the wooden door casing by eye, and everything about
tracking loss. The details are in [Verified on a device](#verified-on-a-device) and
[Not verified yet](#not-verified-yet); read them before relying on anything.
The product screens added on 2026-11-21 ([The interface](#the-interface)) have not been
on a phone at all.

**First full pass on a phone, 2026-11-21 (build `5e28ed7`).** The owner scanned a room,
the server built its map (12 min), the door was saved, and after a restart the visitor's
phone put the door back in 48.5 s (8.7 s at best). What did not work, and what was
changed for it, is in [After the first pass on a phone](#after-the-first-pass-on-a-phone);
none of those changes has been on a phone yet.

New here? Go through [Setup on Windows](#setup-on-windows), then
[The scenario, step by step](#the-scenario-step-by-step).

## Status against the assignment

| Task | State |
| --- | --- |
| 1. Camera feed and basic 3D objects in AR | Implemented (`src/ar/PortalARScene.tsx`); camera feed and tracking confirmed on a device |
| 2. Recognise a previously scanned room without markers | **Written; half of it seen on a device.** The app scans the room (planes, room mesh, video with camera poses) and sends the recording to the localization server, which builds the map and the room plan; in a later session a short clip sent to `/localize` finds the room again. Seen on the phone: mesh, recording, upload, build progress, the server's refusal of a one-second recording shown in words. Not seen: a successful build from a phone recording, and finding the room again ([the scenario](#the-scenario-step-by-step)) |
| 3. Doorway at the same real-world pose in every session | **Written, not yet run on a device.** A staff member places the door in the scanned room and saves it to the server ([Placing the door](#placing-the-door)); every later session, on any phone, finds the room through the server and gets the door at that place, with its size (`self-hosted` provider). Against the server on the PC, with a test recording that lies there, the app's client code saves a door and gets it back from `/localize` at the same place, and a door set in a test map comes back 2.3 cm from where it should be ([End-to-end check without a phone](#end-to-end-check-without-a-phone)) |
| 4. See a virtual world through the doorway, walk in and back out | Implemented (`src/ar/DoorPortal.tsx`); the walk-through was confirmed on a device with the stage-1 test room, one visual defect at the crossing (see below). The world behind the door is now the atrium of the Sponza Palace with a wooden door casing (`src/environments/`): both load on the phone without an error, **nobody has looked at them yet** |
| 5. Tests: restart, angles, lighting, tracking loss | **Tools and procedure written, tests on a device not started.** What the app does when tracking is lost and comes back, how often it asks the server again and what it does with weak answers is implemented and unit-tested ([Keeping the doorway in place](#keeping-the-doorway-in-place)). A measurement mode records every localisation and compares the door with the marked corners of the real opening, in centimetres and degrees ([Measuring where the door stands](#measuring-where-the-door-stands)); the procedure for the five checks is in [`docs/test-protocol.md`](docs/test-protocol.md). **No trial has been run on a phone** |

## Stack

| Component | Version | Note |
| --- | --- | --- |
| Expo SDK | 58 (`expo` 58.0.26) | prebuild / "bare" workflow, no Expo Go, no EAS |
| React Native | 0.88.1 | New Architecture (the only mode in this version) |
| React | 19.3.0 | |
| ViroReact | `@reactvision/react-viro` 3.2.2 | AR renderer on top of ARCore |
| Expo modules | `expo-file-system` 58.0.14, `expo-build-properties` 58.0.12 | saved server address; cleartext HTTP switch |
| Own native module | `modules/wifi-route` (Kotlin, Android) | keeps the app's connections on Wi-Fi, reports the phone's Wi-Fi address |
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

This folder is one part of the repository; the localization server it talks to is a
separate repository ([BRANDAY/arportal-localization-server](https://github.com/BRANDAY/arportal-localization-server)), linked into this
one as the git submodule `localization-server/`. Clone both with `--recurse-submodules`,
as the [README of the repository](../README.md) shows. The app builds without the
server's folder; it needs a running server only when it is used.

### 1. Tools

- Node.js 24 (npm 11), Git.
- JDK 21, with `JAVA_HOME` pointing at it.
- Android SDK with `ANDROID_HOME` set and `platform-tools` on `PATH` (Android Studio is
  not needed, the command-line tools are enough; it can be used, see
  [Open in VS Code and Android Studio](#open-in-vs-code-and-android-studio)). Required packages:

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
drive for the current PowerShell session, dot-source `scripts/env.ps1` with a folder of
your choice before the commands below:

```powershell
. .\scripts\env.ps1 -CacheRoot D:\build-caches
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
  took 2–3 min. The debug APK is about **93 MB** (`arm64-v8a` only, unstripped debug
  libraries, the atrium model 21 MB, Hermes bytecode bundle 2 MB).
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

   The log names every screen the user opens (`screen: scan (after scanPrepare)`), the
   mode the app started in, the camera permission, how a scan ended, the upload by
   quarters and the sheets shown over the camera, besides what the server connection,
   the search for the room and the door report. While the phone is connected to a
   server, the same lines go to it (`work/device-logs/<device id>.jsonl` on the server
   PC and its panel at `/ui`), so a session can be read without a cable.
7. After a test, everything the app keeps on the phone is copied to the PC with one
   command, in Git Bash (PowerShell damages binary output of `adb`):

   ```
   bash scripts/pull-device-data.sh <output folder> [--captures]
   ```

   It saves the app's lines from logcat, a list of the app's files, its settings and
   the measurement records (`files/measurements`), and with `--captures` the room
   scans themselves (`files/captures`, 100-300 MB each; the app never deletes a
   finished scan). It changes nothing on the phone. Written on 2026-11-21, **not yet
   run against a phone**.

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

Other scripts: `npm run typecheck` (TypeScript), `npm test` (212 unit tests of the pure
modules, run in Node), `npm run build:android` (the Gradle build above),
`npm run e2e:server` (the app's client against a real server,
[without a phone](#end-to-end-check-without-a-phone)), `npm run measure:report` (summary of the
[door measurements](#measuring-where-the-door-stands)), `npm run assets` (regenerate
textures and the simple door model).

### Open in VS Code and Android Studio

**Visual Studio Code** — for the app's code (TypeScript, React Native, ViroReact).

1. Open the file `vr-fesb.code-workspace` in the repository root (the app and the server in
   one window), or *File → Open Folder…* → this `app` folder.
2. Run `npm ci` once in `app`; type checking and completion work after that.
3. VS Code offers the recommended extension *React Native Tools* (optional).
4. Work loop: edit, then `npm run typecheck` and `npm test` in the terminal of VS Code, then
   build and install as in steps 4–5 above, or use the development loop with Metro.

**Android Studio** — for the native side: Gradle build, installing on the phone, Logcat,
debugging native code.

1. Run once in `app`: `npm ci` and `npx expo prebuild --platform android --no-install`. The
   `android` folder is generated by that command and is not in git.
2. Android Studio → *Open* → choose **`app\android`** (not `app`).
3. *Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK*: JDK 21
   (the same as `JAVA_HOME`). Android Studio 2026.2 brings its own Java 25; the command-line
   build uses 21, so pick 21 to share one build. If the command-line builds used
   `scripts/env.ps1 -CacheRoot <folder>`, set *Gradle user home* on the same page to
   `<folder>\gradle-home`; otherwise Android Studio downloads all dependencies again into
   `%USERPROFILE%\.gradle` (about 4 GB).
4. Wait for the Gradle sync; the first one downloads a lot (see the build times above). The
   React Native Gradle plugin calls Node.js. If the sync says that `node` is not found, start
   Android Studio from a terminal in which `node -v` works.
5. Pick the phone in the device list and press *Run 'app'*. Android Studio builds the same
   debug APK as `gradlew assembleDebug` and installs it. The JavaScript bundle is embedded,
   so Metro is not needed. When Metro runs (development loop above), the app takes the
   JavaScript from it.
6. *Logcat*: filter `package:hr.fesb.arportal`, or the tag `ReactNativeJS` for the app's own
   lines.

Do not edit files under `android/` in Android Studio: `expo prebuild` writes them again. Change
`app.json` or `plugins/` instead. The *SDK Manager* of Android Studio can install the SDK
packages listed in step 1.

## The interface

Since 21 November 2026 the app has product screens, built step by step from
[`docs/product/ui-spec.md`](../docs/product/ui-spec.md) (steps 0 to 3 of its first revision, and
steps A, B, D and F of the second: the two modes, placing the door, the guided scan,
inside the space). **None of these screens has been seen on a phone**; the build on the phone is still
`546697d`. "Vrata" and the amber and teal colours are working choices, kept in one file
(`src/brand.ts`).

### Two modes

The app is always in one of two modes, and remembers which (`app-prefs.json`).

- **Visitor mode**, also after a fresh install: one screen. The first launch shows a
  welcome panel ("Step through the door", **Start**); **Start** asks for the camera.
  Later launches open the camera at once. The app looks for the server on the Wi-Fi by
  itself ("One moment…"), finds the room and shows the door: no button, no settings.
  A door stands **only where staff saved one** (the server's `portal.source` is
  `manual` or `selected`), for visitors and for staff alike; a doorway the server only
  found is a suggestion on the placing screen and is never shown as a door. When something
  does not work, a sheet says so in plain words ("The door isn't ready - please ask a
  member of staff"), with **Try again** and a small line for staff ("No server on this
  Wi-Fi", "No door has been placed yet", "Room not recognised"...). A help button brings
  the welcome panel back.
- **Staff mode**: Home, scanning, settings. It is entered through the small lock on the
  welcome panel and the **staff PIN** - four digits, created at the first use of the lock
  and kept on the phone as a hash; five wrong tries lock the pad for 30 seconds. The first
  time, the three welcome cards and **Find the server** come before Home. **Switch to
  visitor mode** is on Home and in Settings; **Change staff PIN** is in Settings.

What staff meet, in order:

1. **The first time in staff mode:** three welcome cards, the camera permission screen if
   the camera is not allowed yet, then **Find the server**, which searches the Wi-Fi at
   once.
2. **Home.** The app name, a server chip (green dot and the server's name when
   connected), the settings button, and one card with one amber button:
   - a room with a saved door: tag "Ready", its plan drawing with the door in amber, its
     name, "Door placed {date} · {w} × {h} m", and **Open the door**;
   - a room without a saved door: tag "No door yet", "Put the door where visitors should
     find it.", **Place the door** ([below](#placing-the-door)) and **Scan again**;
   - connected, no room yet: **Scan this room**, which starts the guided scan (below);
   - a scan is being sent or built: the percentage and **See progress**;
   - server offline or never set up: **Search again** or **Find the server**.
3. **The AR screen.** Over the camera there is a close button, the name of the room or of
   the space, and one instruction at a time: "Point at the room and hold still", "Try
   another view", "Take a step sideways", "Slow down"... When the door stands, the
   instruction goes and "Walk through the door" shows for five seconds. A menu holds
   **Find the door again**, **Move the door** (the placing screen, with the door at its
   saved place) and **Remove the door** (asks first; the room then counts as having no
   door). In a room without a saved door a sheet says "This room has no door yet" and
   leads to **Place the door**. Small states are a pill under the top row ("The door may be
   slightly off · Find again", "Server offline · the door stays where it is") or a red
   banner ("Lost track of the room"). A first door position that the server is not sure of
   is drawn as an amber dashed outline until a second look confirms it.
   **Inside the space** the screen shows "Door is behind you" while the door is out of the
   view (more than 35 degrees from the middle of the picture, on the floor plan), and an
   info button that opens "About this place" (place, date, a paragraph, the model's credit
   and licence; the texts are in `src/i18n/en.ts`, the list of spaces in
   `src/spaces/spaces.ts`). When the phone comes within 0.6 m of a real wall of the room,
   the coach says "A real wall is close" and that wall is drawn as a grid inside the
   space, at full strength from 0.3 m. The walls are those of the room plan the server
   sends with the door's position, so there is no warning for a door without a room, or
   for a room whose shape the server could not measure.
   **The shutter** (a 68-point button at the bottom, once a door stands and inside the
   space; on the visitor screen too) takes a photo of the view through the AR view's own
   screenshot call, which is expected to leave the buttons out. The picture goes to the
   phone's gallery (if the engine refuses that, into the app's own storage), and a small
   preview with "Saved to your photos" or "Photo taken" shows for 4 seconds. **Not tried
   on a device**: that the picture is without the interface, where it lands, and whether
   the gallery needs a permission. The spec's **Share** is not offered, see below.
4. **Settings:** server, automatic search, **Switch to visitor mode**, **Change staff
   PIN**, privacy, **Credits and licences**, "How it works", the version line.
5. **Spaces** (`src/ui/SpacesScreen.tsx`; spec 5.10): what can stand behind the door.
   Opened by **Change** on Home's card "Behind the door", by the space's name at the top
   of the staff AR screen, and by **Change the space** in its menu. One card per space
   (picture, name, "{place} · walk-in 3D · {size} MB", the tag "Behind your door" or "On
   this phone"); a tap opens a sheet with two sentences, the size and the credit line,
   and **Put behind my door**. Under the list: what walk-in spaces and 360° views are.
   - **The choice is kept per room** (`src/spaces/core/choice.ts`, tested;
     `src/spaces/spaceChoice.ts`), in the phone's preferences. **On this phone only**:
     the server has no place for a room's space yet (spec section 9, S5), so a second
     phone shows the first space of the list, whatever was chosen on the first one.
   - **There is one space**: the Sponza atrium. With developer options on, the test room
     is listed as well (the developer switch "Test room" and the tools' **World** button
     now make the same choice for the room). The filter chips of the spec appear from
     seven spaces on and are therefore never seen; nothing can be downloaded, so there
     is no download button.
   - The screen is not over the camera: opened from the AR screen it ends that AR view,
     and coming back the room is found again before the door stands with the new space.
6. **Credits and licences** (`CreditsScreen` in `src/ui/MoreScreens.tsx`, facts in
   `src/spaces/credits.ts`; spec 5.12): the model and the sky of the atrium with author,
   licence, source and the changes made (CC BY 3.0 asks for those), the two wood
   photographs behind the door frame and the door, and the packages the app depends on
   directly with the copyright lines of their licence files. Not listed: software that
   comes in indirectly (the AR engine among it) and the full texts of the licences.
   Nothing of 5 and 6 has been seen on a device.
7. **Rooms** (`src/ui/RoomsScreen.tsx`, rows and menu decided in
   `src/ui/core/roomsView.ts`, tested; spec 5.11): one row per room of the server, read
   with `GET /maps`. Opened by the arrow beside the room's name on Home, and from the
   staff AR screen by **This is a different room** (under the coach lines from the fourth
   attempt on) and **Choose another room** (on "This doesn't look like ...").
   - The line of a row: "Ready · {space}" (teal), "No door yet · place the door" (amber),
     "Building the map · {p}%" (amber; a tap opens the build), "Scan again · the room has
     changed" (red).
   - **Red** means: the room was not found in three AR sessions in a row
     (`src/room/roomAdmin.ts`). An AR session - the time the AR view lives - counts once
     at most, when its search gives up as "not recognised" after the server did compare
     the camera's picture with the room; a search in which the server never answered (no
     clip recorded, requests failed) does not count, and neither does a session in which
     the room was found. A room that is found, or scanned again, starts anew. The count
     is kept on this phone (`missedByRoom` in the preferences, a key the spec does not
     list).
   - **A tap on a row** makes that room the one the app works with and leads back. The
     spec does not say what a tap does; without it a second room could not be opened,
     because the app still names the room when it asks the server where the phone is.
   - The row's menu: **Move the door** / **Place the door**, **Remove the door**,
     **Change the space**, **Scan again**, **Rename**, **Delete** - the last two only when
     the server announces `rooms_admin`. Rename is a sheet with a text field (at most 80
     characters, the server's limit). Delete asks first, in the spec's words.
   - **What "Delete" does on the server**: it takes the room out of use and moves its
     folder into `.trash` on the server's disk; whoever runs the server can put it back.
     The question on the screen says the map and the video "are removed" - that is the
     spec's text, and it says more than the server does.
   - Under the list: "Rooms live on the server ...", and **Scan a new room**.
   Not seen on a device.
8. **Language** (spec 4.2, 5.12, 5.13): English and **Croatian** (`src/i18n/hr.ts`, every
   text of `en.ts`; the type makes a missing key an error, and a test compares the
   `{parameters}` of each pair). The app speaks the language chosen in it, else the
   phone's, else English (`src/i18n/languages.ts`, tested; the phone's language is read
   in `src/state/language.ts`). It is chosen under **Settings > Language** (a list) and
   by the chips at the bottom of the visitor's welcome panel, which need no PIN. Dates
   follow the app's language.
   - **The Croatian texts were written by the assistant and have not been read by a
     native speaker.** The notes at the top of `hr.ts` say what was decided (the polite
     form; "aplikacija {app}" so that the product's name stays out of the cases; counts
     as "Pronađenih zidova: {n}").
   - Not translated: the developer options and tools, what the server says in its own
     words (the warnings about a room's link), and the names of works, people and
     licences on the credits page.
   - Not seen on a device: that a phone set to Croatian starts the app in Croatian (the
     phone's language is asked from React Native, with the JavaScript engine's own
     answer as the second source), and that nothing is cut off - Croatian lines are
     longer than the English ones.

### Scanning a room

One flow in place of the buttons **Scan room**, **Record** and **Upload** of the tools:

1. **Before you start**: three reminders (lights on, doorway clear, a path along the
   walls), how long it takes, and the name of a new room ("Room 1"...). The name becomes
   the room's label on the server and, made safe, its id (`room_1`); an id that exists
   gets `_2`, `_3`, so a new room never replaces another one. A scan started with **Scan
   again** replaces the map of the room it is for.
2. **Scanning**, over the camera. The room mesh is switched on before the AR view starts
   and the recording begins by itself once tracking is ready. A coach card says what to do,
   counters show floor, walls, the area walked over and the three tilts (down, level,
   up), and there is one button:
   - step 1, "Walk in a circle along the walls": the button counts down from 60 s and stays
     disabled until a minute has passed, a floor has been found, the area walked over is at
     least 1.5 x 0.5 m and the phone has been held down, level and up long enough (see
     [After the first pass on a phone](#after-the-first-pass-on-a-phone)); the coach asks
     for the first thing still missing;
   - step 2, "Now show where the door will be", with amber corner brackets as an aiming
     aid: **Done, I showed it**;
   - step 3, "That's enough": **Finish scan**. From 150 s on the scan can be finished in any
     case; at 180 s it finishes by itself.
   Tracking warnings ("Slow down", "It's too dark here"...) replace the step text while
   they apply. Closing asks first and then discards the scan. The thresholds are in
   `src/ui/core/scanFlow.ts` (`SCAN`); they are starting values.
3. **Building your room**: the upload and the server's build as one percentage (the upload
   is the first 8 %), five steps, and a time line ("Sending 40% of 180 MB", "About 6
   minutes left", "Step 3 of 5"). The screen can be closed; Home then shows the percentage.
   **Cancel** asks, then stops the upload or the server's build. At the end: "The map is
   ready", or one of the problem screens with **Send again** or **Scan again**. The scan
   stays on the phone (`captures/<name>` in the app's documents folder) in every case.

What the server says goes to the log; the screen gets one of nine prepared texts
(`src/ui/core/buildView.ts`). A recording the server refuses at once (`X-Error-Code:
recording_too_short` or `too_little_motion`, server 0.3.0 and later) is shown as "The scan
was too short". If a build for the room is already running (HTTP 409), that build is
followed. A build may take twenty minutes and more on a slow computer, and the phone may be put
aside meanwhile: there is no time limit on the wait. If the server stops answering (each
check waits up to 8 s) for twelve checks in a row, the screen says so; the build is taken
up again when the server answers, when the app comes back to the front, and every 5 s in
between. After a restart of the app (Android may end an app that waits in the background)
the build is found again on the server by its job id, which is kept with the scan: Home
shows its progress, or the finished room, or the failure. Not tried on a phone.

### Placing the door

The main way a door gets its place (`ui-spec.md`, 5.8 and 5.14). After a build, **See the
room** opens the **room result**: the plan drawing with wall lengths, a one-metre bar and
the doorways the server found (amber, with letters), one sentence about what was found,
**Place the door** and **Scan again**. A found doorway is a suggestion; nothing is saved
there.

**Place the door** (also on Home for a room without a door, and as **Move the door** in
the staff AR menu) opens the camera and first finds the room, like the AR screen. Then:

- the door appears at its saved place if there is one, else in the doorway the server
  suggests, else on the floor two metres in front of the camera, facing it. It is drawn
  as visitors will see it, with an amber outline on the floor under it and a short arrow
  on the floor pointing from the room into the space. It cannot be walked through while
  it is being placed;
- a small cross marks the middle of the picture. **Put it here** moves the door to the
  spot on the floor the phone is aimed at, turned to face the camera: the side the staff
  member stands on is the room side. When the phone is not aimed at the floor (less than
  8 degrees below the horizon, or at a spot more than 6 m away) the door goes two metres
  in front of the camera;
- **Adjust** opens a panel: move by 5 cm along the door and towards or away from the
  room, turn by 5 degrees, **Turn around**, width (0.60-1.40 m) and height (1.80-2.40 m)
  in steps of 5 cm, **Use the found doorway** (each tap goes to the next doorway the
  server found). Holding a step button repeats the step. The door always stands on the
  floor;
- **Save door** writes the door down in the room's frame and sends it as the room's one
  door record: `PUT /maps/{id}/anchors/portal` with `position`, `quaternion_xyzw`,
  `width` and `height` (see [One door, whatever recognises the room](#one-door-whatever-recognises-the-room)).
  Then "Door saved", with **See it as a visitor** (switches to visitor mode) and
  **Done** (Home). If it fails: "The door wasn't saved", **Try again**. Closing after a
  change asks "Leave without saving?".

What decides when a door can be saved: the room must be recognised in the running AR
session. The door layer records that in the room store (`found`: room, the room's frame
in this session, the plan and the doorways in this session's coordinates) with every
answer that says where the room is, and drops it as soon as tracking is interrupted,
because the session's coordinates may have changed; the room is then found again before
**Save door** is enabled ("Finding your room…"). The session id sent with `/localize`
changes with every new AR view and after every interruption of tracking, as the server's
contract asks.

Details that are choices of the app, not of the spec:

- Width, Height and the size readout are shown only when the server announces the
  capability `door_size`; without it other phones would draw 0.90 × 2.00 m whatever was
  set, so the door being placed is drawn at that size as well.
- For a door that is already saved, **Save door** stays disabled until something was
  changed: saving the unchanged door through a new alignment would move it by that
  alignment's error.
- While a saved door's first position is still being checked by the server's second look
  (the weak-match rule of [Keeping the doorway in place](#keeping-the-doorway-in-place)),
  the screen still says "Finding your room…". In a room without a saved door there is
  nothing to check against, and the first complete alignment counts, weak or not; the log
  line of the save says "weak match" then.
- The server can also take a door **without `/localize`, in the AR session that recorded
  the room**. The app does not use that: the AR view is closed while the map is built, so
  the session that recorded the room no longer exists when the door is placed. One
  `/localize` (a 1.2 s clip) comes first, as after any restart.
- A door is always saved as "placed by hand" (`manual`), also when it stands exactly in a
  found doorway; the server's "accept the suggested doorway" call is not used.

The steps of the panel and "Put it here" are in `src/ui/core/doorEdit.ts`, what the
screens show when in `src/ui/core/placeView.ts` (both unit-tested); the screens are
`src/ui/PlaceDoorScreen.tsx` and `RoomResultScreen.tsx`, the server calls
`src/room/doorServer.ts`, the floor outline `src/ar/PlaceMarker.tsx`.

### The second connection method: ReactVision Advanced VPS

**Written, and never run: there is no ReactVision account yet, so neither a phone nor the
service has seen any of this.** The venue's own server stays the main way. The owner's
side (account, plan, keys) is described in
[`docs/cloud/cloud-connection.md`](../docs/cloud/cloud-connection.md).

**The keys and the build.** `app.config.js` reads
`<secrets folder>\reactvision-app.json` with the fields `rvProjectId` and `rvApiKey` (the
*client* key, `rv_client_...`) when the native project is generated. The secrets folder
is `E:\VR-FESB\secrets`, or what the environment variable `VRFESB_SECRETS_DIR` names; it
is outside the repository, which is public.

- File there: the ViroReact plugin gets `provider: "reactvision"` and the two values;
  `npx expo prebuild` writes them into the generated `android/` project (git-ignored) and
  so into the APK. Run `npm run prebuild` again after putting the file there. Such an APK
  carries the client key: do not attach it to a public release.
- No file: nothing changes (`provider: "none"`), the app builds as before, and the
  ReactVision way says that it is not set up.
- A file that holds a secret key (`rv_secret_...`) stops the build. The secret key
  belongs to the server and never goes into the app.
- With `provider: "reactvision"` the plugin adds the two location permissions to the
  manifest (checked with `npx expo config --type introspect` and a made-up key). The app
  never asks for them: a room is always looked for by its location id, never with the
  library's `"auto"`, which starts from GPS.

**In the app.** A build **with** keys has a **Connection** row in Settings and behind it
the page of `ui-spec.md`, 5.15 with the two methods. A build **without** keys - the
normal one - shows neither the row nor the second method: the venue's own server is the
only way and nothing on screen mentions the service (decision of 2026-11-21: the service
costs money, the own server is the alternative to it; this code stays, optional and
never run).
The page also has the switch "Recognise in the cloud" (matching on the vendor's servers,
which the vendor charges for by the minute; off by default), a field for the room's
**ReactVision location ID**, and below it the room's **link** to that place with the
button **Link to the room**.

**One door for both ways.** The room has one door record, kept by the venue's server
([One door, whatever recognises the room](#one-door-whatever-recognises-the-room)).
Nothing about the door is stored per service. For the second way the room carries two
things on the venue's server (`GET /maps`, field `vps`; api-v2 section 11), which the
phone also keeps a copy of:

- its **place** at the service (the location id);
- the **bridge**: how the service's map lies in the room's frame.

**How the provider works** (`src/localization/ReactVisionVpsProvider.ts`):

1. The library's `<ViroVPS>` (`src/ar/VpsLayer.tsx`) downloads the location's map,
   matches the camera against it and reports the camera's pose in the frame of that map.
2. From that pose and the AR engine's camera pose at the same moment the provider works
   out where the service's map lies in the running AR session (`core/vpsAlignment.ts`:
   four readings in a row have to agree within 4 cm and 2 degrees at the door; they are
   averaged; a reading that would tilt the map is thrown away).
3. Through the bridge that becomes where the ROOM lies in the session
   (`core/ways.ts`: service's map in the session x room in the service's map), and that
   is all the provider says. The door layer puts the room's door there, by the same
   rules as for the venue's server: a correction is applied only when it differs by more
   than 15 cm or 6 degrees, and waits while the user is inside the space. The door is
   not put inside the library's `<ViroVPSAnchor>`, which moves its content every frame.
4. **Place the door**, **Move the door** and **Remove the door** are the same as with
   the venue's server: the one record changes, for both ways at once.

**Linking a room** (`src/ui/BridgeScreen.tsx`, `src/room/bridgeMeasure.ts`; not in the
spec): the staff member walks through the room once.

1. The venue's server looks at the room **three times, from places at least a metre
   apart** ("Go to another part of the room" between the looks; the next look starts by
   itself once the phone is somewhere new). Its alignment of the session is shared by all
   samples that follow, so an error in it goes into the bridge unseen.
2. Then ReactVision is asked for the place in the same AR session, and up to 8 samples of
   where the service's map lies are collected, at least 0.4 m and 1.5 s apart; **Finish**
   ends the walk from 4 samples on.
3. The samples go to `POST /maps/{id}/vps/bridge` with the id of the session, under
   which the server keeps its own alignment; it averages them, estimates the error and
   stores the bridge. "Linked", with the error in centimetres - and, as they come, **the
   server's own warnings** about that figure ("The server adds: ..."), on the sheet and
   on the Connection page.

The server's contract says a bridge is best measured in the AR session that recorded the
room, right after the build: there the session's frame is the room's frame, and the
shared error does not exist (in its simulator a bridge measured in a later session
through one clip was 11 cm off at the door against an estimate of 2.8 cm; in the
recording's session 1.1 cm). **This app cannot do that**: its AR view is closed while
the map is built, and a new view is a new AR session (the upload does not name the
session either). The three looks are what the contract asks for in "any other session".
Keeping the AR view open through the build would make the better way possible; it is
not built.

A room that is scanned again on the venue's server loses door and bridge (its frame is
new) and has to be linked again; the page then says "Not linked".

**Which way is taken** (`roomsStore.wayToRoom`, `core/ways.ts`): the one chosen on the
Connection page, or the other one when that cannot work - so that a visitor sees no
difference:

- ReactVision chosen, but the build has no keys, or the room has no place or no bridge
  for its current frame, or the server does not list the service among the ways the room
  can be recognised (`recognition` of `GET /maps`): the venue's server;
- the venue's server chosen, but known to be unreachable, and the room can be recognised
  through ReactVision: ReactVision, with the door from the copy of the record the phone
  kept the last time the server answered.

The choice is made when the door is opened; it does not change in the middle of a search.

The service has no "attempt 2 of 5", so the coach lines follow the time: "Try another
view" after 15 s, "Still looking" after 40 s, and after 90 s the search is given up like a
search through the server after its attempts.

**Checked without the service** (`npm run e2e:server`, real server 0.6.0, a made-up
service whose map lies in the room in a known way): the room gets a place, 8 samples as
the app would take them (with a centimetre and a third of a degree of noise) go to the
server with the id of the clip's session, the bridge it returns puts the door 2.0 cm from
the truth (its own estimate: 3.3 cm, 0.21 degrees, with the warning that the session's
alignment is part of the bridge and not of that figure), `GET /maps` then lists the room as recognisable both ways, and
the same door record placed through the bridge stands 1.7 cm and 0.3 degrees from where
it was placed through the server. The run also checks that the frame the answer of
`/localize` names is the frame of the door record: the door layer refuses to put a door of
one scan into the frame of another.

**What is assumed about the service and not verified:** that `renderPose` uses the AR
engine's camera convention (X right, Y up, -Z forward) and that the map's Y axis is the
vertical; that a build without keys makes the library's native module say so (this is
how the app decides "Not set up in this build"); that `provider: "reactvision"` does not
disturb the recording and the room mesh the scan uses; that the library's tracker and the
recording of a `/localize` clip can run in one AR session one after the other (linking a
room needs both); that the portal behaves when the door is driven this way; how long
finding a place takes; the error of a real bridge, which adds to the service's own.

**Not built:**

- sending a scan to ReactVision from the app and following the cloud's build. It needs an
  endpoint on the venue's server that hands out a short-lived upload token, which does
  not exist yet. Until then a room is scanned with the vendor's own tools and the
  location id it got is typed into the Connection page;
- changing the way in the middle of a search (e.g. after the cloud did not recognise the
  place within 90 s);
- "Also build in the cloud" and the "Server" / "Cloud" tags of the Rooms screen (the
  Rooms screen itself is a later step);
- the privacy lines for this method (5.2, right column).

### Developer options and the developer tools

Everything technical is off by default. **Seven taps on the version line of Settings**
switch the developer options on (and off again). They add:

- on the AR screen, one line of diagnostics (tracking, provider, match quality and
  inliers, search time, door size, confidence) and the button **Tools**;
- **Tools** opens the developer tools over the camera: what used to be the whole
  interface - AR / VR badge, server chip and its settings window, status banner, status
  panel, event log, the scan panel (**Scan room**, **Record**, **Upload**, **Plan**, mesh
  buttons), the measurement panel and the switches. [Using the developer tools](#using-the-developer-tools)
  and [The scenario, step by step](#the-scenario-step-by-step) describe them; the checks of
  assignment task 5 ([`docs/test-protocol.md`](docs/test-protocol.md)) are done there;
- in Settings: provider, **Door in front of the camera**, door frame, attach mode, room
  plan in AR, test room, the box and sphere of task 1 ("Test objects"), a diagnostics
  screen with the status and the log, and **Keep the AR view running**.

At start the room is always found through the server. The door that is simply put two
metres in front of the camera (the `manual` provider) is a developer tool, labelled "not
tied to the room": **Door in front of the camera** in the developer options opens it, and
the **Provider** switch of the tools changes to it. With developer options off, **Open
the door** always uses the server.

The AR view (and with it the AR session) is started when the AR screen opens and ended
when it closes, so every visit of the AR screen finds the room anew. If starting it
repeatedly proves unstable on a phone, **Keep the AR view running** keeps one session
alive behind the other screens.

A restart of the app now ends on Home, not in AR: for the restart checks of the test
protocol, tap **Open the door** at once; the record's "search time" starts when the AR
screen opens, its "app start to door" includes the time spent on Home.

### Where the spec is not followed yet

Kept as a list for the product side; nothing here was decided silently.

| Spec | What the app does | Why |
| --- | --- | --- |
| Bricolage Grotesque and Inter | system font, same sizes | bundling fonts postponed (the spec allows it) |
| Outline icon set, 1.8 stroke | icons drawn with plain views | no vector-drawing module in the build |
| Real safe-area insets | top from the status bar height, bottom a fixed 28 | needs a native module |
| Blur behind elements over the camera | translucent fill only | the spec allows it |
| Status panel and event log only on a Diagnostics screen | also the former overlay as **Tools** over the camera | the measurement mode needs crosshair, marks and log over the live view |
| Door fades in over 300 ms; door dimmed while tracking is lost | the door appears at once and is not dimmed | not tried inside ViroReact's portal |
| Rooms: what a tap on a row does | it makes that room the one the app works with and leads back | the spec names no action; the room is still named by the app when it asks the server (S6 is not used yet) |
| Rooms: texts the spec does not have | "Save" (rename), "A map is being built for this room. Try again when it is done.", "That did not work. Try again.", the screen-reader label "More about {name}" | the spec names the actions, not these lines |
| Rooms: "failed to be found three sessions in a row" | counted on this phone, per AR session | the server keeps no such count |
| A ring with the percentage | the number in a plain circle, and a bar | no vector-drawing module (the spec allows the bar) |
| Floor painted as a dot grid, corners as a dot with a ring | the floor's edge only; a white dot on a small square | kept to a few scene nodes |
| Room mesh as thin lines in the scan colour | the AR engine's own mesh lines, in its colour | the engine draws them; the colour is not ours to set |
| Scan and build texts | a few lines the spec does not have: "Saving the scan…", "The scan could not start", "Stopped" after **Cancel**, "Keep going" once the minute is over, "Floor" before it is found | moments the spec's tables do not cover |
| Home while a build is running | also shows a build that failed while the user was elsewhere, until it has been looked at | otherwise a failure would go unnoticed |
| "Send again" after a restart of the app | the scan and its room are remembered, but no screen offers it (a build that the server is still working on is taken up again by itself) | the spec has no place for it; accepted in section 13 of the spec |
| Inside the space: only "Door is behind you" and the info button | the close button stays as well | a way out that does not depend on Android's back button |
| AR screen, room without a saved door: "go to Place the door" (5.9) and a sheet "This room has no door yet" (7.3) | the sheet, whose button opens the placing screen | the two places of the spec differ; the sheet says why the screen changes |
| **Save door** is enabled once the room is found | for a door that is already saved it stays disabled until something was changed | saving an unchanged door through a new alignment would move it by that alignment's error |
| "The door wasn't saved": "The server did not answer…" | the same sheet when the server answered and refused | the spec has one failure sheet |
| **Put it here** moves the door to the aimed spot | when the phone is not aimed at the floor, the door goes two metres in front of the camera | the spec has no text for "aim at the floor" |
| Coach lines once the room is found | shown until a control is used, and hidden while the adjust panel is open | they would cover the door that is being placed |
| The door "as it will look to visitors" | the same, but it cannot be walked through while it is being placed | walking into a space that is still being moved |
| **Remove the door** | a failed removal says "The door could not be removed. Try again." | the spec has no text for it |
| Adjust panel: ⟲ ⟳ | one drawn turn icon and its mirror image; the other step buttons are the characters ← → ↑ ↓ − + | no icon set in the build |
| Visitor: "This phone can't show the door" has no button | the sheet can be closed, and the app goes on | the AR engine's answer has not been tried on a device |
| Staff PIN sheets | one title the spec does not have: "Enter the current PIN" (changing the PIN) | the spec names the step, not its words |
| A screen for a server that is still connecting | the coach says "Connecting…" | the spec has no text for this moment |
| "This phone can't show AR" blocks | shown once, then the user may go on | the AR engine's answer has not been tried on a device |
| Third privacy line (delete a room) | left out; the privacy page has the way to **Rooms** | the server moves a deleted room to its trash folder and erases nothing (spec, 13.3) |
| Settings > Language "opens a list" | the list holds the languages only; there is no entry "same as the phone" | once a language is chosen in the app it stays chosen; before that the phone's is used |
| Croatian | written by the assistant, not reviewed by a native speaker | no reviewer; see the notes in `src/i18n/hr.ts` |
| The chosen space "stored per room", the same on every phone | stored per room on the phone that chose it | the server has no place for it (S5) |
| Spaces: filter chips, a download button | neither is shown | one space is built in (the chips are for more than six), and nothing can be downloaded (S7) |
| Spaces sheet: **Put behind my door** | for the space that already stands behind the door the sheet shows the tag "Behind your door" in place of the button | there is nothing to put |
| Spaces sheet: "two sentences" | a text of this app for the atrium ("The arcaded courtyard of the old customs house of Dubrovnik. Walk in under the arches and look up at the open sky.") | the spec gives no text |
| Credits page | its headings and lines are texts of this app ("The door", "Software", "Licence: …", "From …", what was changed in the model) | the spec names the page, not its words |
| Photo preview with **Share** | the preview has no Share; it says "Saved to your photos" / "Photo taken" instead, and "The photo could not be taken" when the engine refuses (texts of this app) | handing a picture file to another app needs a native module the build does not have (React Native's own share sheet takes text only on Android); the spec lists it among the additions that need a native rebuild |
| Connection page: two options, the server row, "Recognise in the cloud" | also a field "ReactVision location ID of {room}" with **Save**, the line about the room's link and **Link to the room** / **Link again**, and the "Server" row stays in Settings as well | sending a scan to ReactVision from the app is not built, so the id has to be typed in somewhere; the room has to be linked to that place once |
| (not in the spec) linking a room to its place in the cloud | an AR screen of its own: "Go to another part of the room" (three looks by the server), "Walk slowly around the room", "{n} of 8 views taken", **Finish**, "Linked" with the server's warnings / "Not linked" with three reasons | one door for both ways needs the bridge between the two maps (api-v2, section 11) |
| ReactVision: "Can't reach the cloud service" / "Check that this phone is online." | also used when the service answered and refused (plan, spend limit, no map); a second screen "This room is not set up for the cloud" when the build has no keys, or the room has no location id or is not linked (in practice rare: such a room is found through the server instead); a visitor gets "The door isn't ready" with the staff line "Cloud service not reachable or not set up" | the spec has one text for the cloud's problems |
| ReactVision: cloud scan, "Also build in the cloud", tags in Rooms, privacy lines of the cloud column | not built | they need a token endpoint on the server, the Rooms screen and the owner's account |

## After the first pass on a phone

On 2026-11-21 the owner went through the whole path on the phone with build `5e28ed7`
(scan, map, door, restart, visitor). The analysis is in the shared notes of the project
(`debrief_first_pass.md`); this is what the app changed for it. **None of it has been seen
on a phone yet.**

| What happened | What the app does now | Where |
| --- | --- | --- |
| Through the doorway only the wood was seen, no world; the space appeared after walking in | The portal's only child is one flat window that samples the transparent texels of `door_frame.png` - the arrangement seen working on build `9cb8a8b`. The wood of the casing is drawn beside the portal as plain objects. Seen from inside the space, the wood shows only through the opening. If the world is still missing: developer option **Door frame** → `simple` | `src/ar/DoorPortal.tsx`, `src/ar/CasingWood.tsx`, `scripts/generate-assets.mjs` |
| A visitor looked around with the camera while the server was not reached; every launch searched the network for 17 s although the address was saved | Visitor mode checks the server **before the camera opens**: the saved address first (the network is searched only when it does not answer), then the quality of the connection, then that the server has a room with a saved door. A failed check is a panel with **Try again**; no look for the room is made. The 17 s were a search started before the saved address had been read | `src/server/visitorCheck.ts`, `src/server/core/linkQuality.ts`, `src/ui/VisitorScreen.tsx` |
| A look was with the busy server for 39 s; after 33 s the app said the server was gone and left the screen | While a clip is with the server no health check is made, so none can be missed; the request itself is given 60 s. After 6 s of waiting the screen says "The server is busy. Waiting for its answer…" | `ServerConnection.hold`, `src/room/roomServer.ts`, `SelfHostedServerProvider.ts` |
| Refusals: the phone looked at the floor, a table top, another room; the screen said "hold still"; after a refusal the app waited 1.5-10 s and stopped after five | One advice at every attempt: "Lift the phone and look around the room slowly" / "Furniture and walls, not the floor." with what the look is doing (looking, sending, the server is checking). While no door is on screen the next look follows at once and the search does not stop; after five answered refusals the session counts against the room. A check of a door that already stands keeps its limits | `SelfHostedServerProvider.ts`, `src/ui/core/arView.ts` |
| A look took about 9 s at best | The clip is 1.2 s instead of 2.5 s | `src/room/roomServer.ts` |
| After walking through the door the place of the door was "checked" from a corridor the map does not know: two refusals, 45 s, the door called doubtful | No check from inside the space or within 6 s after the way out; the door is kept, and its place is checked once, 6 s after the user is back in the room | `SelfHostedServerProvider.ts` |
| Second pass (2026-11-22): ARCore corrected its map while the owner stood inside the atrium, without announcing a loss of tracking; the door stayed on the old numbers and stood off after the way out | The place of the door is checked **after every way out** (6 s later), not only after an announced loss: up to two looks (`MAX_ATTEMPTS.exit`); only a `good` answer moves the door, and only when it is off by more than 15 cm or 6° (`SAME_POSE_*`, the rule of every check); a weak answer or a refusal leaves the door and shows nothing. After an announced loss it is a `recovery` as before. Log: `back in the room - checking the doorway position (after every way out of the space)`, then `back in the room, look n: the doorway was N cm off (...) - moved` / `in place (...) - not moved` / `no good answer ... - not moved` | `src/localization/core/relocalization.ts`, `SelfHostedServerProvider.ts` |
| Fourth video (2026-11-23): after ARCore had dropped all its planes twice inside the atrium, the check after the way out got a good answer (639 inliers) that asked for 1.52 m and 53°, and the door, which had been right, was moved across the room. The server was right about the images; the ARCore numbers attached to the clip were not (3.7 m of camera travel against 0.6-0.75 m by the map) | **Jump limit**: a door that is trusted (no announced loss of tracking since) is not moved by an unrequested look further than **0.5 m or 15°** (`MAX_JUMP_M`, `MAX_JUMP_DEG`), even on a good answer; the screen shows "The door may have moved · Find again". Corrections between 15 cm / 6° and 0.5 m / 15° are made as before; after an announced loss the old rule stands. **Find the door again**: a button on the visitor's camera screen (outside the space) takes the AR view down for 0.7 s and puts it up again - a new ARCore session and a new search, as closing and opening the screen did (7.6 s to the right door). ARCore dropping all its planes is logged as `ARCore rebuilt its map`. The clip's poses are written by ViroReact's recorder from ARCore's camera pose frame by frame; our code passes them on untouched, and the door is a plain node in the same ARCore world - no fault of ours was found | `src/localization/core/relocalization.ts`, `src/door/DoorPlacer.ts`, `src/state/appStore.ts`, `App.tsx`, `src/ui/VisitorScreen.tsx`, `src/ar/PortalARScene.tsx` |
| The upload counted up to 175 % | The size of the files is the floor of the total; never above 100 % | `src/room/roomServer.ts` |
| The scan was made turning on the spot (1.0 x 1.0 m in 100 s), the phone held level; the guidance counted metres walked, which turning also gives | The guidance counts the **area walked over** (smallest rectangle round the phone's positions) and **time at three tilts** (down, level, up). Coach: walk in a circle along the walls; after 20 s on one spot "turning on the spot is not enough"; one round level, corners floor to ceiling, one round tilted down; "don't stand in one place" after 8 s standing. Finishing a scan made from one spot asks first ("Send anyway" / "Keep scanning") | `src/ui/core/scanFlow.ts`, `src/ui/ScanScreen.tsx` |
| Nothing told how good the scan was | "The map is ready" shows the server's verdict on the scan (server 0.8.0, `result.scan_quality`): good / limited / rescan in the app's words, up to two issues worded by the app per code (`one_spot`, `never_looked_down`, `never_looked_up`, `repeated_views`, `not_all_around`, `walls_poorly_seen`, `frames_lost`; an unknown code shows the server's English), and **Scan again** next to "See the room" for `rescan`. The log gets the verdict, codes, footprint, highest pitch and share of repeated views. An older server says nothing and nothing is shown | `src/server/core/roomPlan.ts`, `src/ui/core/buildView.ts`, `src/ui/BuildScreen.tsx` |
| Server 0.8.0 refuses a door from weak frames only | `alignment.status: failed`, `reason_code: weak_only` is an ordinary refusal (next look at once); the reason and `load.stopped_early` are in the `localize:` log line | `src/server/core/roomPlan.ts`, `src/room/roomServer.ts` |
| The world mesh was saved as `world_mesh.bin (0 kB)` and then not found | The copy of the engine's file was not awaited (`File.copy` returns a promise in expo-file-system 58); the source was deleted before it was copied. All writes are awaited now; the mesh goes to the server as `world_mesh.ply` again. A missing mesh is a quiet `not saved: ...` line and does not stop the upload | `src/room/scanController.ts` |

**The connection check, in numbers** (`src/server/core/linkQuality.ts`, our choice): five
health requests 250 ms apart, each given 1.5 s. The connection is **bad** when two or more
stay unanswered or when the median answer takes longer than 500 ms (a server on the same
Wi-Fi answers in 5-40 ms). The log has the line `visitor check: link good|BAD: median N ms,
k of 5 unanswered`.

**The scan, in numbers** (`SCAN` in `src/ui/core/scanFlow.ts`, our choice, from the
first pass: the bad scan covered 1.0 x 1.0 m and was held at -15°): the walked area must be
at least **1.5 m** long and **0.5 m** wide; below that the scan counts as made from one spot.
Tilt bands: down from -25° to -60° (steeper is the floor under the feet and does not
count), up from +20°, level in between; needed: level 15 s, down 8 s, up 3 s. Standing
within 0.6 m for 8 s (15 s while showing the door) brings the "don't stand" advice. The
time limits are unchanged (60 s minimum, finish offered at 150 s, automatic finish at 180 s;
the automatic finish sends a one-spot scan without asking and logs it). The log line at
the end: `scan: finishing after N s, area A x B m, tilt a..b deg (down/level/up seconds), ...`.

## Using the developer tools

This section and the next describe the developer tools (see above for how to open them).

What is on the screen:

- Top left: mode badge - green **AR** or purple **VR**. It is driven only by the
  portal's `onPortalEnter` / `onPortalExit` events.
- Below it: the **server chip**, always visible - green "Server: connected · name · N ms",
  grey or red otherwise. Tap it to open the server settings
  ([Connect to the localization server](#connect-to-the-localization-server)).
- Below that, only when something needs attention: the **status banner**. It says in
  words what the app is doing about the doorway ("Looking for the room - attempt 2 of 5:
  hold the phone still..."), turns red when you have to act ("Check the doorway",
  "Cannot place the doorway") and then carries the button **Re-localize** (or
  **Re-place door** with the manual provider). It disappears once the doorway is placed
  and trusted.
- *Hide tools*: closes the developer tools and returns to the product's AR screen.
- Status panel: tracking state and reason, camera position and forward vector in
  AR-world coordinates, detected floor height, provider status, door pose, attach mode,
  and a line `search` about recognising the room: the attempt that is running ("attempt 2
  of 5") and how the latest search ended - event, seconds of the search, attempts, seconds
  from app start to the door, the server's quality and number of inliers. The same
  figures are in the log (`server: localize: good, 741 inliers, alignment ok` per answer,
  `measure <test> #n placed: ...` per search).
- Event log: tracking changes, provider status, door poses, portal enter/exit, everything
  the scan and the server do. The same lines go to Android's log (tag `ReactNativeJS`,
  prefix `[portal]`) and, when the server supports it, to the server's monitoring panel
  ([Device log](#device-log-for-the-servers-monitoring-panel)).

Buttons of the debug overlay:

| Button | What it does |
| --- | --- |
| **Scan room**, **Record**, **Upload as "room"**, **Plan**, **Mesh lines**, **Save mesh**, **Reset mesh** | the room scan, see [the scenario](#the-scenario-step-by-step) |
| **Re-place door** / **Re-localize** | manual provider: puts the doorway 2 m in front of the camera again. Self-hosted provider: looks for the room again now |
| **Attach: direct / parent** | how the portal is attached to the scene graph ([How the portal works](#how-the-portal-works)); both must look the same |
| **Provider: manual / self-hosted** | who decides where the doorway stands. `self-hosted` (the default): where staff saved the door in the scanned room. `manual`: in front of the camera, no server needed, not tied to the room. The two stubs (`reactvision-vps`, `arcore-cloud-anchor`) exist in the code but are not offered |
| **World: sponza / test-room** | what is behind the door. `sponza` (the default) is the atrium; `test-room` is the small violet room of stage 1, kept to tell a portal problem from a problem with the big model |
| **Frame: casing / simple** | the door frame, see [How the portal works](#how-the-portal-works) |
| **Measuring** / **Measuring: on** | measurement mode: the scan panel is replaced by the measurement panel, a crosshair marks the middle of the screen. See [Measuring where the door stands](#measuring-where-the-door-stands) |
| **Hide log**, **Clear log** | the event log |

The shortest way to see the virtual world, without a server: enter staff mode (the lock
on the welcome panel, then a PIN), switch the developer options on (Settings, seven taps
on the version line) and tap **Door in front of the camera** there. Move the phone slowly
until the door casing appears 2 m ahead, standing on the floor and facing you. Look
through the door at the atrium, walk through it: the hall surrounds you. Turn around and
walk back through the door. If the door stands badly, look at a free piece of floor and
press **Tools**, then **Re-place door**.

## The scenario, step by step

Connection, scanning, portal, with the developer tools. Steps 1 to 4 have been seen on a
phone with the build before the product screens (step 4 only with a recording too short
to build a map from); steps 5 to 7 have not. With the product screens the connection is
made on **Find the server**, a room is scanned with the guided scan (Home, **Scan this
room**) and the door is opened from Home; the scan panel described here is still in the
tools and sends its recording as the room `room`.

1. **Start the server** on a computer in the same network (project
   [`localization-server`](https://github.com/BRANDAY/arportal-localization-server), its README: `uv run locserver-serve`). It prints
   its address.
2. **Connect.** Start the app; tap the server chip, then **Find automatically** (takes up
   to 52 s) or type the address and **Test connection**. The chip turns green. The
   address is remembered. Details and troubleshooting:
   [Connect to the localization server](#connect-to-the-localization-server).
3. **Scan.** Open the real door of the room. Press **Scan room**: the planes the phone
   finds are highlighted (walls cyan, floor green, ceiling violet, other surfaces
   yellow, a red cube with a post where two walls meet) and the panel counts the
   triangles of the room mesh. Press **Record** and walk slowly through the room for one
   to two minutes, looking at the walls: every wall, the floor edges, the corners, and
   the whole door from at least two places 1.5 m or more away. Turning on the spot is
   not enough - the server needs sideways movement. Press **Stop rec**.
4. **Upload.** Press **Upload as "room"**. The panel shows the upload in percent, then
   the build on the server: overall percent, "step 3/7 matching", the remaining time. A
   build takes minutes. **Cancel** stops it. If the server cannot build a map it says why
   and the app shows that text ("The room could not be reconstructed... Record again,
   slower, walking along the walls").
5. **Plan, then the door.** When the build has succeeded the server's room plan is
   drawn in orange (walls, corner posts, floor outline; door openings in white) and the
   provider switches to `self-hosted`. **Plan: on/off** hides the plan. No door stands
   yet: close the tools and choose **Place the door** in the sheet "This room has no door
   yet", put the door where it should stand and save it
   ([Placing the door](#placing-the-door)). Open the door from Home and walk through.
6. **Next session.** Start the app in the same room, connect, choose **Provider:
   self-hosted**. Once tracking is NORMAL the app records a 1.2 s clip, sends it to the
   server and places plan and door from the answer; the banner shows the attempts. Hold
   the phone still, pointed at a part of the room with detail (not a bare wall).
7. **If it goes wrong.** "Room not recognised": look at another part of the room and
   press **Re-localize**. "No door has been saved": close the tools; the sheet "This room
   has no door yet" leads to **Place the door**. The app never substitutes a position of
   its own. Tracking lost: see
   [Keeping the doorway in place](#keeping-the-doorway-in-place).

The map is always called `room`, and a new upload replaces it.

## Connect to the localization server

The localization server is a separate project ([`localization-server`](https://github.com/BRANDAY/arportal-localization-server),
Python; a git submodule of this repository). It runs
on a computer; the phone talks to it over the local network with plain HTTP. **No address
is built into the app** — it is found automatically or typed in, on whatever network you
are on. This section is about establishing and watching the connection; what travels
over it is in [Scan a room](#scan-a-room-and-put-the-door-into-the-real-doorway).

### Steps

1. Start the server on the computer (see the server project's README; default port
   **8077**). To try the app's connection screen without the real server, this repository
   has a stand-in that answers only the health check:

   ```powershell
   node scripts/mock-server.mjs
   ```

   It prints the addresses of the computer.
2. Put the phone on the **same Wi-Fi network** as the computer (the computer may be on a
   cable of the same router). Mobile data can stay switched on: the app sends its
   requests over Wi-Fi even when the phone prefers mobile data.
3. Allow the port through the computer's firewall, once (administrator PowerShell). This
   is a system setting, so no script here does it:

   ```powershell
   New-NetFirewallRule -DisplayName "locserver 8077" -Direction Inbound -Protocol TCP -LocalPort 8077 -Action Allow -Profile Private
   ```

   The rule applies while Windows treats the network as *Private*. If the network is
   marked *Public* (check with `Get-NetConnectionProfile`), either switch it to Private
   in Settings → Network & internet → the connection's properties, or — only on a network
   you trust — create the rule with `-Profile Private,Public`. Remove the rule with
   `Remove-NetFirewallRule -DisplayName "locserver 8077"`.
4. In the app tap the server chip, then **Find automatically**. The app takes the phone's
   own Wi-Fi address and asks the other 253 addresses of that /24 network for
   `GET /health` on the port - first the address ending in `.1`, then nearest addresses
   first -, a new one every 0.2 s. (`.1` first is for a network that the server's own
   computer shares, for example Windows' "Mobile hotspot": the computer is then
   `192.168.137.1` and the phone gets an address far from it. Not tried on such a
   network; the computer's firewall must let port 8077 in on that network too.) It accepts
   only an answer that identifies itself as this project's server, connects to the first
   one that does and stops. This takes **up to about a minute** (52 s for the whole
   network) and is slow on purpose — see [Why the search is slow](#why-the-search-is-slow).
5. Or type the computer's address into the field (`host` or `host:port`, `http://`
   optional; the port defaults to 8077) and press **Test connection**. On Windows the
   address is the "IPv4 Address" line of `ipconfig` for the Wi-Fi/Ethernet adapter.

The last address that connected is saved on the phone and tried first at the next start.
**Forget** removes it. A port typed into the field is also used by the automatic search.

### What the chip says

| Chip | Meaning |
| --- | --- |
| grey **Server: not set up** | no address known yet |
| grey **Server: searching n/253** | the automatic search is running |
| grey **Server: connecting...** | an address is set, waiting for the first answer |
| green **Server: connected · name · N ms** | the server answers the health check and is compatible; `N` is the round-trip time of the last check |
| red **Server: unreachable** | no usable answer: server not running, wrong address, different network, firewall — or something else answers at that address. The settings panel shows the reason |
| red **Server: incompatible** | it is this project's server, but with an API version the app does not support (the app supports API version 1) |

While the app is in the foreground it re-checks the server every 3 seconds (paused in the
background). One missed check is tolerated; after two in a row the chip turns red, and
it turns green again by itself when the server is back. Every change is written to the
event log.

The bottom of the settings panel shows the phone's own Wi-Fi address, refreshed every two
seconds, and says so when the phone currently prefers mobile data.

### Why the search is slow

The first version of the search asked 24 addresses at a time (about 48 a second) and was
done in 6 seconds — and on the test network it never found the server and broke the
phone's Wi-Fi. What was measured there (Xiaomi 14 Ultra on the Wi-Fi of a home router,
computer on a cable of the same router):

- A connection attempt to an address nobody uses makes the phone send 3 ARP broadcasts
  ("who has this address?"). A /24 is almost entirely such addresses, so the fast search
  produced about 145 broadcasts a second.
- Counting the broadcasts that arrive at the computer while the phone tries unused
  addresses at a fixed pace: at 5 addresses a second all of them arrived (183 counted, 180
  expected), at 8 a second also (183 of 177), at 15 a second only the first 57 of 180, at
  30 and 48 a second practically none.
- Once that happens, **all** broadcasts of the phone are dropped for a minute or two, even
  slow ones. The phone can then not look up any address it does not already know: the
  server's computer gives "no route to host" although it is running, while a computer
  whose hardware address the phone already knows stays reachable. During one search the
  phone could not look up the router itself any more, and Android reported the Wi-Fi as
  lost and reconnected (`IpReachabilityMonitor: FAILURE: LOST_PROVISIONING` in logcat).
  Afterwards the phone hopped between the router's two Wi-Fi names and for a few minutes
  kept mobile data as its main connection.
- With the network left alone, a single request from the phone to the computer worked at
  once, also when the phone did not yet know the computer's hardware address.

Whether the router or the phone's own Wi-Fi part does the dropping was not established;
either way it is a flood protection that the fast search triggered. The search now starts
one request every 0.2 s (5 addresses a second, at most about 15 broadcasts a second), with
a 1.5 s timeout per address. Other routers may have other limits: if the search finds
nothing, type the address in — that is a single request and always safe.

A search that needs one packet instead of hundreds would need the server's help (answering
a broadcast or announcing itself with mDNS); the server does not offer that today.

### Troubleshooting

- **"The phone is not connected to Wi-Fi"** — no Wi-Fi network is connected at all. The
  server is on a local network, which mobile data cannot reach. (Wi-Fi connected but
  mobile data preferred by the phone is a different case and works, see below.)
- **The phone shows the Wi-Fi sign with an exclamation mark, or uses mobile data although
  Wi-Fi is connected** — Android does this when the Wi-Fi has no internet access (a router
  without an uplink, as at a demo) or when it judges the Wi-Fi to be poor. An app's
  connections then normally leave over mobile data and never reach a local address. This
  app asks Android for the Wi-Fi network and binds its connections to it, so the server
  stays reachable; the settings panel then says "The phone currently prefers mobile
  data; the app talks to the server over Wi-Fi anyway". If it says instead that the app
  could not switch to Wi-Fi, turn mobile data off.
- **Search finds nothing, typed address is unreachable**
  - Is the server running, and listening on all interfaces (not only `localhost`)? On the
    computer itself `curl.exe http://localhost:8077/health` must answer.
  - Firewall rule from step 3 present, and does the network profile match it?
  - Same network? Compare the first three numbers of the phone's address (Settings →
    Wi-Fi → network details) with the computer's.
- **The search finds nothing although the server runs and the firewall is open** — type
  the computer's address in and press **Test connection**. A single request works on
  networks where a search does not: some routers (or phones) drop a device's broadcasts
  when it sends many of them, and a search has to send many, see
  [Why the search is slow](#why-the-search-is-slow). If a search has just failed, wait a
  minute or two before trying the typed address, or switch the phone's Wi-Fi off and on.
- **Guest, university, hotel and some office networks** isolate clients from each other
  ("client isolation" / "AP isolation"): devices can reach the internet but not one
  another, and nothing in the app can change that. Use a network without isolation — a
  home router, or the phone's own hotspot.
- **Phone hotspot**: turn on the hotspot, connect the computer to it, start the server.
  The automatic search usually cannot work in this setup (the phone is not a Wi-Fi client
  then), so type the computer's address by hand — `ipconfig` on the computer shows it.
- **Network larger than /24** (addresses differing in more than the last number): the
  search only covers the phone's own /24. Type the address in.
- **VPN on the phone or the computer** often blocks local traffic: switch it off.
- **"Incompatible"**: app and server are from different versions of the project; update
  both to the same commit.

### How it is built

- `src/server/core/` is plain TypeScript without React Native imports and is unit-tested
  in Node (`npm test`; 212 tests in all with those of `src/room/`, `src/door/core/`, `src/spaces/core/`, `src/localization/core/`, `src/measure/core/`, `src/ui/core/` and `src/i18n/`, including a local mock of the server contract):
  `address.ts` (parsing what the user types), `subnet.ts` (which addresses to probe),
  `health.ts` (validation of the `/health` answer), `client.ts` (**the only module that
  makes HTTP requests** — stage 2b adds `POST /localize` there), `discovery.ts` (paced scan
  with progress, cancel and early stop), `phoneNetwork.ts` (what the settings panel says
  about the phone's network), `connectionMachine.ts` (the state machine).
- `src/server/ServerConnection.ts` adds the impure parts: heartbeat timer, foreground /
  background, the phone's network state (`src/server/wifiRoute.ts`), the saved address
  (`src/server/storage.ts`, a JSON file in the app's private storage via
  `expo-file-system`).
- `modules/wifi-route/` is a small native Android module (Kotlin, Expo Modules API),
  picked up by Expo autolinking from the `modules/` folder — nothing in the generated
  `android/` folder is edited by hand. `start()` calls `ConnectivityManager.requestNetwork`
  for the Wi-Fi transport (without requiring internet access) and binds the whole process
  to that network with `bindProcessToNetwork` while it exists; `getState()` returns
  whether a Wi-Fi network is connected, the phone's IPv4 address on it, whether the
  process is bound, and what the phone's default network is. It adds the normal
  (dialog-free) permission `CHANGE_NETWORK_STATE`. Process-wide binding fits because the
  app talks to nothing but the local server; a provider that needs the internet would
  have to bind per connection instead.
- `GET /health` contract the app relies on: JSON with `service` =
  `"arportal-localization-server"`, integer `api_version`, `server_version`,
  `server_name`, `status` = `"ok"`. `device`, `device_name` and `maps` are shown when
  present and ignored when not.
- Plain HTTP is allowed in all build types by `usesCleartextTraffic` set through the
  `expo-build-properties` config plugin in `app.json` (Android blocks cleartext traffic
  by default). There is no encryption or authentication between app and server: use it on
  networks you trust.
- The `self-hosted` localization provider takes the server's base URL from this
  connection and currently reports "connected, localisation not implemented yet
  (stage 2b)".

## Scan a room and put the door into the real doorway

The steps are in [The scenario, step by step](#the-scenario-step-by-step); this section
says how it works.

**On the phone.** The scan mode asks the AR engine for horizontal and vertical planes and
for its fused room mesh. `src/room/roomGeometry.ts` turns the plane anchors into a room
model (walls, floor, ceiling, corners; pure, unit-tested) and `src/ar/RoomScanLayer.tsx`
draws it. The planes belong to the AR session, which keeps them while the phone looks
elsewhere, so the picture builds up as you turn. **Mesh lines** draws the mesh as a
wireframe, **Reset mesh** forgets it, **Save mesh** writes planes and mesh to a capture
folder without recording.

**A capture** is a folder in the app's private storage: the camera video, one camera
pose per frame, the planes, and the room mesh (the engine's own file and a PLY copy made
by the app). Its exact content, checked against captures from a phone, is specified in
[`docs/capture-format.md`](docs/capture-format.md). `src/room/scanController.ts` drives
the engine's recorder and mesh.

**To the server.** `src/room/roomServer.ts` sends video, poses and the PLY mesh to
`POST /maps/room/recording`, follows the build job every 1.5 s and fetches the room plan
and the doorway (`GET /maps/room/room`, `/portal`). The contract is
[`localization-server/docs/api-v2.md`](https://github.com/BRANDAY/arportal-localization-server/blob/main/docs/api-v2.md). All HTTP is in `src/server/core/client.ts`, the
parsing of the answers in `src/server/core/roomPlan.ts` (both unit-tested).
`src/ar/ServerRoomLayer.tsx` draws the server's plan.

**The door.** A map built from a recording has the coordinate frame of the AR session
that recorded it, so in the developer tools the plan can be drawn right after the build.
In any later session the frames differ; then a short clip with its camera poses goes to
`POST /localize`, and the answer carries the plan, the door staff saved and the doorway
the server suggests, all transformed into the current session.

A door is shown only where staff saved one ([Placing the door](#placing-the-door)). If
the room has **no saved door**, nothing is placed and the status says so; a doorway the
server found by itself is only offered on the placing screen. The app never substitutes
a position of its own.

### One door, whatever recognises the room

The owner's decision of 2026-11-21: one approach to the door for every way of recognising
the room, so that switching between the venue's server and ReactVision Advanced VPS is
seamless ([`localization-server/docs/api-v2.md`](https://github.com/BRANDAY/arportal-localization-server/blob/main/docs/api-v2.md), section 5).

- **One door record per room**: its pose in the room's frame, width, height. It is kept
  by the venue's server and does not depend on how a phone finds the room.
- **A way of recognising the room answers one question**: where is the room's frame in
  this AR session (`RoomFix` in `src/localization/types.ts`: a 4x4 transform, whether
  the way calls its answer weak, the name of the frame). It knows nothing about the door.
  The `self-hosted` provider reads the transform from `/localize`
  (`alignment.T_arworld_from_map`); for a room scanned in this very session it is the
  identity.
- **One place puts the door**: `src/door/DoorPlacer.ts`. It reads the door record
  (`GET /maps/{id}/portal`; the copy read last when the server does not answer), does
  the sum

  ```
  door in the session = room in the session x door in the room
  ```

  (`src/door/core/placement.ts`, `roomFrame.ts`: pure, unit-tested) and applies the
  rules of [Keeping the doorway in place](#keeping-the-doorway-in-place): place, keep,
  move, ignore. It also tells the placing screen that the room is found.
- **Saving is the same sum backwards**: the door placed in the session goes into the
  room's frame through the transform the room was recognised with, and becomes the
  record. Nothing in the placing screen depends on the way.

The server still multiplies the door out itself (`alignment.portal`); the app no longer
reads it. `npm run e2e:server` compares the two sums on a real server.

One thing changed with this for the better: whether two answers mean "the same door" used
to compare the middle Euler angle of the two poses, which the server keeps within 90
degrees (a heading of 110 arrives as `[180, 70, 180]`); it now compares headings.

### Keeping the doorway in place

The rules are in `src/localization/core/relocalization.ts` (pure, unit-tested) and are
applied by the door layer (`src/door/DoorPlacer.ts`) to the answers of whatever way
recognises the room; the search itself (attempts, pauses, tracking loss) is the
provider's. **None of this has been tried on a device.**

- **Tracking loss.** Tracking that is away for less than 1.5 s is a hiccup and changes
  nothing (switching the scan mode causes one of about half a second). Longer than that
  is an interruption: the door **stays where it was** but is no longer trusted, the
  banner says "tracking lost - the doorway stays where it was, but it may be off", and
  as soon as tracking is back the room is looked for again. The server-side session id
  changes then, because the AR world frame may have changed.
- **Looking for the room** happens in episodes: at the start, after an interruption,
  when **Re-localize** is pressed, and to confirm a weak answer. An episode makes a
  limited number of attempts (5, or 3 on request, 2 to confirm) with growing pauses
  (0, 1.5, 3, 6, 10 s) and then stops and says what to do.
- **What an answer does to the door.** Nothing shown yet: the door is placed. The answer
  agrees with the door shown (within 15 cm and 6 degrees): the door is left alone and
  counts as confirmed. A good answer elsewhere: the door is moved, and the log says by
  how many metres and degrees. A weak answer elsewhere: ignored if the door is trusted,
  accepted if it is not (after an interruption) and then checked by another look. The
  door never moves or disappears without a log line and a status.
- **While you are inside** the virtual world an automatic correction waits until you are
  back on the AR side: moving the portal around somebody behind it would throw them out.
- With the **manual** provider there is nothing to check a pose against: after an
  interruption the door is kept and the status says "press Re-place door if it has moved".

### Device log for the server's monitoring panel

A server that announces the capability `device_log` gets the app's event log and its
current state (`api-v2.md`, section 9), so that somebody at the PC can follow what the
phone is doing. Every request carries `X-Device-Id` (made once per installation and kept
in the app's private storage), `X-Device-Name` (manufacturer and model), `X-Session-Id`
(one per app run) and `X-App-Version`. Events are sent in batches - when 20 are waiting,
or every 2 s, at once for an error - and an empty batch every 5 s keeps the state current.
The state names the step of the scenario: `connecting`, `connected`, `scanning`,
`uploading`, `building`, `ready`, `localizing`, `portal_placed`, `inside`, `error`.
Nothing is sent per frame; one timer per second decides whether a request is due, and a
failed request only makes the events wait (at most 500 are kept). Code:
`src/server/core/deviceLog.ts` (pure, unit-tested), `src/server/deviceLogger.ts`.
Checked against the server on the PC; **not yet run from a phone**.

### End-to-end check without a phone

```powershell
npm run e2e:server -- http://127.0.0.1:8077 <folder with video.mp4 and session.jsonl> [map id] [--localize-only] [--door]
```

runs the app's own client code and decision rules against a real server from the PC
(`src/server/core/server.e2e.ts`): health, device log, upload, following the build, room
plan, door, a localisation with the recording used as the clip, and then what a staff
member and a visitor do with the door: a door placed in the clip's AR session is saved in
the room's frame, a second localisation in that session has to bring it back, and the
door is removed again. The door is worked out the way the app's door layer does it (room
transform of the answer x door record), and compared with the door the server multiplies
out itself. The
map id defaults to `app_e2e` and is replaced on the server. With `--localize-only`
nothing is uploaded and an existing map is used; the door part **replaces and then
removes the map's door**, so with `--localize-only` it runs only when `--door` is given
too.

Result of the last runs on the development PC (GTX 1050 Ti), 2026-11-21, with the server
project's test recording of 30 frames from the public TUM room sequence (not a phone
recording). The upload and the build were run against server 0.4.0; everything from the
localisation on was run again against server 0.5.0 after the door layer was introduced
(`run4`, `run5`). Logs: `E:\VR-FESB\device-tests\2026-11-21\e2e\`.

| Step | Result |
| --- | --- |
| Health, capabilities (`staff_door`, `door_size`, `rooms_admin` among them) | ok |
| Device log: batch accepted, a repeated batch counted as duplicates | ok |
| Upload accepted, build followed to its end | ok, 293 s |
| Room plan and door of the new map parsed | 2 walls, 1 corner, 1 door opening; no door (`source: none`), and no suggestion: the server did not consider the opening sure enough |
| Localisation with the recording as the clip | answered in 2.1 s, "good", 740 inliers, with the room transform (`alignment.T_arworld_from_map`); the app's decision: **no saved door, nothing placed** |
| A door placed in the clip's session (0.85 × 2.05 m, turned by 35 degrees), saved in the room's frame | accepted (`alignment_used: map`); the server shows it as `manual`, confirmed, with its size; `GET /maps` lists the room as one with a door for visitors |
| A second localisation in that session, as a visitor: the app's own sum, room transform x door record | the door stands **0.0 cm and 0.0 degrees** from where it was placed, with its size; the app's decision: **place** |
| The app's own sum against the door the server multiplied out for the same answer | **0.0 mm, 0.00 degrees** apart, on both rooms |
| The door removed | ok; the room has no door for visitors again |
| The second way with a made-up service (place, bridge from 8 samples, the same door through the bridge, place removed) | the bridge puts the door **2.0 cm** from the truth (the server's estimate: 3.3 cm, with its warning about the session's alignment); the door through the second way stands **1.7 cm and 0.3 degrees** from where it was placed; `GET /maps` lists the room as recognisable through `self-hosted, reactvision` (server 0.6.0, `run7`) |
| The room's name: renamed, listed under the new name, named back (`PATCH /maps/{id}` with `label`) | all three pass (server 0.6.0, `run8`). Deleting a room is not tried: it would take the test's room away |
| The same clip against an existing map with a door set by hand (`--localize-only`, map `tum_room`) | answered in 2.5 s, "good", 1075 inliers; the app's decision: **place**; the door stands **2.3 cm** from where the recording's known transform puts it |

The zero in the second localisation is expected and says less than it seems: the door
was written into the room's frame and read back through the same room transform, so it
shows that the app's sum is right in both directions and agrees with the server's, not
how well a room is found again. The 2.3 cm of the last row is the figure for that, on a test
recording. A first run on 2026-11-20 was cut off when the server was restarted; the
app's client reported the job as failed with the server's reason.

What it cannot cover, because it needs React Native or a camera: how the phone encodes
the upload from file paths, the upload progress, the recorder, the 1.2 s clip, and
everything that is drawn.

### Measuring where the door stands

For the checks of assignment task 5 the app keeps a record of every localisation and can
compare the door with the real opening. **Written and unit-tested on the PC, never run on
a phone.** The procedure, the buttons and the record format are in
[`docs/test-protocol.md`](docs/test-protocol.md); the shot list of the demo video is in
[`docs/demo-video.md`](docs/demo-video.md).

- **Always, without pressing anything**: when a search for the doorway ends, a record is
  written - what happened (`placed`, `moved`, `confirmed`, `kept`, `not-found`,
  `no-doorway`), the door pose in the session's frame, the server's quality and inlier
  count, the time the search took, the time since app start and the number of attempts.
- **Measurement mode** (**Measuring** in the debug overlay): choose the test with
  **Test: ...** (`baseline`, `restart`, `angle`, `lighting`, `tracking-loss`,
  `walk-through`; the choice survives a restart of the app), mark the two bottom corners
  of the real door opening with **Mark left** and **Mark right** (crosshair on the corner
  where the jamb meets the floor; a thin post appears on each mark), press **Measure**.
  The panel and the log then say how far the door is from the real opening: position
  along and across the wall and in height, heading, width, and whether that is inside
  the tolerance of **10 cm and 5 degrees - our assumption, the assignment gives none**.
- Sessions have different coordinate frames, so the corners are marked again in every
  session; the comparison is always door against marks of the same session.
- Every record goes to the event log (and with it to the server's panel and its
  `work/device-logs/<device>.jsonl`), and to `measurements/<run id>.jsonl` in the app's
  documents directory.

```powershell
npm run measure:report -- <file or folder> [--trials]
```

prints a table per test from any of those files: trials, how often the door came back,
how many trials are inside the tolerance, median / mean / maximum of position, heading
and times. Code: `src/measure/` (`core/measurement.ts` is the arithmetic and the format,
with tests).

## Project structure

```
App.tsx                       camera permission gate, AR navigator + overlay
index.ts                      entry point
app.json                      Expo config: ViroReact plugin options, build limits
app.config.js                 adds the ReactVision keys from a file outside the repository, when there is one
metro.config.js               adds .obj (and other 3D formats) to Metro's asset types
tsconfig.test.json            compiles the pure modules and their tests for Node (`npm test`, `npm run e2e:server`, `npm run measure:report`)
plugins/
  withAndroidBuildTuning.js   config plugin: Gradle limits, JS bundle embedded in debug
modules/
  wifi-route/                 native Android module: bind the app to Wi-Fi, phone's Wi-Fi address
scripts/
  env.ps1                     optional: caches in another folder for the current shell
  pull-device-data.sh         after a test on a phone: logcat lines, settings, measurement records, scans -> a folder on the PC
  generate-assets.mjs         generates all textures and the door-frame OBJ
  mock-server.mjs             stand-in server answering GET /health (connection tests)
assets/
  models/door_frame.obj       generated door frame (frame + one flat transparent window)
  models/portal_window.obj    generated window alone (a unit quad), for the wooden casing
  textures/*.png              generated textures
src/
  ar/
    PortalARScene.tsx         ViroARScene: task-1 objects, tracking/camera/plane feeds, provider life cycle
    DoorPortal.tsx            ViroPortalScene + ViroPortal + door model; the two attach modes
    VirtualRoom.tsx           the stage-1 test room (primitives, own lights), kept as a fallback
    RoomScanLayer.tsx         highlights of the planes and corners the phone detects
    ServerRoomLayer.tsx       the room plan computed by the server
    MeasureLayer.tsx          posts on the marked corners of the real door opening
    doorGeometry.ts           door / room dimensions, light bit masks
    materials.ts              ViroMaterials and animations
  localization/
    types.ts                  LocalizationProvider interface, pose types, conventions
    BaseProvider.ts           listener bookkeeping shared by providers
    ManualPlacementProvider.ts  stage-1 stand-in
    SelfHostedServerProvider.ts where the room is, from the venue's server; episodes of looking for the room
    core/relocalization.ts    rules: tracking loss, retries, what an answer does to the door (unit-tested)
    ReactVisionVpsProvider.ts where the room is, from ReactVision Advanced VPS and the room's bridge (never run)
    vpsBridge.ts              between that provider and the library's tracker; "does this build have keys?"
    arCamera.ts               the camera of the running AR view, for code outside the scene
    core/vpsAlignment.ts, vpsStatus.ts   pure: where the service's map lies in the session, the service's states
    core/ways.ts              pure: which way is taken, the room through the bridge, the samples of a bridge measurement
    stubs.ts                  ARCore Cloud Anchor (not implemented)
    math.ts                   small vector / Euler helpers
    index.ts                  provider registry
  door/
    DoorPlacer.ts             THE place that puts the door: room transform x door record, the rules, "room found"
    doorRecords.ts            reading the room's door record (and plan) from the venue's server
    core/roomFrame.ts         pure: 4x4 transforms, a pose into the session and back into the room's frame
    core/placement.ts         pure: record and plan in the session, what an answer does to the door, the body of a save
  environments/               worlds behind the portal and the door casing (maintained separately):
                              SponzaAtrium.tsx, DoorCasing.tsx
  measure/
    core/measurement.ts       door against marked corners, record format, summary per test (unit-tested)
    core/report.cli.ts        `npm run measure:report`: the summary on the PC
    measureController.ts      measurement mode: marks, records, the file on the phone
  room/
    roomGeometry.ts           room model from plane anchors: walls, floor, corners (unit-tested)
    roomStore.ts              state of the scan, upload and server plan
    scanController.ts         world mesh, session recording, capture folders
    meshFormat.ts             the engine's mesh file (RVWM) and its conversion to PLY (unit-tested)
    roomServer.ts             upload, build progress, room plan, localisation by clip
    doorServer.ts             saving the door staff placed (in the room's frame), removing a saved door, the room's place at ReactVision
    bridgeMeasure.ts          linking a room to its place at ReactVision: both ways in one AR session, samples to the server
  server/
    core/                     pure, unit-tested: address, subnet, health, client, discovery, phone network,
                              state machine, room plan, device log; server.e2e.ts = run against a real server
    identity.ts               installation id, phone name, id of the app run
    deviceLogger.ts           sends the event log and the scenario step to the server's panel
    ServerConnection.ts       heartbeat, automatic search, saved address
    wifiRoute.ts              JavaScript side of modules/wifi-route
    storage.ts                last working address on the phone
  state/appStore.ts           store shared by the AR scene and the overlay; holds THE door pose
  brand.ts                    product name and palette (placeholders), the one place to change them
  i18n/                       every user-facing text (en.ts, hr.ts), lookup t(key, params), which language is shown (languages.ts)
  state/language.ts           the phone's language and the one chosen in the app, applied at the root
  ui/LanguageChips.tsx        the language chips of the visitor's welcome panel
  state/prefs.ts              what is remembered between launches (onboarding, developer options...)
  room/roomsStore.ts          rooms of the server, plan and doorway of the current one (map frame)
  ui/theme.ts, kit.tsx, icons.tsx   sizes and type, shared pieces, icons
  ui/core/                    pure, unit-tested: what the AR screen shows (arView), Home situations, plan layout,
                              the steps of the guided scan (scanFlow), percentage, steps and problems of a build (buildView)
  ui/ScanPrepareScreen.tsx, ScanScreen.tsx, BuildScreen.tsx   the guided scan and the build of its map
  spaces/spaces.ts            the spaces that can stand behind the door, and what is said about them
  spaces/core/choice.ts       pure, unit-tested: which spaces are offered, which one stands behind a room's door
  spaces/spaceChoice.ts       the choice tied to the stores: kept per room in the preferences, shown by the scene
  spaces/pictures.ts, credits.ts   the picture of each space; whose work the spaces, the door and the software are
  ui/SpacesScreen.tsx         the list of spaces, the sheet of one, "Put behind my door"
  ui/RoomsScreen.tsx          the rooms of the server: state of each, row menu, rename, delete
  ui/core/roomsView.ts        pure, unit-tested: the rows and their states, the row menu, the count of failed searches
  room/roomAdmin.ts           rename and delete a room on the server; the count of sessions in which a room was not found
  ui/VisitorScreen.tsx        the whole of visitor mode: welcome panel, coach lines, "ask a member of staff" sheets
  ui/modeSheets.tsx           the staff PIN pad, and the question before switching to visitor mode
  ui/core/modes.ts, visitorView.ts   pure: start screen by mode, which doors a visitor may see, PIN hash and lock, visitor texts
  ar/WallGridLayer.tsx        the real room's wall as a grid, inside the space
  ar/VpsLayer.tsx             the library's <ViroVPS> for the ReactVision provider
  ui/ConnectionScreen.tsx     the connection method: own server or ReactVision cloud; the room's location id and its link
  ui/BridgeScreen.tsx         "Link to the room": the walk that measures the bridge
  ui/PlaceDoorScreen.tsx      "Place the door": put it here, adjust, save to the server
  ui/RoomResultScreen.tsx     what the server understood about a room that was just scanned
  ui/core/doorEdit.ts, placeView.ts   pure: the steps of placing a door, what is sent to the server, what the placing screen shows when
  ar/PlaceMarker.tsx          outline and arrow on the floor under a door that is being placed
  ar/photoCamera.ts           the photo of the view: the AR view's screenshot call, gallery first
  ui/Shutter.tsx              the shutter button and the 4 s preview; ui/core/photo.ts: file name, the call's answer (pure)
  ui/ArScreen.tsx             the product's AR screen: coach card, pills, banner, menu, problem sheets
  ui/HomeScreen.tsx, ConnectScreen.tsx, SettingsScreen.tsx, WelcomeScreen.tsx, PermissionScreen.tsx,
  ui/ProblemScreen.tsx, MoreScreens.tsx, PlanDrawing.tsx, flows.ts   the other screens and the paths between them
  ui/Overlay.tsx              DEVELOPER TOOLS: mode badge, status banner, status panel, event log, buttons
  ui/ServerPanel.tsx          server status chip and server settings
  ui/ScanPanel.tsx            room-scan buttons, numbers, upload and build progress
  ui/MeasurePanel.tsx         measurement mode: test, marks, result, crosshair
docs/
  capture-format.md           what a capture contains (for the server's upload handler)
  test-protocol.md            the five persistence checks of task 5, step by step
  demo-video.md               shot list of the demo video
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
  getStatus(): LocalizationStatus;   // idle | waiting-for-tracking | waiting-for-server | connected | localizing | localized | lost | error
  getStatusDetail(): string;
  onStatus(listener): Unsubscribe;
  onPose(listener: (update: PoseUpdate) => void): Unsubscribe;
  relocalize(): void;
}

interface PoseUpdate {
  pose: { position: Vec3; rotation: Vec3 };   // doorway pose in AR-world coordinates
  opening?: { width: number; height: number }; // size of the real doorway, when known
  quality?: { confidence?; positionErrorM?; headingErrorDeg?; note? };
  automatic?: boolean;                         // a correction the user did not ask for
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
| `ReactVisionVpsProvider` | Implemented, **never run** (no account yet): [The second connection method](#the-second-connection-method-reactvision-advanced-vps). Says where the room is, through the room's bridge; the door layer puts the same door there. In a build without keys it reports "not set up". |
| `ArCoreCloudAnchorProvider` | Stub, no network code. Needs a Google Cloud API key and plugin option `provider: "arcore"`. |
| `SelfHostedServerProvider` | Implemented, **not yet run on a device**. Says where the room is: from the answer to a 1.2 s clip sent to `/localize` (or, in the developer tools, the identity after a build in the same session). The door layer puts the door there ([One door, whatever recognises the room](#one-door-whatever-recognises-the-room)). Retries, tracking loss and corrections follow [Keeping the doorway in place](#keeping-the-doorway-in-place). |

Without a key file the ViroReact plugin is configured with `provider: "none"` and
`telemetry: false` (no anchor back-end, no usage ping), and no API keys or accounts are
used: the app talks only to the server address you set. With the key file of
[the second connection method](#the-second-connection-method-reactvision-advanced-vps)
the build carries a ReactVision client key, and with that method chosen the app also
talks to ReactVision's servers.

## How the portal works

Scene graph:

```
ViroARScene
  [ViroNode  ← door pose]                 only in attach mode "parent"
    ViroPortalScene passable              origin = centre of the opening
      ViroPortal
        Viro3DObject portal_window.obj    frame "casing": ONE flat transparent window, the portal's only child
        | Viro3DObject door_frame.obj     frame "simple": one model, frame + one flat window
    CasingWood (beside the portal scene)  frame "casing": six wooden parts, plain objects of the AR scene
      ViroSkyBox (colour)                 background of the inner world
      ViroNode (down to floor level)
        SponzaAtrium | VirtualRoom        the world; the test room has its own lights
        DoorLeaf                          open plank door (casing + atrium only)
```

**Door frame.** The button **Frame** switches between two frames; both take the size of
the real doorway (0.9 x 2.0 m when the door is placed by hand):

- `casing` (default) - a walnut casing from `src/environments/DoorCasing.tsx`: the side
  parts are stretched only in height and the head only in width, so the moulding keeps its
  cross-section. With the atrium an open plank door hangs behind it; the door does not
  move (its swing animation has not been tried on a device). Not yet seen in ViroReact;
- `simple` - the one-piece frame of stage 1, scaled as a whole, so its posts get thicker
  or thinner with the doorway. This is the frame the device test was made with.

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

A mitigation was tried and **taken back**: the transparent part as a **tunnel** through
the frame (a second window at the back of the frame and four side walls), so that a
camera that had overshot the first window would still look at transparent faces. With
it - and with the wooden casing's own window, a separate box with a fully transparent
texture - the doorway showed **no world at all** on the first full pass on a phone
(2026-11-21): only the wood, the space appeared after walking in. The cause was not
found (the phone was not at hand); the window is again what has been seen working on
build `9cb8a8b` - one flat face in the crossing plane, see
[After the first pass on a phone](#after-the-first-pass-on-a-phone). The frame keeps its
depth (6 cm in front of the plane, 14 cm behind it). So the flash may be back. If it is, the next
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

The door frame and the stage-1 test room are original and generated by
`scripts/generate-assets.mjs` (committed for convenience; `npm run assets` reproduces
them byte for byte). The world behind the portal is a third-party model: the atrium of
the Sponza Palace after the "Crytek Sponza" model (CC BY 3.0) — files, credits and
licences in `assets/environments/sponza_atrium/` (`LICENSES.md`). The door casing and the
plank door were modelled for this project and use CC0 wood textures - see
`assets/environments/door_casing/LICENSES.md`. Both are described in
`src/environments/README.md`.

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

### Server connection on a device

Second session, same phone (Xiaomi 14 Ultra, Android 16), build of commit "Stage 2a",
real localization server 0.2.0 running on the development PC (wired to the same router),
phone on Wi-Fi. The screen was read with `uiautomator dump` and a screenshot. Taps could
not be sent over adb (the phone refuses injected input without an extra MIUI developer
option), so nothing that needs a tap was driven from the PC.

| Point | Observed |
| --- | --- |
| Status chip, plain HTTP from the phone over Wi-Fi | **Works.** Green "Server: connected · <PC name> · 37 ms"; later readings 21–189 ms |
| Saved address used at start | **Works.** With the address file present, the log shows "trying the saved address", "connecting", and "connected" 0.1 s after start. The file was put there with `adb run-as` for the test, not written by the app |
| Server stopped | **Works.** Chip red "Server: unreachable" about 6 s after the server process was killed (two missed checks); log line "no answer within 1500 ms" |
| Server started again | **Works.** Chip green again at the first check after the server answered |
| Automatic search, first version (24 at a time) | **Did not find the server**, three searches out of three (253 addresses in 5.7 s each, "No server answered"). During one of them Android reported the Wi-Fi as lost and reconnected; the server's log shows that one request of a search did arrive and was answered, later than the 500 ms the app waited. Cause and measurements: [Why the search is slow](#why-the-search-is-slow) |
| "Find automatically" while the phone preferred mobile data | **Wrong message** in the first version: "The phone is not connected to Wi-Fi", although Wi-Fi was connected (the app looked only at the phone's default network). Fixed; the fixed behaviour in this situation was not observed, because the situation did not come up again |
| Event-log fix from the first session | **Confirmed**: the newest line is the last visible one at the moment the chip changes |
| Camera-permission fix, doorway flash mitigation | Not judged in this session (permission already granted; nobody walked through the door) |

Third session, same phone and server, build with the paced search and the Wi-Fi binding
(`modules/wifi-route`), taps made by the owner:

| Point | Observed |
| --- | --- |
| Wi-Fi binding at start | logcat: "Wi-Fi network 945 available, process bound: true"; Android lists the app's request for the Wi-Fi transport |
| "Forget" | **Works**: chip "Server: not set up", the saved-address file is gone |
| Automatic search, paced | **Found the server** in 17 s: "Found <PC name> at <address>:8077 after 73 of 253 addresses", chip green. Mobile data was switched on, Wi-Fi was the phone's default network. During the search the phone looked the computer's hardware address up afresh without trouble, the router stayed reachable and the Wi-Fi connection was not dropped |
| Saved address | **Written by the app** after the search: `{"version":1,"address":"<address>:8077"}` |
| Typing an address, "Test connection" | Not exercised |
| Search or connection while the phone prefers mobile data | Not exercised with the fixed build |

### Room scan, upload and the atrium on a device

Fourth session (2026-11-20, evening), same phone, build of commit `546697d`, real server
0.2.0 on the development PC with a GTX 1050 Ti. The owner used the app freely for about
five minutes; observations come from the app's log, two screenshots and the files pulled
from the phone afterwards. Nobody followed a test plan, so this is what happened to be
exercised:

| Point | Observed |
| --- | --- |
| Saved address at start | **Works**: connected 0.3 s after start |
| Manual provider, atrium, door casing | The door was placed when tracking became NORMAL; the log shows "door casing loaded (0.90 x 2.00 m)" and "Sponza atrium loaded" 0.7 s after the loading started, no error. **Whether they look right was not judged** - the screenshots were taken while the phone looked elsewhere |
| Room mesh | **Works**: source `depth`, accumulated, 104 060 triangles after ten seconds of looking around |
| Planes | Horizontal planes found, classified `Floor`. **No vertical plane (wall) was found** in this session; nobody scanned the walls on purpose |
| Switching the scan mode | Each switch made tracking UNAVAILABLE for about half a second and **dropped the planes found so far** |
| Mesh snapshot | **Works** with an identity transform: 239 kB and 1.86 MB files in the engine's own format |
| Recording | **Works**: two captures of about one second (18 and 15 frames) with `video.mp4`, `session.jsonl`, `planes.json`. Their format settled five of the six open points of [`docs/capture-format.md`](docs/capture-format.md) |
| Upload and build progress | **Works**: a 0.9 s capture (1 MB) was sent, the server accepted it, the app showed "step 1/7 frames", "2/7 features", "4/7 sfm" and then the server's reason for failing, in words. A map cannot be built from one second of video, so **a successful build from a phone recording has not been seen** |
| Self-hosted provider without a map | Says "the server has no map "room" yet - scan the room first" |
| Typing a server address | **Not confirmed** (asked for, not done) |

The unit tests (85 at that time), the client against `scripts/mock-server.mjs` and against the real
server on `localhost`, and `usesCleartextTraffic="true"` in the merged manifests of the
debug and release variants were checked on the development PC.

## Not verified yet

Everything in this list is written but has not been seen working on a phone. The build
on the phone at the time of writing is `546697d`; what was added later (device log, mesh
as PLY, tracking loss, status banner, the reduced provider switch, the measurement mode)
has never been installed.

- **a map built from a real room recording**: a one-to-two-minute recording, its upload
  (size, time, progress), the build, the server's room plan drawn in the session, the
  door casing in the real door opening at the opening's size;
- **finding the room again**: the 1.2 s clip recorded while the portal is shown,
  `/localize`, the door in the same opening after a restart, the banner texts,
  **Re-localize**;
- **tracking loss**: that a loss longer than 1.5 s is noticed, that the door stays, that
  the room is looked for again and the door confirmed or corrected; that switching the
  scan mode does not count as a loss;
- **every product screen** (welcome, permission, Find the server, Home, the AR screen
  with its coach card, pills, banner, menu and sheets, Settings, problem screens), in
  light and dark, with the largest system font; that leaving and re-entering the AR
  screen starts a new AR session cleanly; the plan drawing against the real room; the
  amber outline of an unconfirmed doorway; the AR-support query;
- **ReactVision Advanced VPS**: everything - the build with `provider: "reactvision"`
  (does AR, the recording and the room mesh still work?), "Not set up in this build" in a
  build without keys, finding a place, linking a room to its place (both ways in one AR
  session) and the error the server reports for the bridge, the door through the bridge
  against the door through the server in the same room, the door staying put while
  somebody walks through it, the fall-back to the other way, the Connection page;
- **the photo**: that it shows the scene without the buttons, that it reaches the
  gallery (or at least the app's storage) and the preview shows it, on the staff and on
  the visitor screen, at the door and inside the space;
- **placing the door**: the whole pass "staff scan the room, place and save the door,
  the app is closed, a visitor opens it, the door stands where it was saved" - the
  assignment's main question; that the door being placed is drawn (the portal with
  `passable` off, moved with every tap), the outline and the arrow on the floor (lines
  lying flat on the floor have not been seen), whether the cross is the middle of the
  camera picture and **Put it here** lands where it points, the step buttons and their
  repeat, the turn icons against the direction the door turns, the size steps redrawing
  the casing, **Use the found doorway**, saving in a fresh AR session right after a
  build, **Move the door** and **Remove the door**, the room result screen with a real
  plan;
- **the two modes**: a fresh install opening the visitor screen; **Start** and Android's
  camera dialog; the search for the server behind "One moment…"; every visitor sheet
  (server off, no Wi-Fi, no saved door, room not recognised, camera refused); the help
  button; the lock and the PIN pad (create, enter, wrong, locked for 30 s, change); the
  mode surviving a restart; a later visitor launch going straight to the camera;
- **the guided scan**: that the recording starts by itself, the counters (floor, walls,
  metres) against a real walk, whether a minute and six metres are sensible thresholds,
  the corner brackets, the scan paint and the engine's mesh lines (look and frame rate),
  closing and discarding, the automatic finish at three minutes, saving (how long "Saving
  the scan…" stays), the upload percentage of a real 100-300 MB recording, every problem
  screen, **Send again**, leaving and coming back during a build;
- **inside the space**: whether the wall grid can be seen at all (it is drawn inside the
  portal's inner scene, which has not been tried), whether it stands on the real wall,
  the distances 0.6 m and 0.3 m, "Door is behind you" against what is really in view;
- **the measurement mode**: whether the crosshair is the middle of the camera image,
  how repeatable a mark is (the protocol starts with that check), the posts staying on
  the marked corners, the records and their file, the lines reaching the server; and
  every one of the five checks themselves ([`docs/test-protocol.md`](docs/test-protocol.md));
- **walls in the scan**: whether the phone finds vertical planes in a normal room, the
  orientation of their highlights, the corner markers, the direction of wall normals
  (the last open point of the capture format), highlights staying in place when turning;
- **the Sponza atrium by eye**: frame rate, whether the hall is visible through the
  doorway from outside (see `src/environments/README.md`);
- **the door casing by eye**: seven models under one `ViroPortal`, the inner world
  visible through its transparent part, walking through it (its "tunnel" is 5.5 cm deep,
  the simple frame's 14 cm), the open door leaf (see `src/environments/README.md`);
- **the device log from a phone**, and the phone showing up in the server's panel;
- **the mesh as PLY**: the conversion on the phone and the upload of the file;
- **parts of the server connection** (stage 2a), see
  [Server connection on a device](#server-connection-on-a-device): typing an address
  into the settings screen, the app reaching the server while the phone prefers mobile
  data (the reason for `modules/wifi-route`), a search on a network other than the one
  it was measured on, and the heartbeat pausing in the background;
- the three fixes above, and the look of the deeper door frame that came with the
  mitigation;
- long-term drift of the doorway while the app keeps running;
- behaviour when the parent node of the portal is actually *moved* by a provider (the
  attach-mode switch was only tried with a static pose), and whether auto-anchoring
  moves the portal;
- phones other than the one above;
- Metro taking priority over the embedded bundle in the development loop;
- details nobody looked at specifically: separation of AR and room lights by bit masks,
  3D text sizes, texture orientation;
- a clean clone built end to end with the documented commands (the steps were run
  individually on the development machine).

## Known issues and limitations

- With the `manual` provider the doorway position is **not persistent**: every start
  places it relative to the phone. Persistence is the `self-hosted` provider's job, and
  that has not run on a device yet.
- Switching the scan mode on or off drops the planes the phone has found (seen on a
  device). Switch it on once and leave it on while scanning.
- A recording has a variable frame rate of about 16 frames per second, and its camera
  poses are given for the upright picture while the pixels are landscape
  (`docs/capture-format.md`). Whether the server's map building handles this correctly
  with a real recording has not been seen.
- A one-frame flash of the camera image was seen at the AR → VR crossing with the first
  build; a mitigation is in place but unconfirmed (see
  [How the portal works](#how-the-portal-works)).
- The floor height is a guess until ARCore reports a horizontal plane; before that the
  doorway is placed 1.4 m below the camera. Use *Re-place door* after looking at the floor.
- The renderer does not check the crossing direction: walking through the frame from
  behind also counts as "entering", and you end up outside the room's walls.
- The portal must not move while the user is crossing it (the crossing test compares
  camera positions between frames). Automatic corrections wait while the user is inside
  the virtual world; a correction at the very moment of walking in is still possible.
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
