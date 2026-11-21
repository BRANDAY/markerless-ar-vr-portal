# Test protocol: does the door come back to the same place?

Assignment task 5 asks to check that the doorway stays at the same real place across a
restart of the app, from another approach angle, under other lighting and after a loss of
tracking. This document is the procedure for those checks with the app's **measurement
mode**: what to do, what to press, what gets recorded and what counts as success.

> **State on 21 November 2026.** The measurement mode is written and its arithmetic is
> unit-tested on a PC. **Nothing in this document has been done on a phone yet**: not the
> marking of corners, not a single trial. The first session on a device should start with
> [Check the ruler first](#check-the-ruler-first).

## The idea

Every app session has its own AR coordinate frame, so the door pose of one session cannot
be compared with the door pose of another. What does stay the same is the real door
opening. So in every session the tester marks the **two bottom corners of the real
opening** (where the door jambs meet the floor), and the app compares the door it has
placed with those marks.

For every trial the app records:

| Number | Meaning |
|---|---|
| position, cm | horizontal distance between the middle of the door's threshold and the middle of the real one |
| along, cm | the part of it along the wall; `+` = the door stands to the right of the real opening, seen from the side the user enters from |
| across, cm | the part through the wall; `+` = towards the user's side |
| up, cm | the door's threshold above (`+`) or below the floor the marks lie on |
| heading, deg | door heading minus real heading |
| width, cm | width of the placed opening minus the marked width |
| search time, attempts | from the start of the search to the door, and how many requests to the server it took |
| app start to door, s | from the start of the app's JavaScript (about a second after the icon is tapped) to the moment the door shown was put on screen |
| server quality, inliers | what the server said about the answer the door comes from |

With only one corner marked, that corner of the door is compared with the mark: a
position, but no heading and no width.

### Tolerance

**The assignment gives no tolerance. The one used here is our assumption:**

- **position ≤ 10 cm and heading ≤ 5°** = "the door is in the same place".

Why these numbers: 10 cm is about a ninth of a 90 cm door and is the scale at which a door
visibly misses its opening; 5° moves the far jamb of such a door by about 8 cm. Published
measurements say that centimetre accuracy is not to be expected from phone AR: position
errors above 10 cm even on the best phones and a mean drift of 3.4–25.1 cm after walking
away and back (Scargill et al., 2022), single-image localisation within 10 cm in about half
of the cases (LaMAR benchmark). Sources and links:
[`docs/research/tools-comparison.ru.md`](../../docs/research/tools-comparison.ru.md),
section "Протокол для задания 5". The tolerance lives in one place in the code
(`TOLERANCE` in [`src/measure/core/measurement.ts`](../src/measure/core/measurement.ts));
the report tool prints the numbers themselves, so another tolerance can be applied later.

For a whole test we propose (again our assumption): **the door comes back in at least 8 of
10 trials, and at least 8 of 10 measured trials are inside the tolerance.** The report must
give the distributions (median, mean, maximum) and describe the failures, not only this
verdict.

## What is needed

- The phone with the app, the PC with the localization server, both in one network
  ([README, "Connect to the localization server"](../README.md#connect-to-the-localization-server)).
- Masking tape and a tape measure.
- A room with a door opening that stays as it is for all tests. The door leaf stays open
  at the same angle in every session, including the scan.
- Screen recording on the phone switched on for every session: it is both evidence and
  material for the demo video.

## Preparation, once

1. **Tape.** Stick a piece of masking tape on the floor at each bottom corner of the
   opening, on the side the user will enter from, with a tape corner exactly at the corner
   of the jamb. Do it **before the scan** and leave the tape in place for all tests, so
   that the room looks the same in every session. The tape is only a measuring aid; the
   app does not use it.
2. Measure the width between the two corners with the tape measure and write it down.
3. **Scan and build** the room as in
   [README, "The scenario, step by step"](../README.md#the-scenario-step-by-step): provider
   `self-hosted`, `Scan room`, `Record` for 60–120 s with the whole door in view, `Upload`.
   Wait for the door to appear in the opening.
4. Write down the conditions of the scan: time of day, which lamps are on, curtains.
5. In the debug panel press `Measuring`. The room-scan panel is replaced by the measurement
   panel, and a crosshair appears in the middle of the screen. The choice is remembered
   over a restart of the app.

## The buttons

| Button | What it does |
|---|---|
| `Measuring` / `Measuring: on` (bottom row) | measurement mode on and off: panel, crosshair, corner posts |
| `Test: <name>` | the test the next records belong to: `baseline`, `restart`, `angle`, `lighting`, `tracking-loss`, `walk-through`. Remembered over a restart |
| `Mark left`, `Mark right` | mark the bottom left / right corner of the real opening. **Left and right as seen from the side the user enters from** (the side the door faces) |
| `Mark by: aim` / `phone` | how a corner is marked, see below |
| `Measure` | finish a trial: record the door against the marks |
| `Clear marks` | forget both marks |

**Marking by aim** (default). Stand 1–1.5 m from the corner, point the crosshair at the
tape corner on the floor, hold still, press `Mark left` or `Mark right`. The app takes the
point where the line of sight through the middle of the screen meets the floor plane. The
phone must look at least 25° below the horizon; if it does not, the log says so and nothing
is marked. A thin post appears on the marked point: magenta for left, cyan for right.

**Marking by phone.** Hold the phone upright with its camera directly above the tape
corner and press the button: the app takes the point of the floor straight below the
camera. For a room where the aim method turns out to be unreliable (no floor plane found,
a floor that reflects).

**Look at the post after every mark.** Take a step to the side: the foot of the post must
stay on the tape corner. If it slides away from it, the floor height the app assumes is
wrong or the aim was off: mark again, from closer and more steeply. Marking a corner that
is already marked logs how far the new mark is from the old one.

After an interruption of tracking the posts turn grey: the marks were made before the
interruption and the AR frame may have shifted. If the posts still stand on the tape,
carry on (the record notes that the marks are older than the interruption); if not, mark
again.

## Check the ruler first

Before any test, find out how well marking works in this room. Otherwise the tests measure
the marking, not the door.

1. Measurement mode on, any test name, tracking NORMAL, the floor near the door seen by the
   camera for a few seconds.
2. `Mark left` on the left tape corner. Step to another spot, mark the same corner again.
   Repeat five times from different places and distances. Each time the log line ends with
   "… cm from the previous left mark".
3. Mark the right corner once. The log says "real opening by the marks: … m wide": compare
   with the width from the tape measure.

Proposed limit (our assumption): repeated marks within **3 cm** of each other and the
width within **3 cm** of the tape measure. If the marking is worse than that, try
`Mark by: phone`; if that is no better, the distances have to be measured with the tape
measure on a screenshot from above, and only the times and the "door came back" counts
come from the app.

## One trial

Every test below consists of trials of the same shape:

1. Set `Test:` to the name of the test (once per test).
2. Bring about the condition of the test (restart the app, cover the camera…).
3. Wait until the door stands and the status banner at the top is gone. If the banner
   stays red ("Check the doorway", "Cannot place the doorway"):
   - with **no door** on screen the trial is a failure. The app has recorded it by itself
     (`not-found` or `no-doorway`); write down what the screen said and go to the next
     trial;
   - with a door on screen whose position "could not be confirmed", carry on with steps 4
     and 5: the record notes that the pose was not confirmed, and the distance shows
     whether the door is right all the same.
4. If this is a new session, or the posts are grey and off the tape: `Mark left`,
   `Mark right`.
5. Press `Measure`. The panel shows the result in the line `last`, green
   inside the tolerance and orange outside.

A localisation that ends without a door (`not-found`, `no-doorway`) counts as a trial in
which the door did not come back. A press of `Measure` counts as a trial in which it did.
The automatic records of a successful search (`placed`, `moved`, `confirmed`, `kept`) are
not counted separately; the `Measure` record that follows carries their timing.

Stay on the real side of the door while measuring. A correction of the door that arrives
while the user is inside the virtual room is held back until they are out again, and a
record made meanwhile describes the old pose (it is flagged).

## The tests

The numbers of trials are the ones proposed in the research note; with less time, halve
them but keep at least five per test.

### 0. Baseline (control)

`Test: baseline`. In the session the room was scanned in, right after the door appeared:
mark both corners, `Measure`. Repeat three times with `Clear marks` in between. This is
the error of the door detection itself plus the marking, before any persistence is asked
for. Everything below should be read against it.

### 1. Restart

`Test: restart`, 10 trials, some of them on the next day.

1. Close the app completely: open the recent apps and swipe it away.
2. Start it from the icon and stand at the same starting point (mark it on the floor),
   phone pointed at a part of the room with detail.
3. The app connects to the server and looks for the room by itself. Follow "One trial"
   from step 3; marks are needed in every session.

Shows the basic repeatability. Recorded besides the distances: seconds from app start to
the door, number of attempts, server quality.

### 2. Approach angle

`Test: angle`, 12 trials: three each from four starting points — in front of the door,
about 45° to the left, about 45° to the right, and from far away (for example from the
other end of the room). Every trial is a restart as in test 1, started at that point.
Write down which trial was started where: the app does not know.

Shows how much the result depends on the views the map was built from.

### 3. Lighting

`Test: lighting`, up to 20 trials: five each under the light of the scan (control), only
artificial light, only daylight, dimmed light. Every trial is a restart. Write down the
condition of each trial.

Shows the sensitivity to light. A room that is not recognised at all under some light is a
result, not a failed test run: the app records it as `not-found`.

### 4. Loss of tracking

`Test: tracking-loss`, 15 trials in one session, five each of:

- cover the camera with a hand for 5–10 s;
- point the phone at a blank wall or the ceiling for 5–10 s;
- walk out of the room and come back.

Before the first trial the door stands and both corners are marked. For each trial:

1. Do the interruption. The banner turns red ("tracking lost — the doorway stays where it
   was…"), the posts turn grey.
2. Come back to a view of the room. The app says "checking the doorway position" and asks
   the server again by itself.
3. Wait for the banner to go. Look at the posts: on the tape or not? Write it down; mark
   again if not.
4. `Measure`.

Shows whether the door returns to its place and how long that takes (`search time`).
An interruption shorter than 1.5 s is ignored by the app on purpose.

### 5. Walking through

`Test: walk-through`, 5 trials in one session.

1. Door placed, corners marked, `Measure` (the "before" record).
2. Walk through the door into the atrium, two or three steps, turn around, walk out.
3. Back on the real side: check the posts, `Measure` (the "after" record).

Shows the drift while the real world was hidden. The difference between the two records of
a trial is the result; the report tool lists them one after the other (`--trials`).

### Optional: the room has changed

Move a chair or take away a conspicuous object, then do three restart trials under
`Test: restart` and note them by hand. Long-term re-localisation in rooms that change is
an open problem, so an honest observation here belongs in the limitations section of the
report.

## Getting the results

Every record goes to three places:

1. **The event log on the screen** — a readable line starting with `measure`.
2. **The server.** The same line and a machine-readable `measure-data {...}` line travel
   with the device log, which the monitoring panel (`http://<PC>:8077/ui`) displays; the
   server appends every line to `work/device-logs/<device id>.jsonl` on the PC. This needs the
   server connection; lines made while it is down are sent when it is back (up to 500 are
   kept).
3. **A file on the phone**: `files/measurements/<run id>.jsonl` in the app's private
   directory, one file per app run, with the complete records (door pose, marks, all
   numbers). To copy them to the PC:

   ```
   adb exec-out run-as hr.fesb.arportal tar c files/measurements > measurements.tar
   ```

   (in `cmd.exe` or Git Bash, not PowerShell, which damages binary output).

The summary table per test:

```
npm run measure:report -- <file or folder> [more files or folders] [--trials]
```

It accepts the phone's files, the server's `device-logs` folder or a saved logcat, in any
mix; a record found twice is counted once. Example with the server's folder:

```
npm run measure:report -- E:\VR-FESB\work\device-logs --trials
```

prints for every test: trials, how often the door came back, how many were measured, how
many inside the tolerance, and median / mean / maximum of position, heading, seconds from
app start and seconds per search. `--trials` adds one line per record.

## What to write down by hand

The app cannot know these; without them the numbers cannot be interpreted:

- for every session: date, time, lighting, starting point, whether the door leaf and the
  furniture are as during the scan;
- for every failure: what the banner and the log said, what was on the screen;
- for tracking loss: whether the posts were still on the tape after recovery;
- anything odd: a door that jumps, a door facing the wrong way, a long wait.

## Limits of the method

- **The marks have their own error**: the aim, the floor height the app assumes and the
  width of the tape corner. That is why the ruler is checked first and why the baseline is
  measured. Errors below about 3 cm cannot be told from marking noise.
- **Aim marking needs a floor.** The floor height is the lowest horizontal plane the AR
  engine has found; before one is found, the height of the door's threshold is used
  instead (the log says which). A wrong floor height shifts an aimed mark along the line
  of sight by `error / tan(angle below the horizon)`.
- **The crosshair is the middle of the screen**, taken to be the middle of the camera
  image. Not checked on a device; the post that appears after a mark shows directly
  whether it holds.
- **"Left" and "right" must be marked as seen from the user's side of the door.** Swapped
  marks give a heading error of about 180°; the result line says so.
- **Marks do not survive a restart** (the frame changes), so the tester's marking error
  enters every restart trial anew.
- **After an interruption of tracking** the marks may be off without the app knowing; only
  the tester's look at the posts tells.
- **"App start to door"** starts when the app's JavaScript starts, about a second after
  the tap on the icon; the screen recording gives the full time.
- The buttons are part of the debug overlay; with the overlay hidden there is no crosshair
  and no panel, but localisations are still recorded.

## Record format

One JSON object per line in `measurements/<run id>.jsonl`:

| Field | Meaning |
|---|---|
| `v`, `kind` | `1`, `"door-measurement"` |
| `run`, `device`, `seq` | app run, installation id, number of the record in the run |
| `time` | ISO time |
| `condition` | the test chosen with `Test:` |
| `event` | `placed`, `moved`, `confirmed`, `kept` (a search ended with a door), `not-found`, `no-doorway` (it ended without one), `check` (`Measure` was pressed) |
| `provider`, `tracking` | active provider and tracking state at that moment |
| `placement` | the search the record belongs to: `event`, `reason` (`start`, `recovery`, `manual`, `build`, `by-hand`), `attempts`, `elapsedMs`, `sinceStartMs`, `trusted`, `quality`, `inliers`, `source`, `confidence` |
| `door` | the door on screen in this session's frame: `position` (metres), `yawDeg`, `widthM`, `heightM`, `sizeFromServer` |
| `reference` | the marks: `left`, `right` (metres, this session's frame), `method`, `beforeInterruption` |
| `comparison` | `basis`, `positionCm`, `alongCm`, `acrossCm`, `heightCm`, `headingDeg`, `widthCm`, `leftCm`, `rightCm`, `pass` |
| `held` | a correction of the door was being held back while the user was inside |

The `measure-data` line of the device log carries the same numbers under short names
(`c` condition, `e` event, `pos`, `al`, `ac`, `up`, `hd`, `wd`, `ok`, `att`, `ms`, `st`,
`q`, `inl`, `door`, `L`, `R`), to fit the 500 characters of a log message.
