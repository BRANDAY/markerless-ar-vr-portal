# Demo video: shot list

A short video that shows the whole idea once, in order: the room is scanned, the door
opening is found, the user walks into the atrium and out again, the app is closed and
opened, and the door is where it was. Target length **2–3 minutes**.

> **State on 21 November 2026.** This is a plan. None of the shots has been recorded, and
> two of them depend on things that have not been seen working yet: a door opening found
> by the server automatically (shot 3) and the door coming back after a restart (shot 7).
> [If something does not work on the day](#if-something-does-not-work-on-the-day) says
> what to show instead, and what must then be said in the video.

## Before recording

- Do one complete rehearsal without recording. Record as soon as the scenario works once;
  do not leave it for the last day.
- PC with the server running, phone and PC in one network, the server address already
  saved in the app (the chip at the top says `connected`).
- Room tidy and evenly lit, door leaf open at the angle it will keep for the whole video.
  Nothing is moved between the shots.
- Phone: do-not-disturb on, brightness up, battery above 50 %, screen recording ready.
- App settings: provider `self-hosted`, `World: sponza`, `Frame: casing`, `Measuring` off.
- Two recordings run in parallel: the **phone's screen recording** (what the user sees)
  and a **second phone or camera on a tripod** that shows the person and the real
  doorway. The cut alternates between them; the second view is what makes "walks through
  a real doorway" believable.
- The debug panel is shown where it explains something (shots 2, 3, 7) and hidden with
  `Hide debug` for the walk (shots 4–6): the mode badge `AR` / `VR` and the status banner
  stay visible either way.

## Shots

| # | Length | Source | What happens | What must be readable | Caption / voice |
|---|---|---|---|---|---|
| 1 | 10 s | camera | The real room and its door opening; the phone in the hand, app on the start screen | — | "A markerless AR-to-VR portal: the room itself is the marker." |
| 2 | 25 s | screen, sped up 4× in the middle | `Scan room`, `Record`; a slow walk along the walls with the door in view; coloured wall and floor highlights appear; `Stop rec`, `Upload` | the highlights; the upload and build progress bar | "The phone records video with its own poses. The PC builds a map of the room from it." |
| 3 | 15 s | screen | The build finishes: the room plan is drawn (orange walls, white opening) and the door casing appears in the real opening | the banner disappearing; `plan … doorway auto` in the scan panel | "The server finds the door opening in the map. Nobody placed the door by hand." |
| 4 | 20 s | camera, then screen | `Hide debug`. The user walks towards the door; through it the atrium of the Sponza Palace is visible while the room around stays real | badge `AR`; the atrium only inside the frame | "Through the door: a historical building, the atrium of the Sponza Palace in Dubrovnik." |
| 5 | 25 s | screen, with a cut to the camera | The user steps through. The badge turns `VR`; a look around the atrium, up to the arcades, back at the door: the real room is visible through it | badge `VR`; the real room inside the frame when looking back | "Inside, the real world is only visible back through the door." |
| 6 | 10 s | camera, then screen | The user walks back out; badge `AR` | badge `AR` | — |
| 7 | 30 s | screen, uncut | The app is closed (recent apps, swipe away) and started again from the icon, at another spot of the room. `Debug` on. The banner: "Looking for the room"; then the door appears in the same opening | **this shot must not be cut**: the swipe, the start, the banner, the door | "A new session has new coordinates. The app sends a short clip, the server recognises the room, and the door returns to its place." |
| 8 | 15 s | screen | `Measuring` on: both bottom corners of the real opening are marked, `Measure` pressed; the result line with centimetres and degrees | the green result line | "The error is measured against the real opening: … cm, … degrees." |
| 9 | 10 s | screen or slide | The summary table of the tests (from `npm run measure:report`) | the table | "Restart, approach angle, lighting, loss of tracking: results in the report." |

Shots 4–6 can be recorded in the scan session or after the restart; recording them after
the restart (in the order 1, 2, 3, 7, 4, 5, 6, 8, 9) makes the stronger video, because the
user then walks through a door that the app has put back by itself.

## Optional shots, if there is time

- **Tracking loss** (15 s, screen): cover the camera for a few seconds; the red banner
  "tracking lost — the doorway stays where it was"; uncover; "checking the doorway
  position"; the door stays. One sentence: "After a loss of tracking the door is checked
  again, and it never moves without saying so."
- **The server panel** (10 s, PC screen): `http://<PC>:8077/ui` with the phone listed, its
  state and the log lines arriving.
- **Another light** (10 s): the same restart with the lamps off or the curtains drawn.

## If something does not work on the day

The video must not show something as automatic that was done by hand. For each fallback,
say in the video what was done.

| Problem | Show instead | Say |
|---|---|---|
| The server finds no door opening by itself (shot 3: "no door opening found") | Set the doorway of the map by hand on the server (its manual portal), then continue: the app places the door from the server's answer all the same | "The opening was marked once on the PC; the app still finds it again in every session." |
| The room is not recognised after the restart (shot 7) | Show the attempt and the banner honestly, then press `Re-localize` from a view with more detail. If it never works: record shots 4–6 in the scan session and keep shot 7 as a shown limitation | "Recognition failed from this view; from here it works" — or — "Re-localisation after a restart did not work in this room; see the report." |
| No server at all | Provider `manual`: the door stands 2 m in front of the phone. Shots 4–6 work as described; shots 2, 3, 7, 8 are left out | "Without the server the door is placed in front of the user; it is not tied to the room." |
| The atrium is slow or does not load | `World: test-room` | "A simple test room instead of the atrium." |

## After recording

- Keep the uncut screen recordings: they are the evidence for the report, and the
  measurement lines in them can be read back (`npm run measure:report` also reads a saved
  log).
- Note for each shot the date, the build of the app (commit) and the server version.
