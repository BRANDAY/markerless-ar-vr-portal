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

The doorway is placed once, not in every session. A staff member scans the room, the server
builds a map of it from the recording, and the staff member puts the virtual door where it
should stand and saves it on the server. In later sessions — on any phone, also one that
never scanned the room — the server recognises the room from a camera frame and the app
puts the door back at the saved place. The server also tries to find a real door opening in
the room and offers it as a suggestion; on the recordings tried so far it has not found one
reliably.

## Status (21 November 2026)

"On the phone" means a Xiaomi 14 Ultra (Android 16, ARCore 1.57).

| Part | State |
|---|---|
| AR scene with camera feed and 3D objects | Done, checked on the phone |
| Walk-through portal, AR ↔ VR switching | Done, checked on the phone with the first test room |
| Virtual space behind the door: atrium of the Sponza Palace (Dubrovnik) with a wooden door casing | Implemented; the models load on the phone without errors, the look has not been reviewed on the device yet |
| Phone ↔ server connection over Wi-Fi | Done, checked on the phone: automatic search and reconnection work; typing the address by hand has not been confirmed on the device |
| Localisation server: map building, `/localize`, evaluation | Done and tested on a public indoor dataset (TUM RGB-D `freiburg1_room`) |
| Room scan in the app (guided scan, depth mesh, recording, upload with progress) | Implemented; on the phone the depth mesh, the recording and the upload work, a full room scan has not been made yet |
| Two modes: staff (scan the room, place and save the door) and visitor (open the app, the door comes from the server) | Implemented and run end to end against the server with a phone simulator; not checked on the phone |
| Door stored once per room on the server and restored by recognition on any phone | Implemented; on the simulator a second "device" got the door 8.6 cm from where it was placed; not checked on the phone |
| Room plan on the server (floor, walls, corners) and a suggested door opening | Implemented; on the recordings tried so far the plan is often partial and no opening was found reliably, so it is only a suggestion to the staff member |
| Keeping the doorway in place (tracking loss, repeated localisation) | Implemented, not checked on the phone |
| Server monitoring panel and phone simulator | Done |
| Ready-made localisation services (ReactVision Advanced VPS, ARCore Cloud Anchors) | Studied from the documentation; provider code is written but was never run against the services (no paid account), and is not part of the main path |
| Full pass on a real phone in a real room (scan → map → door → restart → door in place) | Not done yet |
| Persistence tests (restart, angles, lighting, tracking loss) | Protocol written ([`app/docs/test-protocol.md`](app/docs/test-protocol.md)), tests not run yet |

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
