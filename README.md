# Markerless AR-to-VR Portal

A proof of concept for a university assignment (FESB): a mobile app that shows a
virtual doorway in augmented reality, lets the user see a virtual room through it,
physically walk through it into VR and come back — and aims to restore that doorway
at the same real-world position in every app session **without markers, QR codes,
GPS or manual placement**, by recognising the previously scanned room.

The repository has two parts that work together over the local Wi-Fi:

| Folder | What it is | Stack |
|---|---|---|
| [`app/`](app/README.md) | The Android app: AR scene, walk-through portal, pluggable localisation layer, connection to the server | React Native 0.88, Expo SDK 58, ViroReact 3.2 (ARCore) |
| [`localization-server/`](localization-server/README.md) | A self-hosted visual-localisation server: builds a map of a room from a capture and returns the camera pose for an image sent by the phone | Python, FastAPI, ALIKED + LightGlue, COLMAP (`pycolmap`) |

Each folder has its own README with setup, build and run instructions for Windows.

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
ARCore Cloud Anchors), which are planned and not implemented yet.

The doorway is not placed by hand: the user scans the room once, the server builds a map
and a simple plan of the room (floor, walls, corners) from the recording, finds a real door
opening in it and stores it. In later sessions the server recognises the room from a camera
frame and the virtual door is put into that same opening.

## Status (21 November 2026)

"On the phone" means a Xiaomi 14 Ultra (Android 16, ARCore 1.57).

| Part | State |
|---|---|
| AR scene with camera feed and 3D objects | Done, checked on the phone |
| Walk-through portal, AR ↔ VR switching | Done, checked on the phone with the first test room |
| Virtual space behind the door: atrium of the Sponza Palace (Dubrovnik) with a wooden door casing | Implemented; the models load on the phone without errors, the look has not been reviewed on the device yet |
| Phone ↔ server connection over Wi-Fi | Done, checked on the phone: automatic search and reconnection work; typing the address by hand has not been confirmed on the device |
| Localisation server: map building, `/localize`, evaluation | Done and tested on a public indoor dataset (TUM RGB-D `freiburg1_room`) |
| Room scan in the app (planes, depth mesh, recording, upload with progress) | Implemented; on the phone the depth mesh, the recording and the upload work, a full room scan has not been made yet |
| Room plan on the server (floor, walls, corners, door openings) and automatic doorway placement | Implemented and covered by tests on dataset and synthetic data; not yet run on a recording of a real room |
| Keeping the doorway in place (tracking loss, repeated localisation) | Implemented, not checked on the phone |
| Server monitoring panel and phone simulator | In progress |
| Ready-made localisation services | Not implemented (interface only) |
| Persistence tests (restart, angles, lighting, tracking loss) | Not started |

## Quick start

1. **Server** — on a Windows PC: follow [`localization-server/README.md`](localization-server/README.md)
   (install with `uv`, start the server, allow the port in the firewall). The server prints
   the addresses it can be reached at.
2. **App** — follow [`app/README.md`](app/README.md) to build the debug APK and install it on an
   ARCore-capable Android phone (a real device is required; emulators are not supported).
3. Put the phone and the PC on the same Wi-Fi, open the app and use the server status chip to
   find the server automatically or enter its address.

## Documents

- [`docs/research/tools-comparison.ru.md`](docs/research/tools-comparison.ru.md) — a survey (in Russian)
  of the tools considered for markerless persistent AR — visual positioning services, cloud anchors,
  on-device options, app frameworks, portal techniques — with the reasoning behind the chosen approach
  and a draft test protocol.
