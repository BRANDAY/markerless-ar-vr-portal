# Interface specification

For the chat that builds `app/`. It describes the screens, their states and texts, and an order of work in
which every step leaves a usable app. Written on 21 November 2026 against the code and the server contract
of that day. "Vrata" is a working name.

- Clickable mockups of every screen: [mockups/index.html](mockups/index.html). Where this document and the
  mockups differ, this document wins.
- Why these features: [product-concept.md](product-concept.md). What others do: [competitors.md](competitors.md).

**Revision 2, 21 November 2026.** The owner decided: the app has two modes; a staff member places the door
and saves it to the server; a visitor's phone holds nothing but the app and gets the door and the room from
the server; ReactVision Advanced VPS is added as a second way to connect.

Steps 0–3 of the first revision are built (not yet seen on a phone). Points that need a device check are
marked **Check**.

## 1. Principles

1. **One amber button per screen.** It is the next sensible step. Everything else is quieter.
2. **Over the camera, almost nothing.** At most a close button, one label, one menu and one main control.
3. **One instruction at a time**, in words a visitor understands. No codes, coordinates or internal names.
4. **Every problem says what happened and offers one way forward.**
5. **The app does the technical steps itself.** The user never chooses a provider, starts a recording by
   hand or presses "upload".
6. **Everything technical lives in developer options**, off by default.
7. **Say only what is true.** Counters show what the phone actually knows. Times come from measurements.

## 2. Words

| Say | Meaning | Never show |
|---|---|---|
| door | the virtual door | portal, anchor |
| doorway | the real opening in the wall | opening, portal pose |
| room | a scanned place | map, map id |
| space | the virtual place behind the door | world, environment, scene |
| scan | walking the room with the camera | recording, capture, session |
| server | the PC that remembers rooms (host screens only; visitors never see the word) | provider, API, address unless asked |
| finding your room | working out where the phone is | localisation, relocalise, tracking, pose, VPS |

Sentence case everywhere. Buttons are verbs: "Open the door", "Scan this room", "Send again".

## 3. Visual language

### 3.1 Colour

Two meanings carry the whole interface:

- **Teal is the real room as the app understands it**: scan paint, the room plan, wall warnings.
- **Amber is the door and the main action**: the primary button, the doorway on the plan, rings to move to.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F4F6F9` | `#0C111A` | screen background |
| `surface` | `#FFFFFF` | `#151C28` | cards, sheets |
| `surface2` | `#E9EDF2` | `#1E2736` | icon tiles, notices, tracks |
| `ink` | `#131A26` | `#EEF2F8` | text |
| `ink2` | `#566074` | `#9AA6BA` | secondary text |
| `line` | `#D7DCE5` | `#2A3445` | borders, dividers |
| `amber` | `#FFB23E` | `#FFB84D` | primary button fill, doorway |
| `amberInk` | `#2A1A00` | `#2A1A00` | text on amber |
| `amberText` | `#8F5400` | `#FFC873` | amber used as text or icon |
| `amberSoft` | `#FFF0D6` | `#3A2A10` | selected option, amber tile |
| `teal` | `#0B8580` | `#3FD0C6` | plan lines, "ready", switches |
| `tealSoft` | `#D8F0EE` | `#12363A` | plan fill, teal tile |
| `danger` | `#C2352B` | `#FF7A6E` | problems |
| `dangerSoft` | `#FBE4E1` | `#3B1A18` | problem tile |
| `ok` | `#1B7F45` | `#5AD08A` | connected dot |

Screens over the camera have one look in both themes, because they sit on live video:

| Token | Value | Use |
|---|---|---|
| `hudBg` | `rgba(9,13,21,0.66)` | pills, coach card, round buttons |
| `hudFg` | `#FFFFFF` | text and icons |
| `hudDim` | `rgba(255,255,255,0.72)` | second line |
| `hudLine` | `rgba(255,255,255,0.16)` | hairline border |
| `scan` | `#3FE0D4` | scan paint, wall warning grid |
| `door` | `#FFB84D` | doorway outline, rings |
| `hudDanger` | `rgba(120,30,22,0.82)` | "lost track" banner |

The mockups blur the video behind HUD elements. Plain React Native has no blur without an extra native
module; the solid translucent fill alone is acceptable.

The app follows the phone's light or dark setting. A manual switch is not needed in version 1.

### 3.2 Type

| Role | Face | Size / line | Weight |
|---|---|---|---|
| Screen title | Bricolage Grotesque | 28 / 31 | 700 |
| Sheet or card title | Bricolage Grotesque | 21 / 24 | 700 |
| Body | Inter | 15 / 21 | 400 |
| Button | Inter | 16 | 600 |
| Row title | Inter | 15 | 600 |
| Small | Inter | 13 / 18 | 400 |
| Eyebrow | Inter | 11.5, uppercase, letter-spacing 0.08 em | 600 |
| Numbers that change (timer, percent, sizes) | Inter with tabular figures | — | — |
| Developer overlay | system monospace | 11 | 500 |

Both faces are on Google Fonts under an open licence; confirm the licence text when bundling. If bundling
fonts is postponed, the system font is an acceptable stand-in with the same sizes.

### 3.3 Shape, size, icons

- Buttons 54 high, corner radius 16. Cards radius 20. Sheets radius 26 on the top corners. Pills fully round.
- Touch targets at least 44 × 44. Round HUD buttons are 44, shutter 68.
- Screen padding 20. Use the real safe-area insets, not the fixed 44 / 28 the overlay uses today.
- Icons are outline, 1.8 stroke, round ends, 22 in size. The mockups draw their own; any open outline set
  with the same weight will do. One set only.
- Motion: 200–300 ms fades. The door fades in over 300 ms once confirmed. No bouncing.

### 3.4 What is drawn in the camera view

| Thing | Today | Target |
|---|---|---|
| Walls while scanning | cyan fill `#22d3ee` α 0.30 | `scan` fill α 0.20 with a thin `scan` edge |
| Floor while scanning | green fill | `scan` dot grid, no fill |
| Ceiling and other surfaces | violet and yellow fills | not painted |
| Corners | red-pink cubes with posts | small white dot with a `scan` ring at floor level |
| Depth mesh | engine wireframe behind a debug button | on during scanning, thin `scan` lines. It carries the feedback when no wall planes are found |
| Server room plan in AR (orange walls, white openings) | "Plan" toggle | developer option only. Users see the plan as a 2D drawing on the room result screen |
| Orange box and blue sphere near the origin | always | removed (developer option) |
| Door before its place is confirmed | shown at once, marked "not confirmed" in text | first placement in a session: an amber dashed outline of the doorway only. The door and the space fade in when the place is confirmed. **Check** |
| Door, confirmed | wooden casing sized to the opening | unchanged |
| AR / VR badge | always | removed (developer option) |
| Real walls while inside the space | nothing | `scan` grid on a real wall when the phone is within 0.6 m of it, full strength at 0.3 m. Drawn from the room plan the server returns with the position. **Check** that it can be drawn inside the portal's inner scene |
| Way back | nothing | "Door is behind you" pill when the door is outside the view |

## 4. Screen map

```mermaid
flowchart TD
  start([App start]) --> first{First run?}
  first -- yes --> welcome[Welcome 1-3] --> permission[Camera permission] --> connect[Find the server]
  first -- no --> mode{Visitor mode on?}
  mode -- yes --> visitor[Visitor welcome]
  mode -- no --> home[Home]
  connect --> home
  connect -- "Try a door without a server" --> ar
  home -- "Open the door" --> ar[AR: finding the room]
  visitor -- Start --> ar
  home -- "Scan this room" --> prepare[Before you scan] --> scan[Scanning] --> build[Building the map] --> result[Room and doorway]
  result -- "Use this doorway" --> ar
  result -- "Scan again" --> prepare
  ar --> door[AR: door in the room] <--> inside[Inside the space]
  home --> spaces[Spaces]
  home --> rooms[Rooms]
  home --> settings[Settings]
  door -- space label --> spaces
  settings --> connect
  settings -- "Visitor mode" --> visitor
  ar -. problem .-> problems[Problem screens]
  build -. failure .-> problems
```

### 4.1 Navigation without a navigation library

The app has no navigation library, and one is not needed. Add a `screen` value to the app store:

`welcome | permission | connect | home | scanPrepare | scan | build | roomResult | placeDoor | ar | spaces | rooms | settings | visitor | problem`

- `ar` covers three situations of one screen: finding the room, door in the room, inside the space. They are
  derived from the localisation status and the existing AR / VR mode, not separate screens.
- `problem` carries a `kind` (section 7).
- The AR view (`ViroARSceneNavigator`) is mounted only on `scan` and `ar`. Other screens are plain React
  Native views. **Check**: remounting the AR view restarts the AR session; if that proves unstable on the
  phone, keep it mounted and cover it with an opaque screen.
- A new AR session needs a new `session_id` for the server, as the server contract says.

Android back button:

| On | Back does |
|---|---|
| Home, Visitor welcome | leaves the app |
| Scanning | asks "Stop scanning? The scan will be discarded." with "Keep scanning" / "Stop" |
| Building | goes Home; the build continues |
| AR | goes Home (Visitor welcome in visitor mode) |
| A sheet or menu | closes it |
| Anything else | goes to the previous screen |

### 4.2 What is remembered between launches

New file next to the existing `server-connection.json` and `device-id.json`:

| Key | Purpose |
|---|---|
| `onboardingDone` | welcome cards shown once |
| `visitorMode`, `pinHash` | visitor mode and its PIN |
| `developerOptions` | developer options switched on |
| `lastRoomId` | room to try first |
| `spaceByRoom` | chosen space per room, until the server stores it |
| `lastCapture` | folder of the newest scan, so "Send again" survives a restart |
| `language` | chosen language, else the phone's |

### 4.3 Two modes

Decided by the owner on 21 November 2026. The app is always in one of two modes.

| | Visitor mode | Staff mode |
|---|---|---|
| Who | a member of the public | venue staff |
| A fresh install starts in | this mode | — |
| Sees | one screen: the camera, the door, the space | Home, scanning, placing the door, rooms, spaces, settings |
| Where the door comes from | only from the server: the place a staff member saved | the staff member puts it there and saves it |
| Can change anything | no | yes |
| How to get in | "Switch to visitor mode" in Settings | the lock on the visitor screen, then the staff PIN |

Rules:

- At start the app finds the room through the server, or through the cloud service chosen in Settings. It
  never starts with a door that is simply put in front of the camera. That kind of door exists only in the
  developer tools, labelled "Not tied to the room".
- In visitor mode the phone holds nothing but the app. The room map, the room plan and the door come from
  the server.
- A visitor sees a door only where a staff member saved one (`portal.source` is `manual` or `selected`).
  A doorway the server found by itself (`auto`) is a suggestion for staff and is never shown to visitors.
- Closing and reopening the app keeps the mode.

Staff PIN:

| Situation | Sheet |
|---|---|
| First use of the lock on this device | Title **Create a staff PIN**. Body "Four digits. You will need it to change anything on this device." Then **Enter it again**. Mismatch: "The PINs don't match. Try again." |
| Later | Title **Staff only**. Body "Enter the staff PIN." Four dots, a number pad, **Cancel** |
| Wrong PIN | "Wrong PIN" under the dots. After 5 wrong tries: "Try again in 30 seconds." |
| First time in staff mode | the welcome cards (5.1), then Find the server (5.3), then Home |

The PIN is kept on the device as a hash (the existing `pinHash`). Until the server keeps the PIN (S10 in
section 9), anyone who installs the app on their own phone can create a PIN and enter staff mode. That is
acceptable while the venue lends the devices. It has to be closed before visitors use their own phones.

## 5. Screens

Element order is top to bottom. Texts are final unless marked.

### 5.1 Welcome (`welcome`)

Shown once, the first time staff mode is opened on a device. Visitors never see it. Three cards, swipe or
"Continue".

| Card | Title | Body |
|---|---|---|
| 1 | A door to somewhere else | Vrata puts a virtual door into a real room. Walk through it and you are standing in another place. |
| 2 | Scan the room, place the door | Walk around the room for about two minutes, then put the door where you want it. You do this once. |
| 3 | Visitors just open the app | The door comes from the server and stands in the same place for everyone. No markers, and nothing for a visitor to set up. |

Buttons: **Continue** (card 3: **Get started**), text button **Skip**. Both lead to Find the server (5.3).
The camera is usually allowed already at this point, because the visitor screen asked for it. If it is not,
the permission screen (5.2) comes first.

### 5.2 Camera permission (`permission`)

- Title: **Vrata needs your camera**. Body: "The camera shows the room and keeps the door in its place."
- Three lines with icons:
  - "When you scan a room, a short video of it goes to the Vrata server on this Wi‑Fi. It is used only to
    build the room map."
  - "Nothing leaves this network. No account, no ads."
  - "You can delete a room and its video at any time."
- **Allow camera** opens the Android dialog. Granted: go on to `connect`.
- **Not now**, or a refusal: problem `camera`.
- The third line may ship only when the server can delete a room (section 9, S1). Until then leave it out.
- The existing permission logic (retry, re-check on return to the app, "blocked" state) stays.

### 5.3 Find the server (`connect`)

Starts searching at once. Reuses the existing connection states.

| State (existing) | Title | Body | Buttons |
|---|---|---|---|
| `searching`, `connecting` | Looking for a Vrata server | Checking this Wi‑Fi. This can take up to a minute. | ghost **Enter address instead**; text **Try a door without a server** |
| one server found | Found “{server_name}” | A Vrata server on this Wi‑Fi with {n} scanned rooms. (n = 0: "…with no rooms yet.") | primary **Connect** |
| several found | Choose a server | list of names | tap a row |
| none found | No server on this Wi‑Fi | Vrata keeps a door in place with the help of a server on the same network. Then two checks: "Is the server PC switched on and Vrata Server running?" / "Is this phone on the same Wi‑Fi (not mobile data, not a guest network)?" | primary **Search again**; ghost **Enter address**; text **Try a door without a server** |
| phone not on Wi‑Fi | Connect this phone to Wi‑Fi | Vrata reaches the server over Wi‑Fi, not mobile data. | primary **Search again** |
| `incompatible` | This server needs an update | The app and the server are different versions. Update both. | primary **Search again** |

- "Enter address" opens a sheet with one field (label "Server address", hint "for example 192.168.1.20") and
  **Connect**. The existing validation messages stay.
- After the first successful connection the app reconnects silently at launch, as today.
- "Try a door without a server" switches to the manual placement provider and opens `ar`.

### 5.4 Home (`home`)

Top row: app name; server chip; settings icon.

Server chip:

| State | Chip |
|---|---|
| connected | green dot + server name |
| searching, connecting | amber dot + "Connecting…" |
| unreachable | red dot + "Server offline" |
| not set up | grey dot + "No server" |

Tapping the chip opens Settings.

| Situation | Content | Primary | Secondary |
|---|---|---|---|
| Room ready | Card "THIS ROOM": tag "Ready", plan drawing, room name, "Scanned {date} · doorway {w} × {h} m", arrow to Rooms. Row "BEHIND THE DOOR": thumbnail, space name, "Change" | **Open the door** | text **Scan another room** |
| No room on the server | Card: "No room here yet" / "Scan this room once and Vrata will remember where its doorway is. It takes about two minutes of walking." | **Scan this room** | text **Try a door without scanning** |
| A build is running | Card with room name, "Building the map · {p}%" | **See progress** | — |
| Server offline, rooms known | Room card dimmed, line "The server is offline. Vrata needs it to find the door." | **Search again** | text **Try a door without a server** |
| No server set up | Card "Not connected" / "Vrata keeps a door in place with the help of a server on the same Wi‑Fi." | **Find the server** | text **Try a door without a server** |

Plan drawing: walls as `teal` lines on `tealSoft`, corners as dots, the chosen doorway as a thick `amber`
segment, other doorways grey. Data: `GET /maps/{id}/room`. If no plan exists, show a door icon instead.

### 5.5 Before you scan (`scanPrepare`)

- Top bar: back, "Scan a room". Title: **Before you start**.
- Three rows:
  - **Turn on the lights** / "A bright room scans better."
  - **Keep the doorway clear** / "Nothing standing in it. Open or closed is fine."
  - **Clear a path along the walls** / "You will walk around the room, not just turn."
- Notice: "About 2 minutes of scanning, then 3–15 minutes while the server builds the map. You can use the
  phone meanwhile." Replace the second range with measured values once real builds exist.
- If the room is new: a field "Room name" (default "Room 1"). It becomes the `label` and, made safe, the
  `map_id`.
- Primary: **Start scanning**.
- In host mode add a line: "Scan when no visitors are in the room. The video is stored on the server."

### 5.6 Scanning (`scan`)

One flow replaces "Scan room", "Record" and "Upload". On entry the app switches world mesh on, waits for
tracking, then starts the recording by itself. It does not toggle scanning again during the flow, because
toggling drops the detected planes.

Layout: close button (top left); timer pill with a red dot (top right); coach card; three counters; one
button.

Coach card. Warnings replace the step text while they apply:

| Condition | Line 1 | Line 2 |
|---|---|---|
| tracking not ready yet | Getting ready… | Move the phone a little. |
| tracking limited: excessive motion | Slow down | Vrata can't follow fast movement. |
| tracking limited: insufficient light | It's too dark here | Turn on more lights. |
| tracking limited: insufficient features | Point at something with detail | Plain walls are hard to follow. |
| step 1 | Walk slowly along the walls | Point at where the wall meets the floor. |
| step 2 | Now show the doorway | Step back until all of it fits, then look at it from a second spot. |
| step 3 | That’s enough | Keep going for a better map, or finish now. |

Steps:

| Step | Starts when | Button |
|---|---|---|
| 1 Walls | recording starts | disabled, "Keep going · {s} s" counting down to 60 s |
| 2 Doorway | 60 s passed, floor found, at least 6 m walked | ghost **I showed the doorway** |
| 3 Can finish | user confirmed | primary **Finish scan** |

- In step 2, amber corner brackets frame the middle of the view as an aiming aid. The phone cannot detect a
  doorway; the server does that later. The user confirms.
- If the 60 s have passed but floor or distance is missing, the coach says "Keep walking along the walls".
- At 150 s the coach says "You can finish now". At 180 s the scan finishes by itself.
- Counters: "Floor ✓ found" (a horizontal plane exists), "{n} walls found" (vertical planes; hide this counter
  if none appear within 20 s), "{d} m walked" (path length from camera poses).
- Close asks "Stop scanning? The scan will be discarded." with **Keep scanning** / **Stop**.
- **Finish scan** stops the recording, saves, and goes to `build`, which starts the upload at once.

The 60 s, 6 m and 180 s values are starting points taken from the server's recording advice (60–120 s of
walking). Adjust after real scans.

### 5.7 Building the map (`build`)

- Top bar: room name; close (goes Home, the build continues).
- Title **Building your room**; under it the time line; a ring with one percentage; five steps; a notice;
  text button **Cancel**.

One percentage for upload and build together: `8 × uploadFraction`, then `8 + 92 × job.progress`.

| Step shown | Covers | Marked done at |
|---|---|---|
| Sending the scan · {N} MB | upload | upload complete (8%) |
| Reading the scan | server stages `frames`, `features` | 17% |
| Building the 3D map | `matching`, `sfm` | 82% |
| Measuring the room | `depth` | 89% |
| Finding the doorway | `room_plan`, `finalize` | 100% |

Time line:

| Situation | Text |
|---|---|
| uploading | Sending {p}% of {N} MB |
| queued | Waiting for the server · {n} ahead |
| running, `eta_s` known | About {m} minutes left (under 60 s: "Less than a minute left") |
| running, no estimate | Step {i} of 5 |
| lost contact, still retrying | Lost contact with the server. Trying again… |

- Notice: "You can leave this screen. Vrata will tell you when the room is ready." Until notifications exist:
  "You can leave this screen and come back."
- **Cancel** asks "Stop building this room?" with **Keep building** / **Stop**, then cancels the upload or the job.
- Success: title **The map is ready**, line "Built in {time} from {n} frames.", primary **See the room**.
- Failure: problem screen (section 7.2). The scan stays on the phone.

### 5.8 Room result (`roomResult`)

Shows what the server understood about the room, then sends the staff member on to place the door. Staff
mode only.

- Top bar: back, "Your room". Plan drawing with wall lengths and a 1 m scale bar. Doorways the server found
  are marked in amber with letters.

| Server result | Title | Body |
|---|---|---|
| plan with one doorway | The room is ready | Vrata found a doorway, {w} × {h} m. You can put the door in it or anywhere else in the room. |
| plan with two or three doorways | The room is ready | Vrata found {n} doorways. You can put the door in one of them or anywhere else in the room. |
| plan, no doorway | The room is ready | Next, put the door where you want it. |
| no plan (`room.status` is `unavailable`) | The room is ready | The room's shape could not be measured, so there is no drawing. The door will still stay where you put it. |

- Primary button in every case: **Place the door**. It opens 5.14.
- Text button: **Scan again**.
- A found doorway is a suggestion. Nothing is saved on this screen.
- Openings with `height_measured: false` show the width only.

### 5.9 AR screen (`ar`)

#### Finding the room

Close button (top left); room name pill (top right). The door is not shown.

| Existing status / attempt | Coach line 1 | Line 2 | Extra |
|---|---|---|---|
| `waiting-for-tracking` | Getting ready… | Move the phone a little. | |
| `localizing`, attempt 1 | Point at the room and hold still | Finding your room… | |
| attempts 2–3 | Try another view | Aim at furniture, shelves or pictures, not a bare wall. Hold still. | |
| attempts 4–5 | Still looking | Turn on more lights, or stand where you stood during the scan. | ghost **This is a different room** |
| retry reason "scale not known yet" | Take a step sideways | Then hold still again. | |
| weak match, first placement | (keep the current line) | Checking the door’s position… | amber dashed outline at the doorway |
| `localized` | — | — | the door fades in; hint "Walk through the door" for 5 s |
| `error` after the attempts | sheet, problem `unknown` | | |
| `waiting-for-server` | problem `server` | | |
| server has no room | go Home, "No room here yet" | | |

Tracking warnings from section 5.6 replace the coach line while they apply.

In visitor mode, "This is a different room" is replaced by "Ask a member of staff".

#### Door in the room

- Top: close; space name pill (opens Spaces; hidden in visitor mode); menu button.
- Bottom: hint pill "Walk through the door" (fades after 5 s); shutter button.
- Menu sheet: **Find the door again** / "If it has slipped out of the doorway" (the existing "Re-localize");
  **Change the space**; **Use another doorway**. In visitor mode only the first item.
- Shutter: takes a photo of the view without the interface, saves it, then shows a small preview with
  **Share** for 4 s. Uses the AR view's screenshot call. **Check**.

Small states, shown as a pill under the top row, never as a blocking screen:

| Situation | Pill |
|---|---|
| position not confirmed after the checks | The door may be slightly off · **Find again** |
| server offline while a door is standing | Server offline · the door stays where it is |
| tracking lost | red banner: "Lost track of the room" / "Move the phone slowly over furniture or pictures." The door stays, dimmed |
| tracking back | banner disappears; the existing confirm check runs |

#### Inside the space

- Top: pill "Door is behind you" with a turn-back arrow, only when the door is outside the view; info button.
- Bottom: shutter.
- Info sheet "About this place": eyebrow (place and date), name, one paragraph, credit line, **Close**.
- Wall warning: coach "A real wall is close" / "The grid shows where your room ends." with the teal grid.
- Version 1.x: amber rings on the floor and the hint "Tap a ring to move further in".
- The existing rule stays: a door correction that arrives while the user is inside waits until they are out.

#### Developer overlay

With developer options on, the AR screen also shows one line of small monospace text above the bottom
controls: tracking state, provider, match quality, inliers, time, door size and confidence. The existing
status panel and event log move to a "Diagnostics" screen opened from Settings.

### 5.10 Spaces (`spaces`)

- Top bar: back, "Spaces". Filter chips: All, Heritage, 360° views (only if more than six spaces).
- Card: thumbnail, name, "{place} · walk-in 3D / 360° view · {size} MB", and one of: tag "Behind your door",
  a download button, or "On this phone".
- Tapping a card opens a sheet: picture, eyebrow (place and date), name, two sentences, a line
  "{size} MB · on this phone · {credit and licence}", primary **Put behind my door**, text **Close**.
- A notice at the bottom of the list: "Walk-in spaces have depth: you can step inside and look around
  corners. 360° views surround you but stay flat."
- Data: a list in the app for the built-in spaces (id, name, place, date, type, size, description, credit,
  thumbnail). The test room is developer-only.
- The chosen space is stored per room.

### 5.11 Rooms (`rooms`)

- Top bar: back, "Rooms". One row per room on the server: icon tile, name, state line, a menu button.

| State | Line | Tile |
|---|---|---|
| ready | Ready · {n} doorway(s) · {space name} | teal |
| building | Building the map · {p}% (tap opens `build`) | amber |
| failed to be found three sessions in a row | Scan again · the room has changed | red |
| no doorway | No doorway · scan again or place the door | red |

- Row menu: **Change doorway**, **Change the space**, **Scan again**, **Rename**, **Delete**.
- Delete asks: "Delete “{name}”? Its map and video are removed from the server. This can’t be undone."
  with **Delete** / **Keep**.
- Footer: "Rooms live on the server “{server_name}”. Every phone that connects to it sees the same rooms."
- Primary: **Scan a new room**.
- Rename and Delete need server work (S1, S2). Hide them until it exists.
- Data: `GET /maps`.

### 5.12 Settings (`settings`)

| Row | Value / action |
|---|---|
| Server | dot + "{server_name} · connected"; opens `connect` |
| Find servers automatically | switch |
| Visitor mode | "Hide setup behind a PIN"; switch; asks for a new 4-digit PIN when turned on |
| Language | current language; opens a list |
| Privacy and data | a page with the three statements from 5.2 and a link to Rooms for deleting |
| Credits and licences | spaces (model, author, licence) and software notices |
| How it works | reopens the welcome cards |
| Version line | "Vrata {version}"; seven taps switch developer options on |

Developer options (visible only when on): Diagnostics on the AR screen; Localisation provider
(self-hosted / manual); Door frame (casing / simple); Attach mode; Room plan in AR; Mesh lines; Test room;
Test objects; Event log; Save mesh; Turn developer options off.

### 5.13 Visitor screen (`visitor`)

The whole of visitor mode is this one screen. It is the AR view, with a welcome panel in front of it on the
first launch. No scanning, no placing, no settings, no Home.

Launch:

| Launch | What happens |
|---|---|
| First launch, or the camera is not allowed yet | the welcome panel |
| Every later launch | the camera opens at once and the app starts looking for the door. No button to press |

Welcome panel (plain background, both themes):

- Top: venue name, once the server is known (the server's name); a small lock icon on the right.
- Door drawing. Title **Step through the door**. Body "Point the phone at the room. A door will appear.
  Walk through it."
- Notice: "Walk slowly and mind the people around you. The app shows you where the real walls are."
  The second sentence appears only once the wall warning exists.
- Primary **Start**. It asks Android for the camera and then shows the camera.
- Small line under the button, by connection method (5.12). Own server: "To find the door, the camera
  picture is sent to this venue's server." Cloud service: "To find the door, the app compares the camera
  picture with a map of this room."
- Language chips at the bottom, once more than one language exists.

Over the camera, in order of appearance:

| Situation | Coach line 1 | Line 2 |
|---|---|---|
| looking for the server, loading the room | One moment… | Getting the door for this room. |
| camera not ready | Getting ready… | Move the phone a little. |
| first try | Point at the room and hold still | Looking for the door… |
| tries 2–3 | Try another view | Aim at furniture, shelves or pictures, not a bare wall. Hold still. |
| tries 4–5 | Still looking | Move to the middle of the room and try again. |
| door placed | — | hint pill "Walk through the door" for 5 s |

Tracking warnings (5.6) replace the coach line while they apply.

Controls over the camera: a help button (top right) that brings the welcome panel back, and the shutter
once photos exist. Nothing else. The lock is on the welcome panel only. Inside the space the visitor gets
the same as staff: "Door is behind you", the info button, the wall warning.

When it does not work, a sheet appears over the camera. Every sheet has one button, **Try again**, unless
the table says otherwise, and a small grey reason line that a staff member can read at a glance:

| Trigger | Title | Body | Reason line |
|---|---|---|---|
| no server found, or it stopped answering | The door isn't ready | Please ask a member of staff. | No server on this Wi‑Fi |
| phone not on Wi‑Fi | Connect to the venue's Wi‑Fi | The door works only on the venue's Wi‑Fi. A member of staff can help. | Not on Wi‑Fi |
| app and server versions differ | The door isn't ready | Please ask a member of staff. | The app and the server are different versions |
| no room on the server, or no room with a saved door | The door isn't ready | Please ask a member of staff. | No door has been placed yet |
| room not recognised after the tries | Can't find the door from here | Stand in the room with the door and point the phone at it. If it still doesn't appear, please ask a member of staff. | Room not recognised |
| camera refused | The camera is off | The door can't be shown without the camera. Button: **Open phone settings** | — |
| phone cannot run AR | This phone can't show the door | Please ask a member of staff for a device. No button | — |

Tracking loss shows the red banner of 7.3 and clears by itself.

In visitor mode the provider is always the server (or the chosen cloud service). The developer tools, the
menu, "Find the door again", "Change the space" and every staff action are absent. A door correction from
the server is applied the same way as in staff mode.

Leaving visitor mode: the lock icon on the welcome panel, then the staff PIN (4.3).

### 5.14 Place the door (`placeDoor`)

The main way a door gets its place. A staff member puts the door where it should stand and saves it to the
server. This is done once per room; visitors then get the door from the server. Staff mode only.

Reached from: Room result (**Place the door**), the Rooms row menu and the staff AR menu (**Move the door**).

Before the door can be saved the app must have found the room in this AR session, because the server
converts the door's place through that. So the screen opens like the AR screen:

| Situation | Coach line 1 | Line 2 |
|---|---|---|
| finding the room | Point at the room and hold still | Finding your room… (then the texts of 5.9 for later tries) |
| found; the room already has a saved door | Move the door | It stands where it was saved. Put it somewhere else, or adjust it. |
| found; the server suggests a doorway | Vrata found a doorway | The door is standing in it. Save it, or move it. |
| found; no suggestion | Put the door where you want it | Aim at a spot on the floor and tap Put it here. |

Where the door first appears: at the saved place if there is one; else in the doorway the server suggests;
else on the floor 2 m in front of the camera, facing it.

Layout over the camera:

- Top: close button; pill "{room name}".
- A small cross in the middle of the view marks the spot on the floor the phone is aimed at.
- The door is drawn as it will look to visitors, with an amber outline on the floor under it and a short
  amber arrow on the floor pointing from the room into the space.
- Bottom, three controls: ghost **Put it here**; ghost **Adjust**; primary **Save door**.

| Control | Does |
|---|---|
| **Put it here** | moves the door to the aimed spot on the floor, turned to face the camera. The side the staff member stands on is the room side |
| **Adjust** | opens the adjust panel in place of the two ghost buttons |
| **Save door** | saves (below). Disabled, with the label "Finding your room…", until the room is found |

Adjust panel:

| Row | Controls | Step |
|---|---|---|
| Move | ← → (along the door), ↑ ↓ (away from the room, towards the room) | 5 cm per tap; holding repeats |
| Turn | ⟲ ⟳, and **Turn around** | 5° per tap; Turn around is 180° |
| Width | − {w} m + | 5 cm, from 0.60 to 1.40 m |
| Height | − {h} m + | 5 cm, from 1.80 to 2.40 m |
| only if the server suggests a doorway | **Use the found doorway**; with several, each tap goes to the next one | — |
| | **Done** closes the panel | — |

- Size starts at the suggested doorway's size, else 0.90 × 2.00 m.
- The door always stands on the floor. There is no up or down control.
- A readout above the panel shows the current size: "0.85 × 2.05 m".

Saving:

- **Save door** sends the door's place in the current AR session, with the same `session_id` that found the
  room: `PUT /maps/{id}/anchors/portal` with `ar_pose`, `session_id`, `width` and `height`.
- While sending, the button reads "Saving…".
- Saved: a sheet. Title **Door saved**. Body "Every phone that opens this room will see the door here."
  Primary **See it as a visitor** (switches to visitor mode). Text button **Done** (goes Home).
- Failed: a sheet. Title **The door wasn't saved**. Body "The server did not answer. The door is still here.
  Try again." Primary **Try again**; text **Not now**.
- Closing without saving after a change asks "Leave without saving? The door stays where it was." with
  **Keep editing** / **Leave**.

Until the server stores `width` and `height` with a saved door (S11), other phones draw it 0.90 × 2.00 m.
Hide the Width and Height rows until then.

Move and remove, for a room that already has a saved door:

| Action | Where | What happens |
|---|---|---|
| **Move the door** | Rooms row menu; staff AR menu | opens this screen with the door at its saved place |
| **Remove the door** | Rooms row menu; staff AR menu | asks "Remove the door from “{room name}”? Visitors will not see a door in this room until you place a new one." with **Remove** / **Keep**. Removes the saved place on the server (`DELETE /maps/{id}/anchors/portal`, and the doorway choice set back to automatic). The room then counts as having no door |

**Check** on the phone: saving right after the map is built, in a fresh AR session; the door's place after
the app is closed and opened on a second phone.

## 6. Where today's controls go

| Today | Becomes |
|---|---|
| "Grant camera access" gate | Permission screen (5.2) |
| Server chip and "Localization server" window | Home chip, `connect` screen, Settings row |
| `Debug` / `Hide debug` | developer options |
| `AR` / `VR` badge | removed; developer overlay |
| Status panel (tracking, camera, floor, provider, door) | Diagnostics, developer only |
| Event log, `Hide log`, `Clear log` | Diagnostics, developer only |
| `Re-localize` / `Re-place door` | "Find the door again" in the AR menu, and "Find again" in the pill |
| `Provider: manual / self-hosted` | chosen by the app: self-hosted when a server and a room exist, manual for "Try a door without a server". Manual switch in developer options |
| `World: sponza / test-room` | Spaces screen |
| `Frame: casing / simple`, `Attach: direct / parent` | developer options |
| `Scan room`, `Record`, `Upload as "room"`, `Cancel` | the guided scan (5.5–5.8) |
| `Plan: on / off`, `Mesh lines`, `Save mesh`, `Reset mesh` | developer options |
| Status banner "Starting / Waiting for the server / Looking for the room / Check the doorway / Cannot place the doorway" | coach card, pills and problem screens (5.9, 7) |

## 7. Problems

A problem is a full screen when the user cannot continue, and a sheet or banner over the camera when the
camera should stay on. Layout of a full screen: back; red icon tile; title; body; an optional tip; one
primary button; one text button.

### 7.1 Before or outside AR

| Kind | Trigger | Title | Body | Primary | Secondary |
|---|---|---|---|---|---|
| `camera` | permission refused or blocked | The camera is off | Vrata can’t show a door without the camera. Allow it in the phone settings. | **Open phone settings** | — |
| `device` | ARCore not supported | This phone can’t show AR | Vrata needs Google Play Services for AR, and this phone does not support it. | **See supported phones** | — |
| `server` | unreachable where the server is needed | Can’t reach the server | “{server_name}” is not answering. Your phone and the server must be on the same Wi‑Fi. Small line: "The door needs the server only to find its place. A door that is already standing keeps working." | **Search again** | **Connection settings** |
| `wifi` | phone not on Wi‑Fi | Connect this phone to Wi‑Fi | Vrata reaches the server over Wi‑Fi, not mobile data. | **Search again** | — |
| `version` | `incompatible` | This server needs an update | The app and the server are different versions. Update both. | **Search again** | — |

### 7.2 Scan and build

The scan stays on the phone in every case. "Send again" uploads the same scan.

| Trigger | Title | Body | Primary | Secondary |
|---|---|---|---|---|
| upload interrupted | Upload stopped | The scan is saved on this phone. Check the Wi‑Fi and send it again. | **Send again** | **Not now** |
| upload refused, too large (413) | The scan is too large | Scan again and finish within 3 minutes. | **Scan again** | — |
| a build for this room is already running (409) | — | open `build` for that job | | |
| `too_few_frames` | The scan was too short | Walk for at least a minute, slowly, and pass every wall. | **Scan again** | **Not now** |
| `sfm_failed` | This scan didn’t work | The server could not build a map from it. This happens when the walk was too fast or the walls are very plain. Tip: "Walk for at least a minute, slowly, and pass every wall." | **Scan again** | **Not now** |
| `bad_recording` | This scan can’t be read | Something went wrong while recording. Please scan the room again. | **Scan again** | — |
| `out_of_memory` | The server ran out of memory | Close other programs on the server PC, then send the scan again. | **Send again** | **Not now** |
| `server_restarted` | The server was restarted | The scan is still on this phone. | **Send again** | — |
| `internal`, anything else | Something went wrong on the server | The scan is still on this phone. Try sending it again. | **Send again** | **Scan again** |
| contact lost for 8 checks in a row | Can’t reach the server | The build may still finish. Come back when the phone is on the Wi‑Fi again. | **Search again** | — |

The server's `error.code` and `message` go to the device log, not to the screen.

### 7.3 In AR

| Kind | Trigger | Form | Text | Actions |
|---|---|---|---|---|
| `unknown` | room not recognised after the attempts | sheet | **This doesn’t look like {room name}** / "Vrata could not match what the camera sees to the scan. If the furniture or the light has changed a lot, a new scan helps." | **Keep looking**; **Choose another room**; **Scan this room** |
| `tracking` | tracking lost for more than 1.5 s | red banner | **Lost track of the room** / "Move the phone slowly over furniture or pictures." | none; clears by itself |
| not confirmed | weak matches only | pill | The door may be slightly off | **Find again** |
| no doorway | server has a room without a doorway | sheet | **This room has no doorway yet** / "Scan it again and look at the whole doorway from two spots." | **Scan again**; **Place the door by hand** |

In visitor mode the actions of `unknown` and "no doorway" are replaced by one line: "Please ask a member of staff."

## 8. Technical notes for the app chat

- No navigation library is required (4.1). No state library is required; extend the existing stores.
- Put colours, type sizes and spacing in one theme file, and shared pieces (button, pill, sheet, row, coach
  card) in `ui/`. Button styles are copied across three files today.
- Move every user-facing text into one dictionary file per language, keyed by name. A small lookup function
  is enough; no library is needed.
- Additions that need a native rebuild, each optional and replaceable:
  - safe-area insets;
  - bundled fonts (3.2);
  - vector drawing for the plan and the progress ring. A plan can also be drawn with rotated thin views,
    and the ring replaced by a bar, if a drawing module is unwelcome;
  - saving to the gallery and the share sheet, for photos;
  - local notifications, for "room is ready".
- The app sends requests over plain HTTP on the local network. That stays for version 1.
- Keep the 85 unit tests green. New pure logic worth testing: the percentage and step mapping (5.7), the
  scan step conditions (5.6), the status-to-text mapping (5.9, 7).

## 9. What the server needs (for the server chat)

Listed here so both chats see the same picture. None of it is part of the app work.

| Id | Need | Used by |
|---|---|---|
| S1 | Delete a room: map, frames and the stored recording | Rooms, the privacy statement |
| S2 | Rename a room (change its label) | Rooms |
| S3 | Refuse a too-short recording at upload, with its own error code | 7.2 |
| S4 | Stop exposing the maps folder path in `/health` | privacy |
| S5 | Store the chosen space with the room, so all phones show the same one | Spaces, visitor mode |
| S6 | Tell which of several rooms a frame belongs to, without the room being named | several rooms |
| S7 | A list of downloadable spaces and their files | Spaces, version 1.x |
| S8 | An installer and a start icon for a non-developer | selling to venues |
| S9 | A rule for how long recordings and device logs are kept | privacy |

## 10. Order of work

Each step ends with an app that can be installed and used. The check line says what to look at on the phone.

| Step | What | Needs | Check on the phone |
|---|---|---|---|
| 0 | Theme file, shared pieces, text dictionary, `screen` state, developer-options flag. Debug overlay off by default; test objects and the AR / VR badge hidden | — | The AR screen shows the camera, a close button and nothing else until the door is found. Seven taps bring the old controls back |
| 1 | AR screen: coach card for finding the room, pills, "lost track" banner, menu with "Find the door again", problem sheet `unknown`. Provider chosen by the app | 0 | From launch to a door with no technical words on screen. Cover the camera: the banner appears and clears |
| 2 | Home, Settings, `connect`, problem screens of 7.1 | 0 | Start with the server off, then on. The chip and Home follow |
| 3 | Welcome cards and the permission screen | 2 | Fresh install runs welcome → permission → connect → Home once |
| 4 | Guided scan: prepare, scanning with coach and conditions, automatic upload, `build` screen, problems of 7.2 | 2 | Scan a real room start to finish with one hand and no reading of documentation |
| 5 | Room result: plan drawing, doorway choice | 4 | The plan matches the room. Choosing doorway B moves the door there |
| 6 | Inside the space: "Door is behind you", info sheet, wall warning | 1 | Walk towards a real wall inside the space: the grid appears before the wall does |
| 7 | Spaces screen, choice remembered per room; credits page | 2 | Change the space from Home and from the AR screen |
| 8 | Photo and share | 1 | The photo shows the scene without buttons and can be shared |
| 9 | Rooms list, several rooms | 5, S1, S2, S6 | Two rooms on one server; the app opens the right door in each |
| 10 | Visitor mode with PIN; Croatian | 2, 7 | A person who has never seen the app gets through the door with no help |
| Later | Notifications, rings to move to, downloadable spaces, threshold sound, more languages | | |

Steps 0–3 change no behaviour of scanning or finding the room. They can go ahead while the core loop is
still being proved on the phone.

## 11. Acceptance checks for the whole interface

- No screen has more than one amber button.
- The AR screen never shows more than four controls, and no technical words, with developer options off.
- Every state in sections 5.9 and 7 can be reached and has its text.
- Every waiting state names what is happening and, where known, how long it will take.
- All text comes from the dictionary. Switching the phone to Croatian changes every screen.
- Light and dark themes both work on every screen that is not over the camera.
- Nothing is cut off on a 360-wide screen with the largest system font size.
- With the server off, the app opens, explains and offers a way forward on every path.
