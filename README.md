# Markerless AR-to-VR Portal

A proof of concept for a university assignment (FESB): a mobile app that shows a
virtual doorway in augmented reality, lets the user see a virtual room through it,
physically walk through it into VR and come back — and aims to restore that doorway
at the same real-world position in every app session **without markers, QR codes,
GPS or manual placement**, by recognising the previously scanned room.

## Two projects — you need both

The work is split into two repositories that work together over the local Wi-Fi:

| Project | Where | What it is | Stack |
|---|---|---|---|
| **App** (this repository) | [`app/`](app/README.md) | The Android app: AR scene, walk-through portal, staff and visitor modes, connection to the server | React Native 0.88, Expo SDK 58, ViroReact 3.2 (ARCore) |
| **Localisation server** (a separate repository) | [BRANDAY/arportal-localization-server](https://github.com/BRANDAY/arportal-localization-server), linked here as the git submodule `localization-server/` | A self-hosted visual-localisation server that runs on a PC: builds a map of a room from a recording and tells the phone where the room is | Python, FastAPI, ALIKED + LightGlue, COLMAP (`pycolmap`) |

The app does not restore the door without the server: the server is the part that recognises
the room. Get both with one command:

```
git clone --recurse-submodules https://github.com/BRANDAY/markerless-ar-vr-portal.git
```

If the repository was cloned without that option, the `localization-server/` folder is empty;
fill it with `git submodule update --init`. The server can also be cloned and run on its own
from its repository.

Each project has its own README with setup, build and run instructions for Windows.

## How the pieces fit

```
 phone (app)                               PC on the same Wi-Fi (localization-server)
 ───────────                               ──────────────────────────────────────────
 AR session (ARCore via ViroReact)
 camera frame + AR camera pose  ── HTTP ─▶  POST /localize: match the frame against the room map,
                                            compute the camera pose in the map,
 doorway pose in AR coordinates ◀─ JSON ──  convert the stored doorway anchor into the phone's AR frame
 portal rendered at that pose
```

The app finds the server on the local network by itself (it probes the phone's subnet
for `GET /health`) or takes an address typed by the user; nothing is tied to a
particular network. The app is built around a small `LocalizationProvider` interface,
so the self-hosted server is one option next to ready-made services (ReactVision VPS,
ARCore Cloud Anchors). Provider code for those two is written but has never been run
against the services, so the self-hosted server is the only path that is actually used.

The doorway is placed once, not in every session. A staff member scans the room, the server
builds a map of it from the recording, and the staff member puts the virtual door where it
should stand and saves it on the server. In later sessions — on any phone, also one that
never scanned the room — the server recognises the room from a camera frame and the app
puts the door back at the saved place. The server also tries to find a real door opening in
the room and offers it as a suggestion; on the recordings tried so far it has not found one
reliably.

## Status (23 November 2026)

"On the phone" means a Xiaomi 14 Ultra (Android 16, ARCore 1.57); the room is a living room
with an open kitchen, scanned on 22 November.

| Part | State |
|---|---|
| AR scene with camera feed and 3D objects | Done, checked on the phone |
| Walk-through portal, AR ↔ VR switching | Done, checked on the phone: the virtual space is seen through the doorway before entering, the user walks in and back out |
| Virtual space behind the door: atrium of the Sponza Palace (Dubrovnik) with a wooden door casing | Done, seen on the phone |
| Phone ↔ server connection over Wi-Fi | Done, checked on the phone: a visitor's camera opens only after the saved server answered and the link is good (1.6–2.4 s) |
| Localisation server: map building, `/localize`, room plan, coloured 3D model of the room, door editing in the monitoring panel | Done (server 0.8.0); used with the real room on 22–23 November |
| Room scan in the app (guided walk around the room, depth mesh, recording, upload with progress) | Done, checked on the phone: a 2-minute walk was rated "good" by the server (3.9 × 3.4 m covered, looked from −67° to +52°); the map took 21 minutes to build |
| Two modes: staff (scan the room, place and save the door) and visitor (open the app, the door comes from the server) | Done, checked on the phone |
| Door stored once per room on the server and restored by recognition | Checked on the phone: after reopening the app in another room, the door stood in place 11 s after the visitor entered the room; one recognition attempt takes about 3.5 s. The door positions given by the frames of one clip agree within about 2 cm; the real position has not been measured with a tape |
| 3D model and plan of the room | Done: 113 000 vertices, median distance to the map's triangulated points 1.7 cm; 4 walls at right angles. At the frosted sliding doors the suggested opening lies about 0.5 m in front of the real surface, so the door should be checked in the 3D view of the panel before it is saved |
| Keeping the doorway in place | Seen on the phone: inside the virtual space, close to smooth glass, ARCore may lose or silently re-correct its tracking, and the door was then off after the way back. Now the door's place is checked after every way out; a correction larger than 0.5 m / 15° without an announced loss of tracking is not applied, and the visitor has a "Find the door again" button that starts a new AR session (`f36fd5d`, installed on the phone, not yet tried there) |
| Server monitoring panel and phone simulator | Done |
| Ready-made localisation services (ReactVision Advanced VPS, ARCore Cloud Anchors) | Studied from the documentation and the library code; provider code is written but was never run against the services (no paid account), and is not part of the main path |
| Full pass on a real phone in a real room (scan → map → door → restart → door in place) | Done on 22 November |
| Persistence tests (restart, angles, lighting, tracking loss) | Protocol written ([`app/docs/test-protocol.md`](app/docs/test-protocol.md)); restart, other positions and tracking loss were observed during the passes, but the measured trials of the protocol and the lighting change have not been run |

## Open the projects in an editor

The file [`vr-fesb.code-workspace`](vr-fesb.code-workspace) opens both projects in one
**Visual Studio Code** window: double-click it, or *File → Open Workspace from File…*. VS Code
then offers the recommended extensions (Python, React Native Tools). **Ctrl+Shift+B** (or F5,
*Demo: server, then the app on the phone*) starts the server with its panel and then builds, installs
and starts the app on the phone connected over USB. *Terminal → Run Task…* lists the separate
commands: type check and unit tests of the app, build the debug APK, install it on the phone
and start it, Metro, the phone's log, start the server with its panel, the server's tests and its
connection check. How to work on each project:

- **App** — edit the TypeScript in VS Code; build and run with the commands of
  [`app/README.md`](app/README.md#setup-on-windows), or open the generated native project in
  **Android Studio** as described in
  [Open in VS Code and Android Studio](app/README.md#open-in-vs-code-and-android-studio).
- **Server** — VS Code with the Python extension, interpreter from the server's environment; see
  [Open in VS Code](https://github.com/BRANDAY/arportal-localization-server#open-in-vs-code) in the
  server README.

## Quick start

1. **Server** — on a Windows PC: follow the
   [server README](https://github.com/BRANDAY/arportal-localization-server#readme) (the same file is
   `localization-server/README.md` after a clone with submodules)
   (install with `uv`, start the server with a double click on `Start AR Portal Server.cmd`,
   allow the port in the firewall). The server window shows the address to type into the app.
2. **App** — follow [`app/README.md`](app/README.md) to build the debug APK and install it on an
   ARCore-capable Android phone (AR needs a real device; the Android emulator on the PC is only
   for the screens, see [Android emulator](app/README.md#android-emulator)).
3. Put the phone and the PC on the same Wi-Fi, open the app and use the server status chip to
   find the server automatically or enter its address.

## Documents

- [`docs/research/tools-comparison.ru.md`](docs/research/tools-comparison.ru.md) — a survey (in Russian)
  of the tools considered for markerless persistent AR — visual positioning services, cloud anchors,
  on-device options, app frameworks, portal techniques — with the reasoning behind the chosen approach
  and a draft test protocol.
