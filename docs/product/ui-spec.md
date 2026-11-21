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
5. **The app does the technical steps itself.** Nobody starts a recording by hand or presses "upload". A
   visitor chooses nothing at all. A staff member makes two choices: where the door stands and what is
   behind it.
6. **Everything technical lives in developer options**, off by default.
7. **Say only what is true.** Counters show what the phone actually knows. Times come from measurements.
8. **Staff tools may be denser.** Placing the door needs more controls than a visitor ever sees. They stay
   folded away until asked for.

## 2. Words

| Say | Meaning | Never show |
|---|---|---|
| door | the virtual door | portal, anchor |
| place the door, save the door | what staff do once per room | set anchor, manual placement |
| staff, visitor | the two kinds of user | host, admin, user |
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
- **Amber is the door and the main action**: the primary button, the door on the plan, rings to move to.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F4F6F9` | `#0C111A` | screen background |
| `surface` | `#FFFFFF` | `#151C28` | cards, sheets |
| `surface2` | `#E9EDF2` | `#1E2736` | icon tiles, notices, tracks |
| `ink` | `#131A26` | `#EEF2F8` | text |
| `ink2` | `#566074` | `#9AA6BA` | secondary text |
| `line` | `#D7DCE5` | `#2A3445` | borders, dividers |
| `amber` | `#FFB23E` | `#FFB84D` | primary button fill, the door on the plan |
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
| `door` | `#FFB84D` | door outline on the floor, rings |
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
| Door before its place is confirmed | shown at once, marked "not confirmed" in text | first placement in a session: an amber dashed outline of the door only, then the door when the place is confirmed. A 300 ms fade-in is optional polish: inside the portal it has not been tried |
| Door, confirmed | wooden casing sized to the opening | unchanged |
| AR / VR badge | always | removed (developer option) |
| Real walls while inside the space | nothing | `scan` grid on a real wall when the phone is within 0.6 m of it, full strength at 0.3 m. Drawn from the room plan the server returns with the position. **Check** that it can be drawn inside the portal's inner scene |
| Way back | nothing | "Door is behind you" pill when the door is outside the view |

## 4. Screen map

```mermaid
flowchart TD
  start([App start]) --> mode{Mode}
  mode -- visitor --> visitor[Visitor screen: find the door]
  visitor --> vdoor[Door in the room] <--> vinside[Inside the space]
  visitor -. "lock, then staff PIN" .-> home
  mode -- staff --> home[Home]
  home -- "Scan this room" --> prepare[Before you scan] --> scan[Scanning] --> build[Building the map] --> result[Room result]
  result -- "Place the door" --> place[Place the door]
  home -- "Place the door" --> place
  place -- "Save door" --> home
  home -- "Open the door" --> ar[AR: find the room, door, inside]
  home --> rooms[Rooms] -- "Move the door" --> place
  home --> spaces[Spaces]
  home --> settings[Settings]
  settings --> connect[Find the server]
  settings -- "Switch to visitor mode" --> visitor
```

A fresh install starts in visitor mode (4.3). The first time staff mode is opened: PIN, welcome cards (5.1),
Find the server (5.3), Home.

### 4.1 Navigation without a navigation library

The app has no navigation library, and one is not needed. The app store holds a `screen` value:

`welcome | permission | connect | home | scanPrepare | scan | build | roomResult | placeDoor | ar | spaces | rooms | settings | visitor | problem`

- `visitor` is the whole of visitor mode. `ar` is its staff counterpart. Each covers three situations of one
  screen: finding the room, door in the room, inside the space. They are derived from the localisation
  status and the existing AR / VR mode, not separate screens.
- `problem` carries a `kind` (section 7).
- The AR view (`ViroARSceneNavigator`) is mounted only on `scan`, `placeDoor`, `ar` and `visitor`. Other
  screens are plain React Native views. Remounting the AR view restarts the AR session; this is built but
  not seen on the phone. The developer option "Keep the AR view running" is the fallback. **Check**
- A new AR session needs a new `session_id` for the server, as the server contract says.

Android back button:

| On | Back does |
|---|---|
| Visitor screen | leaves the app; if a sheet or the welcome panel is open over the camera, closes it |
| Home | leaves the app |
| Scanning | asks "Stop scanning? The scan will be discarded." with "Keep scanning" / "Stop" |
| Building | goes Home; the build continues |
| Place the door | if something changed, asks "Leave without saving?" (5.14); else goes back |
| AR (staff) | goes Home |
| A sheet or menu | closes it |
| Anything else | goes to the previous screen |

### 4.2 What is remembered between launches

In the app's own settings file (the existing `prefs`), next to `server-connection.json` and `device-id.json`:

| Key | Purpose |
|---|---|
| `visitorMode` | the mode. `true` on a fresh install |
| `pinHash` | the staff PIN, hashed. Absent until staff mode is opened for the first time |
| `onboardingDone` | staff welcome cards shown once |
| `visitorWelcomeDone` | the visitor welcome panel was passed once, so later launches open the camera at once |
| `connection` | `server` (default) or `reactvision` (5.15) |
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

Rarely seen now: the visitor welcome panel (5.13) asks for the camera on the first launch. This screen is
shown in staff mode when the camera is still not allowed.

- Title: **Vrata needs your camera**. Body: "The camera shows the room and keeps the door in its place."
- Lines with icons, by connection method (5.15):

| Own server | ReactVision cloud |
|---|---|
| When you scan a room, a short video of it goes to the Vrata server on this Wi‑Fi. It is used only to build the room map. | When you scan a room, a short video of it goes to ReactVision's cloud, which builds the room map and keeps it. |
| Nothing leaves this network. No account, no ads. | Finding the room afterwards happens on this phone. |
| You can delete a room and its video at any time. (only once the server can: S1) | — |

- **Allow camera** opens the Android dialog. Granted: go on to where the user was heading.
- **Not now**, or a refusal: problem `camera`.
- The existing permission logic (retry, re-check on return to the app, "blocked" state) stays.
- The same lines appear on Before you scan (5.5) and in Settings under Privacy and data. Before a scan is
  the moment they matter: that is when a video is recorded.

### 5.3 Find the server (`connect`)

Staff mode only. Visitors never see it: in visitor mode the search runs behind the coach line "One moment…"
(5.13). Starts searching at once. Reuses the existing connection states.

| State (existing) | Title | Body | Buttons |
|---|---|---|---|
| `searching`, `connecting` | Looking for a Vrata server | Checking this Wi‑Fi. This can take up to a minute. | ghost **Enter address instead** |
| one server found | Found “{server_name}” | A Vrata server on this Wi‑Fi with {n} scanned rooms. (n = 0: "…with no rooms yet.") | primary **Connect** |
| several found | Choose a server | list of names | tap a row |
| none found | No server on this Wi‑Fi | Vrata keeps a door in place with the help of a server on the same network. Then two checks: "Is the server PC switched on and Vrata Server running?" / "Is this phone on the same Wi‑Fi (not mobile data, not a guest network)?" | primary **Search again**; ghost **Enter address** |
| phone not on Wi‑Fi | Connect this phone to Wi‑Fi | Vrata reaches the server over Wi‑Fi, not mobile data. | primary **Search again** |
| `incompatible` | This server needs an update | The app and the server are different versions. Update both. | primary **Search again** |

- "Enter address" opens a sheet with one field (label "Server address", hint "for example 192.168.1.20") and
  **Connect**. The existing validation messages stay.
- After the first successful connection the app reconnects silently at launch, as today.
- There is no "try a door without a server" here. A door that is not tied to the room is a developer tool.

### 5.4 Home (`home`)

Staff mode only. Top row: app name; server chip; settings icon.

Server chip:

| State | Chip |
|---|---|
| connected | green dot + server name |
| searching, connecting | amber dot + "Connecting…" |
| unreachable | red dot + "Server offline" |
| not set up | grey dot + "No server" |

Tapping the chip opens Settings. With the ReactVision cloud as the connection method the chip reads
"ReactVision cloud" with a green dot when the phone is online.

| Situation | Content | Primary | Secondary |
|---|---|---|---|
| Room with a saved door | Card "THIS ROOM": tag "Ready", plan drawing with the door in amber, room name, "Door placed {date} · {w} × {h} m", arrow to Rooms. Row "BEHIND THE DOOR": thumbnail, space name, "Change" | **Open the door** | text **Switch to visitor mode** |
| Room scanned, no door saved | The same card with the tag "No door yet" and the line "Put the door where visitors should find it." | **Place the door** | text **Scan again** |
| No room on the server | Card: "No room here yet" / "Scan this room once, then put a door in it. It takes about two minutes of walking." | **Scan this room** | — |
| A build is running | Card with room name, "Building the map · {p}%" | **See progress** | — |
| Server offline, rooms known | Room card dimmed, line "The server is offline. Vrata needs it to find the door." | **Search again** | — |
| No server set up | Card "Not connected" / "Vrata keeps a door in place with the help of a server on the same Wi‑Fi." | **Find the server** | — |

Plan drawing: walls as `teal` lines on `tealSoft`, corners as dots, the saved door as a thick `amber`
segment, doorways the server found in grey. Data: `GET /maps/{id}/room` and `GET /maps/{id}/portal`. If no
plan exists, show a door icon instead. "Scan another room" lives on the Rooms screen.

### 5.5 Before you scan (`scanPrepare`)

- Top bar: back, "Scan a room". Title: **Before you start**.
- Three rows:
  - **Turn on the lights** / "A bright room scans better."
  - **Keep the place for the door clear** / "Nothing standing where the door will be."
  - **Clear a path along the walls** / "You will walk around the room, not just turn."
- Notice: "About 2 minutes of scanning, then 3–15 minutes while the server builds the map. You can use the
  phone meanwhile." Replace the second range with measured values once real builds exist.
- If the room is new: a field "Room name" (default "Room 1"). It becomes the `label` and, made safe, the
  `map_id`.
- Primary: **Start scanning**.
- A line above the button: "Scan when no visitors are in the room." followed by the first privacy line of
  5.2 for the connection method in use.

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
| step 2 | Now show where the door will be | Look at that place from where visitors will stand, then from a second spot. |
| step 3 | That’s enough | Keep going for a better map, or finish now. |

Steps:

| Step | Starts when | Button |
|---|---|---|
| 1 Walls | recording starts | disabled, "Keep going · {s} s" counting down to 60 s |
| 2 Door place | 60 s passed, floor found, at least 6 m walked | ghost **Done, I showed it** |
| 3 Can finish | user confirmed | primary **Finish scan** |

- In step 2, amber corner brackets frame the middle of the view as an aiming aid. Visitors will later point
  their phones at this part of the room, so it has to be in the scan from the side they will stand on. The
  staff member confirms the step; the phone cannot check it.
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
| Drawing the room plan | `room_plan`, `finalize` | 100% |

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

The staff view of the door: **Open the door** on Home. It behaves like the visitor screen (5.13) with a
close button, a menu and staff wording in the problem sheets.

#### Finding the room

Close button (top left); room name pill (top right). The door is not shown.

| Existing status / attempt | Coach line 1 | Line 2 | Extra |
|---|---|---|---|
| server connecting | Connecting… | Looking for the server on this Wi‑Fi. | |
| `waiting-for-tracking` | Getting ready… | Move the phone a little. | |
| `localizing`, attempt 1 | Point at the room and hold still | Finding your room… | |
| attempts 2–3 | Try another view | Aim at furniture, shelves or pictures, not a bare wall. Hold still. | |
| attempts 4–5 | Still looking | Turn on more lights, or stand where you stood during the scan. | ghost **This is a different room** (once the Rooms list exists) |
| retry reason "scale not known yet" | Take a step sideways | Then hold still again. | |
| weak match, first placement | (keep the current line) | Checking the door’s position… | amber dashed outline of the door |
| `localized` | — | — | the door appears; hint "Walk through the door" for 5 s |
| `error` after the attempts | sheet, problem `unknown` | | |
| `waiting-for-server` | problem `server` | | |
| the room has no saved door | go to Place the door (5.14) | | |
| the server has no room | go Home, "No room here yet" | | |

Tracking warnings from section 5.6 replace the coach line while they apply.

#### Door in the room

- Top: close; space name pill (opens Spaces); menu button.
- Bottom: hint pill "Walk through the door" (fades after 5 s); shutter button.
- Menu sheet: **Find the door again** / "If it has slipped out of place" (the existing "Re-localize");
  **Move the door**; **Remove the door**; **Change the space**.
- Shutter: takes a photo of the view without the interface, saves it, then shows a small preview with
  **Share** for 4 s. Uses the AR view's screenshot call. **Check**

Small states, shown as a pill under the top row, never as a blocking screen:

| Situation | Pill |
|---|---|
| position not confirmed after the checks | The door may be slightly off · **Find again** |
| server offline while a door is standing | Server offline · the door stays where it is |
| tracking lost | red banner: "Lost track of the room" / "Move the phone slowly over furniture or pictures." Dimming the door while this shows is optional polish, not tried inside the portal |
| tracking back | banner disappears; the existing confirm check runs |

#### Inside the space

- Top: pill "Door is behind you" with a turn-back arrow, only when the door is outside the view; info button.
- Bottom: shutter.
- Info sheet "About this place": eyebrow (place and date), name, one paragraph, credit line, **Close**.
- Wall warning: coach "A real wall is close" / "The grid shows where your room ends." with the teal grid.
- Later: amber rings on the floor and the hint "Tap a ring to move further in".
- The existing rule stays: a door correction that arrives while the user is inside waits until they are out.

#### Developer tools

With developer options on, the staff AR screen also shows one line of small monospace text above the bottom
controls (tracking state, provider, match quality, inliers, time, door size and confidence) and a **Tools**
button. Tools opens the earlier debug interface over the live camera: provider and world switches, status,
event log, the scan panel and the measurement mode. It stays over the camera because measuring needs the
cross, the marks and the log on top of the picture. The switch "Door in front of the camera" lives here and
is labelled "Not tied to the room".

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

Staff mode only.

- Top bar: back, "Rooms". One row per room on the server: icon tile, name, state line, a menu button.

| State | Line | Tile |
|---|---|---|
| door saved | Ready · {space name} | teal |
| scanned, no door saved | No door yet · place the door | amber |
| building | Building the map · {p}% (tap opens `build`) | amber |
| failed to be found three sessions in a row | Scan again · the room has changed | red |

- Row menu: **Move the door** (or **Place the door**), **Remove the door**, **Change the space**,
  **Scan again**, **Rename**, **Delete**.
- Delete asks: "Delete “{name}”? Its map and video are removed from the server. This can’t be undone."
  with **Delete** / **Keep**.
- Footer: "Rooms live on the server “{server_name}”. Every phone that connects to it sees the same rooms."
- Primary: **Scan a new room**.
- Rename and Delete need server work (S1, S2). Hide them until it exists.
- Data: `GET /maps`.

### 5.12 Settings (`settings`)

Staff mode only.

| Row | Value / action |
|---|---|
| Connection | "Vrata Server · {server_name} · connected" or "ReactVision cloud"; opens 5.15 |
| Find servers automatically | switch |
| Switch to visitor mode | button. Asks "Switch to visitor mode? You will need the staff PIN to come back." with **Switch** / **Cancel** |
| Change staff PIN | asks for the current PIN, then the new one twice |
| Language | current language; opens a list |
| Privacy and data | a page with the statements from 5.2 and a link to Rooms for deleting |
| Credits and licences | spaces (model, author, licence) and software notices |
| How it works | reopens the welcome cards |
| Version line | "Vrata {version}"; seven taps switch developer options on |

Developer options (visible only when on): Diagnostics on the AR screen; Tools on the AR screen;
Localisation provider (self-hosted / ReactVision / manual, the last one labelled "Not tied to the room");
Door frame (casing / simple); Attach mode; Room plan in AR; Mesh lines; Test room; Test objects; Event log;
Save mesh; Keep the AR view running; Turn developer options off.

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

### 5.15 Connection method

Decided by the owner on 21 November 2026: the venue's own server stays the main way; ReactVision Advanced
VPS is added as a second way. Staff choose between them in Settings. Visitors never see the choice.

Nothing about the cloud method has been tried: it needs the owner's ReactVision account and a paid plan.
The facts below come from the library's code and the vendor's documentation, as summarised in the project's
own review of the service.

The Connection page has two options:

| Option | Line under it |
|---|---|
| **Vrata Server on this network** (default) | Rooms and doors are kept on a PC in this building. Nothing leaves the network. |
| **ReactVision cloud** | Rooms are kept in ReactVision's cloud. Finding the room needs no PC in the building. Requires a paid ReactVision plan. |

- If the app was built without ReactVision keys, the second option is disabled with the line "Not set up in
  this build."
- Under the first option: the server row (name, state, **Search again**, **Enter address**), as in 5.3.
- Under the second option: a switch "Recognise in the cloud", off by default, with the line "More reliable
  after days or in different light. ReactVision charges for it by the minute."

What changes behind the screens:

| | Own server | ReactVision cloud |
|---|---|---|
| Finding the room | a short clip goes to the server (`/localize`) | the library's `ViroVPS` with `startTracking` for the room's location, or `"visual"`. Never `"auto"`: it relies on GPS |
| Where the scan goes | to the server | the same recording goes to ReactVision. The upload needs a per-user key that the venue's server hands out (S12) |
| Building the map | the server, with the five steps of 5.7 | ReactVision. Show the same screen with three steps: Sending the scan, Building the map in the cloud, Ready. How long it takes is not documented, so show no time estimate |
| Where the door's place is kept | on the server | open decision for the owner: on the venue's server (proposed) or in the vendor's web editor. The screens are the same either way |
| How the door is drawn | through the existing door placement | proposal from the service review: take the camera's place in the map (`onLocalized`) and place the door through the existing mechanism, so the rule "do not move the door while someone is inside" keeps working. **Check** on the phone |
| Words on screen | as written in this document | the same. "Server" in problem texts becomes "the cloud service": "Can’t reach the cloud service" / "Check that this phone is online." |
| Privacy lines | 5.2, left column | 5.2, right column |

One scan can serve both methods. A room row in Rooms then shows two small tags, "Server" and "Cloud", and
the row menu gains **Also build in the cloud**. This gives a side-by-side comparison of the two methods on
one room.

In visitor mode the phone uses the method saved on that device. A fresh install uses the venue's own server.

## 6. Where today's controls go

| Today | Becomes |
|---|---|
| "Grant camera access" gate | the visitor welcome panel (5.13) and the permission screen (5.2) |
| Server chip and "Localization server" window | Home chip, `connect` screen, Settings |
| `Debug` / `Hide debug` | developer options |
| `AR` / `VR` badge | removed; developer line |
| Status panel, event log, `Hide log`, `Clear log` | Tools, developer only |
| `Re-localize` | "Find the door again" in the staff AR menu, and "Find again" in the pill |
| `Re-place door`, "Put the door in front of me" | Tools only, labelled "Not tied to the room". The real way to put a door somewhere is Place the door (5.14) |
| `Provider: manual / self-hosted` | at start always the server (or the cloud service chosen in Settings). Manual only in developer options |
| `World: sponza / test-room` | Spaces screen |
| `Frame: casing / simple`, `Attach: direct / parent` | developer options |
| `Scan room`, `Record`, `Upload as "room"`, `Cancel` | the guided scan (5.5–5.8). Until it is built, the old panel inside Tools |
| `Plan: on / off`, `Mesh lines`, `Save mesh`, `Reset mesh` | developer options |
| Status banner "Starting / Waiting for the server / Looking for the room / Check the doorway / Cannot place the doorway" | coach card, pills and problem screens (5.9, 5.13, 7) |

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

These are the staff texts. The visitor texts are in 5.13.

| Kind | Trigger | Form | Text | Actions |
|---|---|---|---|---|
| `unknown` | room not recognised after the attempts | sheet | **This doesn’t look like {room name}** / "Vrata could not match what the camera sees to the scan. If the furniture or the light has changed a lot, a new scan helps." | **Keep looking**; **Choose another room** and **Scan this room** once the Rooms list and the guided scan exist |
| `tracking` | tracking lost for more than 1.5 s | red banner | **Lost track of the room** / "Move the phone slowly over furniture or pictures." | none; clears by itself |
| not confirmed | weak matches only | pill | The door may be slightly off | **Find again** |
| no door | the room has no saved door | sheet | **This room has no door yet** / "Put the door where visitors should find it." | **Place the door** |

## 8. Technical notes for the app chat

- No navigation library is required (4.1). No state library is required; extend the existing stores.
- Colours, type sizes and spacing live in one theme file, shared pieces in `ui/`, and every user-facing text
  in one dictionary per language. This is built (steps 0–3). The name and the palettes sit in one file, so
  renaming the product is one change.
- Accepted for now, to be revisited when a native rebuild adds the modules:
  - the system font in place of the two faces of 3.2;
  - icons drawn from plain blocks in place of an outline icon set;
  - top padding by the status bar height and a fixed 28 at the bottom, in place of real safe-area insets.
    **Check** the bottom against the phone's navigation bar;
  - no blur under HUD elements.
- Additions that need a native rebuild, each optional and replaceable: safe-area insets; bundled fonts;
  vector drawing for icons, the plan and the progress ring; saving to the gallery and the share sheet for
  photos; local notifications for "room is ready".
- "This phone can’t show AR" may stay a one-time, non-blocking notice until the phone check shows that the
  AR engine's answer can be trusted.
- The app sends requests over plain HTTP on the local network. That stays for version 1.
- Keep the unit tests green. New pure logic worth testing: mode and start-screen choice (4.3), which doors a
  visitor may see (4.3), the door's move, turn and size steps (5.14), the percentage and step mapping (5.7),
  the scan step conditions (5.6), the status-to-text mapping (5.9, 5.13, 7).

## 9. What the server needs (for the server chat)

Listed here so both chats see the same picture. None of it is part of the app work.

| Id | Need | Used by | Needed for |
|---|---|---|---|
| S11 | Store `width` and `height` with a door saved by staff, and return them | Place the door, visitor screen | the first full pass, if the door is not 0.90 × 2.00 m |
| S13 | Confirm that `PUT …/anchors/portal` with a `session_id` works right after the map is built, in a fresh AR session | Place the door | the first full pass |
| S1 | Delete a room: map, frames and the stored recording | Rooms, the privacy statement | version 1 |
| S2 | Rename a room (change its label) | Rooms | version 1 |
| S3 | Refuse a too-short recording at upload, with its own error code | 7.2 | version 1 |
| S4 | Stop exposing the maps folder path in `/health` | privacy | version 1 |
| S5 | Store the chosen space with the room, so all phones show the same one | Spaces, visitor mode | version 1 |
| S6 | Tell which of several rooms a frame belongs to, without the room being named | several rooms | version 1 |
| S10 | Keep the staff PIN (hashed) on the server and check it there | visitors' own phones | before visitors use their own phones |
| S12 | For the ReactVision method: keep the room's ReactVision location id and the door's place in that map; hand out the per-user upload key. The secret key stays on the server, outside the repository | 5.15 | the second connection method |
| S7 | A list of downloadable spaces and their files | Spaces | later |
| S8 | An installer and a start icon for a non-developer | selling to venues | version 1 |
| S9 | A rule for how long recordings and device logs are kept | privacy | version 1 |

## 10. Order of work

Steps 0–3 of the first revision are built: theme and shared pieces, the staff AR screen, Home, Settings,
Find the server, the problem screens, the welcome cards and the permission screen. None of it has been seen
on a phone yet.

The order from here follows the owner's decision of 21 November 2026: the two modes and the staff-placed
door come first, then the full pass on the phone, then everything else. Each step ends with an app that can
be installed and used.

| Step | What | Needs | Check on the phone |
|---|---|---|---|
| A | Modes (4.3): a fresh install opens the visitor screen (5.13) with its welcome panel, coach lines and "ask a member of staff" sheets; lock and staff PIN; "Switch to visitor mode" in Settings. At start the app always finds the room through the server. A visitor sees only doors saved by staff. "Door in front of the camera" moves into Tools | steps 0–3 | A fresh install opens the visitor screen. With the server off: "The door isn’t ready". The PIN leads to Home, and the mode survives a restart |
| B | Place the door (5.14): put it here, adjust, save to the server; Move and Remove; Home state "No door yet"; Room result with **Place the door** (5.8) | A; S13; S11 for sizes | A staff member places a door, saves it, closes the app, opens it again: the door is in the same place |
| C | The full pass, using the old scan panel in Tools for the scan: staff scan the room, build the map, place and save the door; the app is closed; visitor mode opens; the door stands where it was saved. On a second phone as well, if there is one | A, B | This is the assignment's main question. Measure the door's offset and the time from launch to door |
| D | Guided scan: Before you scan, Scanning with coach and conditions, automatic upload, Building the map, the scan problems (5.5–5.7, 7.2) | A | Scan a real room start to finish with one hand and no documentation |
| E | Second connection method: ReactVision Advanced VPS (5.15) | the owner's ReactVision account and plan; S12 | The same room found by both methods; compare offset and time |
| F | Inside the space: "Door is behind you", info sheet, wall warning | A | Walk towards a real wall inside the space: the grid appears before the wall does |
| G | Spaces screen, choice remembered per room; credits page | A; S5 for all phones | Change the space; a second phone shows the same one |
| H | Photo and share | A | The photo shows the scene without buttons and can be shared |
| I | Rooms list, several rooms | B, S1, S2, S6 | Two rooms on one server; the app opens the right door in each |
| J | Croatian; language chips on the visitor welcome panel | A | A person who has never seen the app gets through the door with no help |
| Later | Notifications, rings to move to, downloadable spaces, threshold sound, more languages, staff PIN on the server | | |

## 11. Acceptance checks for the whole interface

- A fresh install, with a server that has a room and a saved door, shows the door without any setup on the
  phone: the user opens the app, allows the camera once and points it at the room.
- In visitor mode nothing can be changed and nothing technical is shown. Every failure ends in a sheet with
  plain words and **Try again**.
- A visitor never sees a door that no staff member saved.
- No screen has more than one amber button.
- The visitor screen and the staff AR screen never show more than four controls, and no technical words,
  with developer options off. Place the door shows three controls until **Adjust** is opened.
- Every state in sections 5.9, 5.13, 5.14 and 7 can be reached and has its text.
- Every waiting state names what is happening and, where known, how long it will take.
- All text comes from the dictionary. Switching the phone to Croatian changes every screen.
- Light and dark themes both work on every screen that is not over the camera.
- Nothing is cut off on a 360-wide screen with the largest system font size.

## 12. Answers to the app chat's report on steps 0–3

The report listed 16 places where the built app differs from the first revision.

| # | Difference | Answer |
|---|---|---|
| 1 | System font | Accepted for now (8) |
| 2 | Icons drawn from plain blocks | Accepted for now (8) |
| 3 | Fixed paddings in place of safe-area insets | Accepted for now; check the bottom edge on the phone (8) |
| 4 | No blur over the camera | Accepted; the specification already allowed it |
| 5 | The old interface kept as **Tools** over the camera | Accepted and now specified (5.9, Developer tools) |
| 6 | The door appears at once, no fade, no dimming on tracking loss | Accepted. Both are optional polish now (3.4, 5.9) |
| 7 | "Room not recognised" offers only **Keep looking** | Accepted until the Rooms list and the guided scan exist (7.3). Visitors get **Try again** and "ask a member of staff" (5.13) |
| 8 | "Place the door by hand" not offered | Superseded: placing the door is now the main path (5.14) |
| 9 | Menu item "Put the door in front of me" for a door without a server | To change in the app: remove it from the normal menu. It belongs in Tools, labelled "Not tied to the room" (4.3, 6) |
| 10 | "Connecting…" shown while the server connects | Accepted and now specified: staff 5.9, visitors "One moment…" (5.13) |
| 11 | "This phone can’t show AR" shown once, not blocking | Accepted until checked on the phone (8) |
| 12 | Third privacy line left out | Correct: it waits for S1 |
| 13 | Language, Visitor mode and Credits rows not shown | Mode switching is now step A; the other two rows follow in G and J |
| 14 | "Scan this room" opens the old scan panel in Tools | Accepted until step D. The full pass (step C) uses it |
| 15 | AR view created and destroyed with the screen, unverified | Accepted; "Keep the AR view running" is the documented fallback (4.1) |
| 16 | A restart ends on Home, so "launch to door" includes Home | Resolved by visitor mode: a later launch opens the camera at once, so "launch to door" has no screen in between. Measure it in visitor mode |
