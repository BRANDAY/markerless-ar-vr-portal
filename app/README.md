# FESB AR Portal — markerless AR-to-VR portal (proof of concept)

A mobile app that shows a doorway in augmented reality. Through the doorway the user sees
a virtual world - the atrium of the Sponza Palace in Dubrovnik -, can physically walk
through it into VR and walk back out into AR. The goal of the assignment is that the
doorway appears at the same real-world place in every app session, found without
markers, QR codes, GPS or manual placement: the app scans the room once, a
self-hosted server builds a map and a plan of the room from the recording and finds the
real door opening in it, and from then on the virtual doorway stands in that opening.

**Where this stands (2026-11-20).** Everything is written and unit-tested. On a phone
(Xiaomi 14 Ultra) these parts have been seen working: the AR scene and the walk-through
portal (with the first, simple room), the connection to the server, the room mesh, the
recording, and the upload with its progress. **Not yet seen on a phone:** a map built
from a real room recording, the doorway in the real opening, finding the room again
after a restart, the atrium and the wooden door casing by eye, and everything about
tracking loss. The details are in [Verified on a device](#verified-on-a-device) and
[Not verified yet](#not-verified-yet); read them before relying on anything.

New here? Go through [Setup on Windows](#setup-on-windows), then
[The scenario, step by step](#the-scenario-step-by-step).

## Status against the assignment

| Task | State |
| --- | --- |
| 1. Camera feed and basic 3D objects in AR | Implemented (`src/ar/PortalARScene.tsx`); camera feed and tracking confirmed on a device |
| 2. Recognise a previously scanned room without markers | **Written; half of it seen on a device.** The app scans the room (planes, room mesh, video with camera poses) and sends the recording to the localization server, which builds the map and the room plan; in a later session a short clip sent to `/localize` finds the room again. Seen on the phone: mesh, recording, upload, build progress, the server's refusal of a one-second recording shown in words. Not seen: a successful build from a phone recording, and finding the room again ([the scenario](#the-scenario-step-by-step)) |
| 3. Doorway at the same real-world pose in every session | **Written, not yet run on a device.** The portal is placed in the real door opening the server found in the scanned room, with the door casing built to the size of that opening (`self-hosted` provider). Against the server on the PC, with a test recording that lies there, the app's client code gets a doorway back from `/localize` 2.3 cm from where it should be - a doorway set by hand in a test map, not one the server found ([End-to-end check without a phone](#end-to-end-check-without-a-phone)) |
| 4. See a virtual world through the doorway, walk in and back out | Implemented (`src/ar/DoorPortal.tsx`); the walk-through was confirmed on a device with the stage-1 test room, one visual defect at the crossing (see below). The world behind the door is now the atrium of the Sponza Palace with a wooden door casing (`src/environments/`): both load on the phone without an error, **nobody has looked at them yet** |
| 5. Tests: restart, angles, lighting, tracking loss | **Behaviour written, tests on a device not started.** What the app does when tracking is lost and comes back, how often it asks the server again and what it does with weak answers is implemented and unit-tested ([Keeping the doorway in place](#keeping-the-doorway-in-place)); the measurements themselves need a device |

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

Other scripts: `npm run typecheck` (TypeScript), `npm test` (85 unit tests of the pure
modules, run in Node), `npm run build:android` (the Gradle build above),
`npm run e2e:server` (the app's client against a real server,
[without a phone](#end-to-end-check-without-a-phone)), `npm run assets` (regenerate
textures and the simple door model).

## Using the app

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
- *Debug / Hide debug*: toggles the debug overlay (status panel, event log, scan panel,
  buttons). Hide it to see the scene.
- Status panel: tracking state and reason, camera position and forward vector in
  AR-world coordinates, detected floor height, provider status, door pose, attach mode.
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
| **Provider: manual / self-hosted** | who decides where the doorway stands. `manual` (the default): in front of the camera, no server needed. `self-hosted`: in the real door opening the server found. The two stubs (`reactvision-vps`, `arcore-cloud-anchor`) exist in the code but are not offered |
| **World: sponza / test-room** | what is behind the door. `sponza` (the default) is the atrium; `test-room` is the small violet room of stage 1, kept to tell a portal problem from a problem with the big model |
| **Frame: casing / simple** | the door frame, see [How the portal works](#how-the-portal-works) |
| **Hide log**, **Clear log** | the event log |

The shortest way to see the virtual world, without a server: start the app, move the
phone slowly until tracking is NORMAL. A box and a sphere appear about 1.2 m in front of
the starting position; the door casing appears 2 m ahead, standing on the floor and
facing you. Press **Hide debug**, look through the door at the atrium, walk through it:
the badge switches to VR and the hall surrounds you. Turn around and walk back through
the door to return to AR. If the door stands badly, look at a free piece of floor and
press **Re-place door** (in the debug overlay).

## The scenario, step by step

Connection, scanning, portal. Steps 1 to 4 have been seen on a phone (step 4 only with a
recording too short to build a map from); steps 5 to 7 have not.

1. **Start the server** on a computer in the same network (project `localization-server`,
   its README: `uv run locserver-serve`). It prints its address.
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
5. **Portal in the doorway.** When the build has succeeded the server's room plan is
   drawn in orange (walls, corner posts, floor outline; door openings in white), the
   provider switches to `self-hosted` and the door casing stands in the real door
   opening, built to its width and height. **Plan: on/off** hides the plan. Walk through.
6. **Next session.** Start the app in the same room, connect, choose **Provider:
   self-hosted**. Once tracking is NORMAL the app records a 2.5 s clip, sends it to the
   server and places plan and door from the answer; the banner shows the attempts. Hold
   the phone still, pointed at a part of the room with detail (not a bare wall).
7. **If it goes wrong.** "Room not recognised": look at another part of the room and
   press **Re-localize**. "No door opening found": the map has no doorway - switch to
   `manual` to place the door by hand, or scan again with the whole door in view; the
   app never substitutes a position of its own. Tracking lost: see
   [Keeping the doorway in place](#keeping-the-doorway-in-place).

The map is always called `room`, and a new upload replaces it.

## Connect to the localization server

The localization server is a separate project (`localization-server`, Python). It runs
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
   `GET /health` on the port, nearest addresses first, a new one every 0.2 s. It accepts
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
  in Node (`npm test`; 85 tests in all with those of `src/room/` and `src/localization/core/`, including a local mock of the server contract):
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
`localization-server/docs/api-v2.md`. All HTTP is in `src/server/core/client.ts`, the
parsing of the answers in `src/server/core/roomPlan.ts` (both unit-tested).
`src/ar/ServerRoomLayer.tsx` draws the server's plan.

**The doorway.** A map built from a recording has the coordinate frame of the AR session
that recorded it, so right after the build the plan and the doorway can be shown as they
are. In any later session the frames differ; then a short clip with its camera poses goes
to `POST /localize`, and the answer carries plan and doorway already transformed into the
current session.

If the server found **no door opening**, nothing is placed and the status says what to
do. The app never substitutes a position of its own.

### Keeping the doorway in place

The rules are in `src/localization/core/relocalization.ts` (pure, unit-tested) and are
applied by the `self-hosted` provider. **None of this has been tried on a device.**

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
npm run e2e:server -- http://127.0.0.1:8077 <folder with video.mp4 and session.jsonl> [map id] [--localize-only]
```

runs the app's own client code and decision rules against a real server from the PC
(`src/server/core/server.e2e.ts`): health, device log, upload, following the build, room
plan, doorway, and a localisation with the recording used as the clip. The map id
defaults to `app_e2e` and is replaced on the server. Result of the last run:
server 0.3.0 on the development PC (GTX 1050 Ti), 2026-11-20, with the server project's
test recording of 30 frames from the public TUM room sequence (not a phone recording):

| Step | Result |
| --- | --- |
| Health, capabilities | ok |
| Device log: batch accepted, a repeated batch counted as duplicates | ok |
| Upload accepted, build followed through its seven steps | ok, 643 s |
| Room plan and doorway of the new map parsed | 2 walls, 1 corner, 1 door opening - which the server did not consider sure enough to use (`source: none`) |
| Localisation with the recording as the clip | answered in 1.7 s, "good", 743 inliers; the app's decision: **no doorway, nothing placed** |
| The same clip against an existing map that has a doorway set by hand (`--localize-only`) | answered in 3.4 s, "good", 1073 inliers; the app's decision: **place**; the doorway came back **2.3 cm** from where the recording's known transform puts it |

So both branches of the app's logic were exercised against the real server; a doorway
found *automatically* by the server and then placed by the app has not been seen yet,
because no recording at hand produces one. A first run was cut off at step 6 of 7 when the
server was restarted; the app's client reported the job as failed with the server's
reason. With `--localize-only` nothing is uploaded and an existing map is used.

What it cannot cover, because it needs React Native or a camera: how the phone encodes
the upload from file paths, the upload progress, the recorder, the 2.5 s clip, and
everything that is drawn.

## Project structure

```
App.tsx                       camera permission gate, AR navigator + overlay
index.ts                      entry point
app.json                      Expo config: ViroReact plugin options, build limits
metro.config.js               adds .obj (and other 3D formats) to Metro's asset types
tsconfig.test.json            compiles the pure modules and their tests for Node (`npm test`, `npm run e2e:server`)
plugins/
  withAndroidBuildTuning.js   config plugin: Gradle limits, JS bundle embedded in debug
modules/
  wifi-route/                 native Android module: bind the app to Wi-Fi, phone's Wi-Fi address
scripts/
  env.ps1                     optional: caches in another folder for the current shell
  generate-assets.mjs         generates all textures and the door-frame OBJ
  mock-server.mjs             stand-in server answering GET /health (connection tests)
assets/
  models/door_frame.obj       generated door frame (frame + transparent "tunnel")
  textures/*.png              generated textures
src/
  ar/
    PortalARScene.tsx         ViroARScene: task-1 objects, tracking/camera/plane feeds, provider life cycle
    DoorPortal.tsx            ViroPortalScene + ViroPortal + door model; the two attach modes
    VirtualRoom.tsx           the stage-1 test room (primitives, own lights), kept as a fallback
    RoomScanLayer.tsx         highlights of the planes and corners the phone detects
    ServerRoomLayer.tsx       the room plan computed by the server
    doorGeometry.ts           door / room dimensions, light bit masks
    materials.ts              ViroMaterials and animations
  localization/
    types.ts                  LocalizationProvider interface, pose types, conventions
    BaseProvider.ts           listener bookkeeping shared by providers
    ManualPlacementProvider.ts  stage-1 stand-in
    SelfHostedServerProvider.ts door in the opening the server found; episodes of looking for the room
    core/relocalization.ts    rules: tracking loss, retries, what an answer does to the door (unit-tested)
    stubs.ts                  ReactVision VPS / ARCore Cloud Anchor (not implemented)
    math.ts                   small vector / Euler helpers
    index.ts                  provider registry
  environments/               worlds behind the portal and the door casing (maintained separately):
                              SponzaAtrium.tsx, DoorCasing.tsx
  room/
    roomGeometry.ts           room model from plane anchors: walls, floor, corners (unit-tested)
    roomStore.ts              state of the scan, upload and server plan
    scanController.ts         world mesh, session recording, capture folders
    meshFormat.ts             the engine's mesh file (RVWM) and its conversion to PLY (unit-tested)
    roomServer.ts             upload, build progress, room plan, localisation by clip
  server/
    core/                     pure, unit-tested: address, subnet, health, client, discovery, phone network,
                              state machine, room plan, device log; server.e2e.ts = run against a real server
    identity.ts               installation id, phone name, id of the app run
    deviceLogger.ts           sends the event log and the scenario step to the server's panel
    ServerConnection.ts       heartbeat, automatic search, saved address
    wifiRoute.ts              JavaScript side of modules/wifi-route
    storage.ts                last working address on the phone
  state/appStore.ts           store shared by the AR scene and the overlay; holds THE door pose
  ui/Overlay.tsx              mode badge, status banner, status panel, event log, buttons
  ui/ServerPanel.tsx          server status chip and server settings
  ui/ScanPanel.tsx            room-scan buttons, numbers, upload and build progress
docs/
  capture-format.md           what a capture contains (for the server's upload handler)
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
| `ReactVisionVpsProvider` | Stub, no network code. Needs a ReactVision API key + project id and plugin option `provider: "reactvision"`. |
| `ArCoreCloudAnchorProvider` | Stub, no network code. Needs a Google Cloud API key and plugin option `provider: "arcore"`. |
| `SelfHostedServerProvider` | Implemented, **not yet run on a device**. The doorway is the door opening the server found: straight from the plan after a build in the same session, otherwise by a 2.5 s clip sent to `/localize`. Retries, tracking loss and corrections follow [Keeping the doorway in place](#keeping-the-doorway-in-place). |

The ViroReact plugin is currently configured with `provider: "none"` and
`telemetry: false` (no anchor back-end, no usage ping); no API keys or accounts are used.
The only network traffic of the app is the health check to the server address you set.

## How the portal works

Scene graph:

```
ViroARScene
  [ViroNode  ← door pose]                 only in attach mode "parent"
    ViroPortalScene passable              origin = centre of the opening
      ViroPortal
        DoorCasing                        frame "casing": six wooden parts + transparent "tunnel"
        | Viro3DObject door_frame.obj     frame "simple": one model, frame + "tunnel"
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

The 85 unit tests, the client against `scripts/mock-server.mjs` and against the real
server on `localhost`, and `usesCleartextTraffic="true"` in the merged manifests of the
debug and release variants were checked on the development PC.

## Not verified yet

Everything in this list is written but has not been seen working on a phone. The build
on the phone at the time of writing is `546697d`; what was added later (device log, mesh
as PLY, tracking loss, status banner, the reduced provider switch) has never been
installed.

- **a map built from a real room recording**: a one-to-two-minute recording, its upload
  (size, time, progress), the build, the server's room plan drawn in the session, the
  door casing in the real door opening at the opening's size;
- **finding the room again**: the 2.5 s clip recorded while the portal is shown,
  `/localize`, the door in the same opening after a restart, the banner texts,
  **Re-localize**;
- **tracking loss**: that a loss longer than 1.5 s is noticed, that the door stays, that
  the room is looked for again and the door confirmed or corrected; that switching the
  scan mode does not count as a loss;
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
