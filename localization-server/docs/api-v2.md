# API v2 — room recording, room plan, automatic doorway

**Status: implemented (2026-11-20), not yet tried with a recording from a
phone.** The table at the end says what was verified and how. Shapes may still
gain fields, but documented fields will not change meaning without a note in
the change log at the bottom.

Everything in the v1 reference (`README.md`, "API reference") stays valid.
v2 only **adds** endpoints and response fields.

Contents: [compatibility](#1-compatibility) · [recording upload](#2-upload-a-room-recording) ·
[jobs](#3-jobs-progress-of-a-build) · [room plan](#4-room-plan) · [portal](#5-portal-automatic-doorway) ·
[/localize additions](#6-localize-additions) · [client flows](#7-client-flows) · [status](#8-implementation-status) ·
[devices and device log](#9-devices-and-device-log)

---

## 1. Compatibility

* `api_version` in `GET /health` **stays `1`**: every v1 request and response
  keeps its meaning, so an app built against v1 keeps working. (The current app
  accepts only `api_version == 1`; bumping it would lock that build out for no
  benefit.)
* v2 features are announced in `GET /health`:

```json
{
  "status": "ok", "service": "arportal-localization-server", "api_version": 1,
  "api_revision": 3,
  "capabilities": ["recording_upload", "jobs", "room_plan", "auto_portal", "device_log", "monitor_ui", "staff_door", "door_size", "rooms_admin"],
  "jobs": {"running": 1, "queued": 0},
  "...": "all v1 fields unchanged"
}
```

  A client that needs a v2 feature checks `capabilities` (absent on a v1
  server → treat as empty list). `staff_door` (server 0.4.0): the door placed
  by the staff carries its size, can be saved in the recording's own AR session
  and comes with `confirmed` / `suggested` (section 5). `rooms_admin`: rename
  and delete a room (section 10).
* Errors are unchanged: HTTP status + `{"detail": "text"}`.
* Units and frames are unchanged: metres, right-handed, `T_a_from_b`,
  quaternions `[x, y, z, w]`, `rotation_euler_deg` = ViroReact Euler degrees
  (`R = Rz·Ry·Rx`), usable directly as a `ViroNode` `rotation`.

---

## 2. Upload a room recording

```
POST /maps/{map_id}/recording        multipart/form-data        -> 202 {"job": Job}
```

The app records the room once (video + ARCore poses) and uploads it. The
server builds the map **in the background** and answers immediately.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `video` | file | yes | `video.mp4` of the recording (H.264) |
| `session_jsonl` | file | yes | `session.jsonl` of the same recording: header with intrinsics, one `pose` line per video frame (the format `/localize` already accepts) |
| `mesh` | file | no | room mesh of the same AR session (see below). Optional; a recording without it is fully supported |
| `mesh_format` | text | no | hint when the file name has no usable extension: `obj` \| `ply` |
| `replace` | bool | no (false) | allow replacing an existing map with this id |
| `display_rotation_cw` | 0/90/180/270 | no | only if the video's orientation tag is wrong: rotate frames clockwise by this to make them upright |
| `device_id` | text | no | stored in the map; same meaning as in `/localize` |
| `label` | text | no | human-readable name shown in `/maps` |
| `session_id` | text | no | id of the **AR session that is recording** (same character rule as `map_id`). Send it and the staff can save the door in this same session without a `/localize` first (section 5). Use a new id whenever the AR session starts anew (app start, tracking reset) |
| `max_frames` | int | no (200) | upper bound of frames used for the map (build time grows with it), 30–400 |
| `detect_openings` | bool | no (true) | run the doorway search |

`map_id`: letters, digits, `_`, `-` (1–64 characters), as in v1.

Responses:

| Status | When |
|---|---|
| `202` + `{"job": Job}` | accepted; poll the job |
| `409` | the map exists and `replace` is not true, **or** a build for this `map_id` is already queued/running (`detail` contains its `job_id`) |
| `413` | upload larger than the limit (default 2048 MB, env `LOCSERVER_MAX_RECORDING_MB`) |
| `422` | missing file, unreadable `session.jsonl` (no intrinsics header / no pose lines), bad `map_id`, **or a recording that cannot become a map** - see below |

**A recording that cannot work is refused at once** (since server 0.3.0), not
after minutes of reconstruction. The answer is `422` with the reason as a
sentence for the user in `detail` and a fixed word in the response header
`X-Error-Code`:

| `X-Error-Code` | Rule (from the pose lines of `session.jsonl`) | Example of `detail` |
|---|---|---|
| `recording_too_short` | fewer than 30 pose lines, or less than 3 s between the first and the last | `the recording is too short to build a map: 0.9 s, 15 frames (at least 3 s and 30 frames are needed). Record while walking through the room - one to two minutes is a good length` |
| `too_little_motion` | the camera positions span less than 0.30 m | `the phone hardly moved during the recording: 6 cm (at least 30 cm are needed). Turning on the spot is not enough - walk through the room and along the walls while recording` |

These are floors, not a promise: a recording that passes them can still fail in
the build (`job.error`) or give a thin map (`job.result.warnings`).

Only cheap checks happen before the `202`; everything else is reported through
the job. The previous map with the same id (if any) stays loaded and usable
until the new one has been built successfully; a failed or cancelled build
changes nothing.

### What the recording has to contain

* 60–120 s, the user **walks** slowly through the room (an arc or a loop of a
  few metres) while looking at the walls; every wall, the floor–wall edges and
  the room corners should be seen at least once. Turning on the spot is not
  enough: without sideways movement the map has no parallax, its 3D points are
  unreliable and the walls end up in the wrong place (measured on the test
  sequence, see README).
* The door: fully in view (both jambs, the top, the floor in front of it) from
  at least two positions ≥ 1.5 m away. Record it in the state it will have when
  the portal is used (open or closed) — a closed door is found by the image
  detector, an open one also by geometry.
* ARCore tracking must be `NORMAL` during the recording (poses are used as
  metric, gravity-aligned ground truth).

### How the files are read

As written by the phone (`app/docs/capture-format.md`; checked on two captures
of a Xiaomi 14 Ultra, 2026-11-20 - `tests/test_device_capture.py`):

* The video frames are stored in the sensor's orientation (1920 x 1080
  landscape) with a rotation tag of 90 degrees clockwise, and the intrinsics of
  the header belong to those stored pixels; the pose of a frame is that of the
  camera of the **upright** picture. The server turns every frame upright by the
  container's tag and the intrinsics with it (`fx' = fy`, `fy' = fx`,
  `cx' = height - cy`, `cy' = cx`). On the two captures the poses then predict
  the motion of image features to about 1 px; with any other orientation the
  error is more than ten times larger (12 to 17 times). `display_rotation_cw` overrides the tag and is
  not needed for these files.
* The n-th `pose` line belongs to the n-th frame. Frames and poses are paired by
  number when their counts are equal, otherwise by time (`t - t(first pose)`
  against the frame time of the container, which agreed to 0.1 ms). The frame
  rate may vary (33-133 ms between frames were seen).
* `orientation` is `[x, y, z, w]`, camera to world. `gravity` and the `imu`
  lines are not used (the AR world is gravity-aligned already), so the zero
  `gravity` of the first pose line does no harm.
* The same holds for the clip sent to `/localize`.

### Coordinate frame of a recording-built map

The map frame **is the AR world frame of the recording session**: metres, +Y up
(gravity), origin where that session started. Consequence: as long as the app
has not restarted the AR session after recording, the room plan from
`GET /maps/{map_id}/room` can be drawn directly, without `/localize`.
In any later session use the plan returned by `/localize` (section 6).

### `mesh` (optional)

Geometry of the room as the phone reconstructed it (ViroReact world mesh
snapshot). Requirements: vertex coordinates in the AR world frame of the
**same** session as the recording, metres. Accepted containers: Wavefront OBJ
(`v`, `f`) and PLY (ASCII or binary little-endian, `vertex` + optional `face`).
The app sends `world_mesh.ply` with `mesh_format=ply`: binary little-endian,
vertex properties `float x, y, z, confidence`, faces as
`list uchar int vertex_indices` (`app/docs/capture-format.md`, section 5). That
layout is read (extra vertex properties such as `confidence` are skipped);
checked with the two meshes of the first phone captures, converted the way the
app converts them (6,560 and 50,321 vertices). What has **not** been seen yet is
a mesh uploaded together with a full recording, i.e. how well it agrees with
the camera poses and how much it improves the plan. An
unreadable or empty mesh never fails the build: it is ignored and reported in
`job.result.warnings`.

---

## 3. Jobs: progress of a build

```
GET  /jobs/{job_id}            -> Job
GET  /jobs?map_id=room         -> {"jobs": [Job, ...]}      newest first, map_id optional
POST /jobs/{job_id}/cancel     -> Job                        (no effect on a finished job)
```

```json
{
  "job_id": "b3f9c2a17d04",
  "kind": "build_map",
  "map_id": "room",
  "state": "running",
  "stage": "matching",
  "stage_index": 3,
  "stage_count": 7,
  "stage_progress": 0.41,
  "progress": 0.24,
  "message": "matched 410 of 1000 image pairs",
  "queue_position": 0,
  "created_utc": "2026-11-20T18:02:11Z",
  "started_utc": "2026-11-20T18:02:12Z",
  "finished_utc": null,
  "elapsed_s": 212.4,
  "eta_s": 380,
  "error": null,
  "result": null
}
```

| Field | Meaning |
|---|---|
| `kind` | `build_map` (recording upload) or `room_plan` (plan recomputed for an existing map) |
| `state` | `queued` → `running` → `succeeded` \| `failed` \| `cancelled`. The last three are final |
| `stage` | current stage, see table; `null` while queued |
| `stage_index` / `stage_count` | 1-based position of the stage, for "step 3 of 7" |
| `stage_progress` | 0..1 inside the stage |
| `progress` | 0..1 overall, never decreases, `1.0` only when `state == "succeeded"` — show this as the percentage |
| `message` | one short English line for a debug overlay |
| `queue_position` | 0 = running or next; jobs run one at a time |
| `eta_s` | rough remaining seconds, `null` when unknown (always `null` while queued) |
| `error` | `null` or `{"code": "...", "message": "..."}` when `state == "failed"` |
| `result` | `null` until `succeeded`, then the summary below |

Stages of `build_map` (weights = share of `progress`; measured on the test
sequence the whole build took 13 min on a GTX 1050 Ti):

| # | `stage` | Share | What happens |
|---|---|---|---|
| 1 | `frames` | 5 % | decode the video, pick sharp frames, pair them with poses |
| 2 | `features` | 5 % | local features of every frame |
| 3 | `matching` | 35 % | feature matching between frame pairs |
| 4 | `sfm` | 35 % | structure from motion + metric alignment to the ARCore poses |
| 5 | `depth` | 8 % | dense depth of key frames for the room geometry |
| 6 | `room_plan` | 10 % | floor, walls, corners, door openings |
| 7 | `finalize` | 2 % | write the map, load it into the server |

`room_plan` jobs have only stages `depth`, `room_plan`, `finalize`.

`error.code`:

| Code | Meaning for the user |
|---|---|
| `bad_recording` | the video or `session.jsonl` cannot be read / do not belong together |
| `too_few_frames` | too short or too blurred |
| `sfm_failed` | the room could not be reconstructed (too little texture or overlap) — record again, slower |
| `out_of_memory` | GPU/host memory; retry, or lower `max_frames` |
| `server_restarted` | the server stopped while the job was queued or running — upload again |
| `internal` | anything else; `message` has the detail |

`result` of a successful `build_map`:

```json
{
  "map_id": "room",
  "num_images": 158, "num_points3D": 41230,
  "metric": true, "gravity_aligned": true,
  "build_time_s": 791.2,
  "room": {"status": "ok", "num_walls": 4, "num_corners": 4, "num_openings": 1, "best_opening_id": "o0"},
  "portal": {"source": "auto", "opening_id": "o0", "confidence": 0.78},
  "warnings": []
}
```

A map whose room plan could not be computed is still a valid localisation map
(`state: "succeeded"`, `room.status: "unavailable"`, a line in `warnings`).

Polling: every 1–2 s. `GET /jobs/{id}` never waits for the build (the build
runs in a separate process). The last 20 jobs are kept (also across a server
restart, where unfinished ones become `failed` / `server_restarted`).
`/localize` keeps working during a build, but is slower (one GPU). The
uploaded recording of the newest job of each map is kept on the server
(`work/jobs/<job_id>/`), so a failed build can be examined.

---

## 4. Room plan

```
GET  /maps/{map_id}/room            -> {"map_id": "room", "room": Room}        frame "map"
POST /maps/{map_id}/room/rebuild    -> 202 {"job": Job}   (kind "room_plan"; optional multipart `mesh`)
```

`GET` always answers `200` for an existing map; a map without a plan returns
`"room": {"status": "unavailable", "reason": "..."}` with empty lists.

```json
{
  "version": 1,
  "status": "ok",
  "reason": null,
  "frame": "map",
  "up": [0, 1, 0],
  "sources": ["mono_depth", "sfm_points", "door_detector"],
  "created_utc": "2026-11-20T18:15:40Z",

  "floor":   {"level": -1.32, "point": [0.4, -1.32, -1.1], "normal": [0, 1, 0],
              "outline": [[x, y, z], "... counter-clockwise seen from above ..."], "confidence": 0.93},
  "ceiling": {"level": 1.31, "point": [0.4, 1.31, -1.1], "normal": [0, -1, 0], "confidence": 0.71},
  "height": 2.63,

  "walls": [
    {"id": "w0",
     "center": [x, y, z], "width": 3.84, "height": 2.63,
     "normal": [nx, 0, nz],
     "corners": [[bl], [br], [tr], [tl]],
     "pose": {"position": [x, y, z], "rotation_euler_deg": [0, 90, 0], "quaternion_xyzw": [0, 0.7071, 0, 0.7071]},
     "confidence": 0.88, "coverage": 0.64}
  ],

  "corners": [
    {"id": "c0", "walls": ["w0", "w1"],
     "bottom": [x, y, z], "top": [x, y, z],
     "angle_deg": 90.4, "confidence": 0.8}
  ],

  "openings": [
    {"id": "o0", "kind": "door", "wall_id": "w1", "state": "open",
     "center_bottom": [x, y, z], "center": [x, y, z], "width": 0.86, "height": 2.02,
     "normal": [nx, 0, nz],
     "corners": [[bl], [br], [tr], [tl]],
     "pose": {"position": [..center..], "rotation_euler_deg": [..], "quaternion_xyzw": [..]},
     "portal_pose": {"position": [..center_bottom..], "rotation_euler_deg": [..], "quaternion_xyzw": [..]},
     "confidence": 0.78,
     "evidence": {"geometry": 0.7, "detector": 0.85, "views": 6}}
  ],
  "best_opening_id": "o0",
  "thresholds": {"auto_portal_min_confidence": 0.5}
}
```

### Semantics

* Extra fields, informational: `openings[].height_measured` (false = the top
  of the opening was not seen and `height` is the default 2.0 m), `key_frames`
  (names of the map images the plan was computed from), `stats`.
  `sources` lists what went into the plan: `mono_depth` (depth network),
  `door_detector`, `sfm_points` (the map's 3D points), `mesh`.
* `status`: `ok` — floor and at least two walls; `partial` — something is
  missing (e.g. only the floor, or one wall), lists contain what was found;
  `unavailable` — nothing usable, `reason` says why (`"not computed"`,
  `"map is not metric"`, `"too few points"`, ...). A plan with zero openings is
  still `ok`: **"door not found" is `openings: []` and `best_opening_id: null`,
  never an invented position.**
* `frame`: `map` here, `arworld` when the plan comes inside `/localize`.
  `up` is the gravity direction's opposite in that frame — `[0, 1, 0]` for
  recording-built maps and always in `arworld`.
* `floor.level` / `ceiling.level`: coordinate along `up` (the Y value when
  `up` is +Y). `ceiling` and `height` are `null` when the ceiling was not seen.
  `floor.outline`: closed polygon on the floor through the wall bases (may be
  missing = `null` when walls do not form a closed loop).
* **Rectangles** (walls and openings) all use the same description:
  * `center`, `width` (horizontal extent), `height` (vertical extent), metres;
  * `normal`: unit, horizontal, pointing **into the scanned room**;
  * `corners`: bottom-left, bottom-right, top-right, top-left **as seen by
    someone standing in the room and facing the surface**;
  * `pose`: frame at `center` with local +X = to the right (bl → br), +Y = up,
    +Z = `normal`. A `ViroQuad` of `width` × `height` under a node with
    `position = pose.position`, `rotation = pose.rotation_euler_deg` lies
    exactly on the surface and faces the room.
* `walls[].coverage`: fraction of the rectangle that was actually observed as
  solid wall (the rest is furniture, openings or not seen).
  Walls are vertical planes; they are not forced to be perpendicular to each
  other.
* `corners`: vertical edges where two walls meet. `bottom` is on the floor,
  `top` on the ceiling (or at the top of the lower wall). `angle_deg` is the
  interior angle between the two walls.
* `openings`: door-sized openings in a wall.
  * `kind`: `door` (reaches the floor). Windows are not reported.
  * `state`: `open` (free space behind was observed), `closed` (a door leaf in
    the wall plane, found by the image detector only), `unknown`.
  * `center_bottom` is on the floor plane in the middle of the threshold.
  * `portal_pose` is the **doorway frame the app already uses**: origin on the
    floor in the middle of the threshold, +Y up, the opening in the local XY
    plane, local +Z pointing into the scanned room (where the user stands
    before walking in), the virtual room extends to −Z.
  * `confidence` 0..1. `evidence.geometry` / `evidence.detector` are the
    individual scores (`null` = that method did not see it), `views` = number
    of key frames supporting it. Rule of thumb: an open doorway seen from two
    places reaches 0.5 by geometry alone; a closed door needs the detector to
    be sure of it (score ≥ 0.5) in at least three key frames; both together
    give 0.85 and more. A single detection never reaches the automatic
    threshold.
  * Sorted by `confidence`, best first. `best_opening_id` is the first one if
    its confidence ≥ `thresholds.auto_portal_min_confidence`, else `null`.
* Ids (`w0`, `c0`, `o0`) are stable for one computed plan and change when the
  plan is rebuilt.

Sizes to expect: a handful of walls and corners, 0–3 openings; the whole
object is a few kilobytes.

---

## 5. The door (portal)

**Decision of 2026-11-21:** the door is placed **once by a staff member** and
saved on the server; a visitor's device only receives it. The doorway the
server finds by itself is a *suggestion* for the staff member, not a door.

The door is the anchor named `portal` of the room. Where the door stands is
resolved in this order:

1. **manual** — the door the staff placed by hand (`PUT /maps/{map_id}/anchors/portal`);
2. **selected** — a doorway of the room plan that the staff accepted (`PUT /maps/{map_id}/portal`);
3. **auto** — `room.best_opening_id`: found by the server, **not confirmed by anybody**;
4. **none** — no door. The server never falls back to "2 m in front of the camera".

```
GET    /maps/{map_id}/portal            -> Door (frame "map")
PUT    /maps/{map_id}/anchors/portal    the staff places the door by hand            -> source "manual"
PUT    /maps/{map_id}/portal            {"opening_id": "o0"}: the staff accepts the suggested doorway -> source "selected"
DELETE /maps/{map_id}/portal            remove the door, however it was set (the suggestion stays)
```

```json
{
  "map_id": "room", "frame": "map",
  "source": "manual",
  "confirmed": true,
  "position": [x, y, z], "rotation_euler_deg": [0, 90, 0], "quaternion_xyzw": [0, 0.7071, 0, 0.7071],
  "width": 0.9, "height": 2.05,
  "opening_id": null, "confidence": null,
  "updated_utc": "2026-11-21T09:40:00Z", "placed_by": "staff-phone",
  "suggested": {
    "source": "auto", "opening_id": "o0",
    "position": [..], "rotation_euler_deg": [..], "quaternion_xyzw": [..],
    "width": 0.86, "height": 2.02, "confidence": 0.78
  },
  "reason": null
}
```

* `source`: `manual` | `selected` | `auto` | `none`.
* **`confirmed`**: `true` for `manual` and `selected` (a person decided),
  `false` for `auto` and `none`. **A visitor's app shows the door only when
  `confirmed` is true**; otherwise it tells the visitor to ask the staff.
* The pose is the doorway frame of the app: origin on the floor in the middle
  of the threshold, +Y up, +Z into the scanned room.
* `width` / `height`: metres. For `manual` they are what the staff sent
  (`null` if the client sent none - then use the app's default 0.9 x 2.0);
  for `selected` / `auto` they are measured from the opening.
* `placed_by`: the `X-Device-Id` of the request that saved or accepted the door; `updated_utc`: when.
* **The latest decision of the staff wins**: accepting a doorway removes a
  door placed by hand before, and a door placed by hand afterwards takes over
  again. (`DELETE /maps/{map_id}/anchors/portal` and `PUT ... {"opening_id": null}`
  from earlier revisions still work and undo only their own kind.)
* Capabilities: `staff_door` = everything in this section; **`door_size`** =
  the server stores and returns `width` / `height` of a door placed by hand
  (hide those inputs on a server without it).
* **`suggested`**: the doorway the server found by itself (`selected` or
  `auto`), or `null`. It is present next to a staff door too, so the staff
  screen can offer "use the doorway that was found". With `source` `auto` /
  `selected` it repeats the door itself.
* `source: "none"`: `position` and rotations are `null`, `reason` explains
  (`"no door opening was found in this room"`, `"the map has no room plan"`).

### Saving the staff's door

`PUT /maps/{map_id}/anchors/portal` with a JSON body; it takes the optional
`"width"`, `"height"` (metres, 0.3-6) and `"note"`.

**(a) As placed in the running AR session** - the normal case:

```json
{"ar_pose": {"position": [x, y, z], "rotation": [0, yaw, 0]},
 "session_id": "<the AR session id>", "width": 0.9, "height": 2.05}
```

`ar_pose` is the door in the phone's AR world (`rotation` = ViroReact Euler
degrees, or `quaternion_xyzw`). The server needs to know how that AR world
lies in the map:

* **In the AR session that recorded the room** (the upload carried the same
  `session_id`, section 2) **nothing else is needed**: that AR world *is* the
  map frame. The staff member scans, waits for the build and places the door
  without restarting the app and without a `/localize`.
  Do **not** reuse that `session_id` after the AR session was restarted
  (app start, tracking reset): the door would be saved in the wrong place.
  This shortcut needs a metric map (always the case for a recording with poses).
* **In any other AR session** (the app was restarted, another phone): call
  `/localize` with this `session_id` until `alignment.status == "ok"`, then
  send the `PUT`. Without an accepted alignment the answer is `422` and says so.
* Instead of `session_id` the body may carry the alignment itself:
  `"T_arworld_from_map": [[4x4]]` (v1, unchanged).

**(b) In map coordinates** (v1, unchanged): `{"position": [..], "quaternion_xyzw": [..]}`.

The answer is the stored anchor plus

```json
{"alignment_used": "recording_session", "portal": { "...": "the Door object above" }}
```

`alignment_used`: `recording_session` | `session_alignment` | `matrix` |
`map` - which of the ways above placed it. Show the staff member
the result (`portal`) in AR right away; it is exactly what visitors will get.

### Accepting the suggested doorway

```
PUT /maps/{map_id}/portal      {"opening_id": "o0"}      -> the Door object, source "selected"
```

The doorway `suggested.opening_id` of the room plan becomes the door, with the
place and size the server measured (`404` if the plan has no such opening).
Nothing about the AR session is needed for this call.

A new scan of the room (`replace=true`) **removes the door**: it stood in the
frame of the old scan. The room's `label` and `vps` data are kept. Place the
door again after the build.

---

## 6. `/localize` additions

New optional form field:

| Field | Type | Meaning |
|---|---|---|
| `include_room` | bool (default `true`) | add the room plan in AR-world coordinates to the alignment |

When the alignment is complete (`alignment.status == "ok"`), `alignment` gains:

```json
"alignment": {
  "status": "ok", "T_arworld_from_map": [[...]], "...": "v1 fields unchanged",
  "anchors": {
    "portal": {"position": [..], "rotation_euler_deg": [..], "quaternion_xyzw": [..]}
  },
  "portal": {
    "frame": "arworld", "source": "manual", "confirmed": true,
    "position": [..], "rotation_euler_deg": [..], "quaternion_xyzw": [..],
    "width": 0.9, "height": 2.05, "opening_id": null, "confidence": null,
    "updated_utc": "...", "placed_by": "staff-phone",
    "suggested": {"source": "auto", "opening_id": "o0", "position": [..], "...": "in the AR world too"},
    "reason": null
  },
  "room": { "...": "Room object of section 4 with frame = arworld" }
}
```

* `alignment.anchors.portal` is filled from the resolved portal (manual,
  selected or auto), so a v1 client that reads `anchors.portal` gets the
  automatic doorway without any change. With `source: "none"` the key
  `anchors.portal` is absent, exactly as in v1 when no anchor was stored.
* `alignment.portal` is always present when `status == "ok"`; it is the Door
  object of section 5 in AR-world coordinates (`suggested` included). Check
  `portal.source != "none"` before using the pose, and in visitor mode
  `portal.confirmed`.
* `alignment.room` is `null` when `include_room=false`, when the map has no
  plan, or when the alignment is not complete.
* All positions are transformed with `T_arworld_from_map`; lengths (`width`,
  `height`, `level`) are multiplied by the alignment scale (1 for metric
  maps).
* The same two fields are added to `POST /align` and `GET /sessions/{id}`.

`GET /maps` and `GET /maps/{map_id}` additionally report
`"room_status": "ok|partial|unavailable"`, `"portal_source": "manual|selected|auto|none"`,
`"portal_confirmed": bool`, `"portal_size": [width, height] | null`,
`"gravity_aligned": bool`, `"label"`, `"vps"` (section 11).

---

## 7. Client flows

**Staff: set a room up (once per room)**

1. Start an AR session; make up a `session_id` for it.
2. Record `video.mp4` + `session.jsonl` (+ mesh snapshot if available).
3. `POST /maps/{map_id}/recording` with `label` and that `session_id` → keep `job.job_id`.
4. Every 1–2 s `GET /jobs/{job_id}`: show `progress` (percent), `stage_index`
   / `stage_count` and `stage`. Stop on `succeeded` / `failed` / `cancelled`.
   **Keep the AR session alive meanwhile** (do not leave the AR screen).
5. On success: `GET /maps/{map_id}/room` (draw it: same AR session, so map
   coordinates are AR-world coordinates) and `GET /maps/{map_id}/portal`.
   If `suggested` is not null, offer it ("use the doorway that was found").
6. The staff member puts the door where it should stand, adjusts it, and
   saves: `PUT /maps/{map_id}/anchors/portal`, form (a) with the same
   `session_id` - or accepts the suggestion with `PUT /maps/{map_id}/portal`.
   Show the returned door.
7. Later changes: the same `PUT` moves the door ("place again"; in a new AR
   session after one accepted `/localize`), `DELETE /maps/{map_id}/portal`
   removes it, `PATCH /maps/{map_id}` renames the room, `DELETE /maps/{map_id}`
   removes the room (section 10).

**Visitor: nothing on the device but the app**

1. `GET /maps`: the rooms. Offer (or pick) those with `portal_confirmed == true`.
2. Optionally `GET /maps/{map_id}/room` and `GET /maps/{map_id}/portal` (plan
   and door in map coordinates; not needed for step 3).
3. `POST /localize` with frames or a clip + AR poses as in v1, with a
   `session_id` of this AR session.
4. When `alignment.status == "ok"`:
   * `alignment.portal.confirmed` → show the door at `alignment.portal`
     (`position`, rotation, `width`, `height`) - all in this phone's AR world;
   * draw `alignment.room` if wanted (walls from `corners`, room corners from
     `corners[].bottom`/`top`, openings from `openings[].corners`).
5. `portal.confirmed == false` (no door, or only a suggestion) → "ask a staff
   member". A visitor never places or moves the door.

Both modes send `X-Device-Role` (section 9.1).

---

## 8. Implementation status

| Part | State | Verified how |
|---|---|---|
| `capabilities`, `api_revision`, `jobs` in `/health` | done | tests |
| `POST /maps/{id}/recording`, `/jobs`, cancel, queue, restart handling | done | tests with a stub builder; one real build through the running server from a synthetic recording in the ViroReact format (README, "Room plan") |
| Room plan: floor, ceiling, walls, corners | done | synthetic rooms (exact ground truth); public TUM sequence against its Kinect depth |
| Openings: geometry (open doorways) | done | synthetic rooms only |
| Openings: image detector (closed doors) | done | synthetic boxes in tests; the real detector only looked at on TUM frames (no door ground truth there) |
| `mesh` input | OBJ/PLY reader done, tested on hand-made files | waits for `app/docs/capture-format.md` and a real snapshot |
| `/maps/{id}/portal`, `/localize` / `/align` / `/sessions` additions | done | tests |
| Staff door with size, `confirmed` / `suggested`, saving in the recording's session, `X-Device-Role`, rename / delete a room, `vps` entry (sections 5, 10, 11) | done (server 0.4.0) | `tests/test_staff_door.py`; a run of `scripts/simulate_phone.py` as staff device and as visitor device against the running server. Not with a phone |
| Section 9: device headers, `POST /devices/{id}/log`, `GET /devices`, log read-back, `/ui` | done (server 0.3.0) | tests; a run of `scripts/simulate_phone.py` against the running server. No log from the real app has been received yet |

**Not verified: anything on a real room recorded with the phone.** No such
recording exists yet. In particular unknown: how well the depth network and
the door detector behave in the owner's room, and whether ARCore poses are good
enough over a whole scan.

## 9. Devices and device log

**Status: implemented in server 0.3.0 (2026-11-20) exactly as drafted**; the
only sender so far is `scripts/simulate_phone.py`, which is also the reference
client for this section. Purpose: the server's monitoring panel (`/ui`, opened on
the PC) shows which phones are connected, what each of them is doing and where
the usage scenario currently stands. The capability name is `device_log`
(check `capabilities` in `/health`; on a server without it the calls below
answer `404` - stop sending for that server).

### 9.1 Identify the device on every request

Send these HTTP headers with **every** request to the server (`/health`
polls, uploads, job polling, `/localize`, ...). All optional, all ASCII:

| Header | Value |
|---|---|
| `X-Device-Id` | stable id of this installation: letters, digits, `_`, `-`, `.` (1-64). The same value the app already sends as `device_id` to `/localize` |
| `X-Device-Name` | human-readable name for the panel, e.g. `Xiaomi 14 Ultra` (max 64; non-ASCII characters percent-encoded as in a URL) |
| `X-Session-Id` | id of the current app run (new value on every app start), same character rule as `X-Device-Id` |
| `X-App-Version` | app version / build, max 32 |
| `X-Device-Role` | `staff` or `visitor`: the mode the app is in (server 0.4.0). Shown in the panel; for a visitor the panel's strip has no scan and build steps. **Not a permission**: the server does not check it (see section 10) |

Without `X-Device-Id` the server still lists the client, by its IP address,
as an unnamed device. The server measures and shows "last seen" and its own
handling time per request from these requests; nothing else is needed for the
"connected / lost" state (a device is *online* while its last request is less
than 10 s old, so keep the existing `/health` poll at 5 s or faster while the
app is in the foreground).

### 9.2 Send the device log

```
POST /devices/{device_id}/log          application/json          -> 200
```

```json
{
  "session_id": "run-7f3a",
  "device_name": "Xiaomi 14 Ultra",
  "app_version": "0.3.0 (12)",
  "sent_at_ms": 1763662000123,
  "rtt_ms": 14,
  "state": {
    "step": "scanning",
    "tracking": "NORMAL",
    "map_id": "room",
    "detail": "recording 00:42"
  },
  "events": [
    {"seq": 41, "t_ms": 1763661998400, "level": "info",  "type": "tracking", "message": "tracking NORMAL"},
    {"seq": 42, "t_ms": 1763661999000, "level": "info",  "type": "scan",     "message": "recording started", "data": {"map_id": "room"}},
    {"seq": 43, "t_ms": 1763662000050, "level": "error", "type": "upload",   "message": "upload failed: timeout", "data": {"attempt": 2}}
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `session_id` | yes | id of the app run, as in `X-Session-Id`. `seq` restarts with a new session |
| `device_name`, `app_version` | no | same as the headers; either place is fine |
| `sent_at_ms` | yes | device clock when the batch was sent, Unix epoch **milliseconds**. The server uses it to translate the device times of the events into its own clock |
| `rtt_ms` | no | the round-trip time the app last measured to this server (e.g. of the last `/health` poll), shown as "latency" |
| `state` | no | current snapshot, replaces the previous one. `step` is one of the values below; `tracking` is the AR tracking state as text; `map_id` the map being scanned or used; `detail` one free line (max 200). Other keys are kept and shown as they are (keep it small) |
| `events` | yes (may be `[]`) | new log entries, oldest first, at most 200 per request |
| `events[].seq` | yes | integer, increasing by one per event within a session. Used to drop duplicates when a batch is retried: the server ignores every `seq` it already has for this session |
| `events[].t_ms` | yes | device clock when the event happened, Unix epoch milliseconds |
| `events[].level` | no (`info`) | `debug` \| `info` \| `warn` \| `error` |
| `events[].type` | no (`app`) | short category, see the list below (unknown values are accepted and shown) |
| `events[].message` | yes | one line of text, max 500 characters (longer is cut) |
| `events[].data` | no | small JSON object with details, max 4 kB serialised (larger is dropped, the event is kept) |

Response:

```json
{"accepted": 3, "duplicates": 0, "last_seq": 43, "server_time_ms": 1763662000140}
```

`last_seq` is the highest `seq` the server holds for this session; after a
`200` the app may forget every event up to it. Errors: `413` (body over
256 kB or more than 200 events), `422` (bad `device_id` / missing `session_id`
/ `events` not a list; single malformed events are skipped and counted in
`"skipped"`, they do not fail the batch).

**`state.step`** - where this device is in the scenario (drives the "usage
flow" strip of the panel):

| `step` | Meaning |
|---|---|
| `connecting` | looking for / connecting to the server |
| `connected` | server found, nothing started yet |
| `scanning` | recording the room |
| `uploading` | sending the recording |
| `building` | waiting for the map build (the server knows the progress itself) |
| `ready` | a map with a room plan is available, not localised yet |
| `localizing` | sending frames to `/localize`, no accepted alignment yet |
| `portal_placed` | alignment accepted, the doorway is shown in AR |
| `inside` | the user is on the virtual side of the portal |
| `error` | something the user has to act on; say what in `detail` |

**`events[].type`** - recommended values: `app` (start, foreground/background,
permissions), `connect` (server search and connection), `tracking` (AR tracking
state changes and reasons), `scan` (recording start / stop / what was saved),
`upload`, `job` (what the app saw of the build), `localize` (request sent,
answer used or rejected and why), `portal` (placed, moved, entered, left),
`error` (anything unexpected, with the text of the exception).

**Client rules**

* Batch: send when 20 events are waiting or every 2 s, whichever comes first,
  and at once for `error` events. With no new events send a batch with
  `events: []` every 5 s while in the foreground so that `state` and `rtt_ms`
  stay current (this can replace one `/health` poll).
* Never block the UI or the AR session on it; timeout 3 s. On failure keep the
  events (at most 500, drop the oldest) and retry with the next batch; the
  `seq` numbers make the retry safe.
* Log what a person debugging from the PC would want to read; no camera
  images, no personal data. Do not log every frame: tracking *changes*, not
  tracking per frame.

### 9.3 What the server keeps

The last 2,000 events per device in memory, and every accepted event appended
to `work/device-logs/<device_id>.jsonl` on the PC. Devices and their logs
survive in memory until the server restarts; the files stay.

### 9.4 Reading it back (used by the panel; open to any client)

```
GET    /devices                                   -> {"devices": [Device, ...]}
GET    /devices/{device_id}/log?after=<id>&limit= -> {"events": [...], "last_id": 1234}
DELETE /devices/{device_id}                       -> forget the device (memory only)
GET    /ui                                        -> the monitoring panel (HTML, works offline)
```

`Device`: `{"device_id", "name", "address", "app_version", "session_id",
"online": bool, "last_seen_utc", "last_seen_age_s", "first_seen_utc",
"requests": n, "last_request": "GET /health", "server_ms": 3.1, "rtt_ms": 14,
"clock_offset_ms": -210, "state": {...}, "errors": n}`.

Log entries as returned: the fields of 9.2 plus `id` (server-wide increasing
number, use it as `after`), `device_id`, `session_id` and `server_time_ms`
(the event time translated to the server clock).

The panel's own data feed (`/monitor/...`) is internal and may change without
notice; do not build the app on it.

## 10. Rooms: rename, delete

Capability `rooms_admin` (server 0.4.0). A room is a map; its id never changes,
its name is the `label`.

```
PATCH  /maps/{map_id}     {"label": "Exhibition 2"}      -> the room, as GET /maps/{map_id}
DELETE /maps/{map_id}                                    -> {"deleted": "hall", "kept_as": ".trash/hall-20261121-094000"}
```

* `label`: text of at most 80 characters, or `null` to remove the name.
  `PATCH` accepts only `label` and `vps` (section 11); anything else → `422`.
* `DELETE` unloads the room and moves its folder into `.trash` inside the
  maps folder - nothing is erased, and whoever runs the server can put it back
  by moving the folder and calling `POST /maps/reload`. Alignment sessions of
  that room are dropped. `409` while a build for this room is queued or
  running (cancel it first), `404` for an unknown room. The id is free again
  afterwards.
* Deleting only the door: `DELETE /maps/{map_id}/portal` (section 5).

**No access control today.** The server has no login: any device in the
network can call every endpoint, these included. The staff PIN is created and
checked on the device only, so on their own phone anybody can make themselves
staff, and another program in the network needs no PIN at all.

**Planned, not built (waits for a go-ahead): the staff PIN on the server.**
Outline, so that the app can be prepared for it:

* the server keeps one staff PIN (only a salted hash of it, in its work
  folder, never in the repository); it is set on the PC that runs the server
  (command line or the panel), not from a phone;
* `POST /staff/login {"pin": "..."}` → `{"staff_token": "...", "expires_utc": "..."}`;
  a few wrong attempts in a row lock the login for a while;
* the app sends `X-Staff-Token` with the requests that change something:
  recording upload, the door calls of section 5, `PATCH` / `DELETE` of a room,
  room-plan rebuild. Without a valid token those answer `401`; everything a
  visitor needs (`/health`, `GET /maps...`, `/localize`, device log) stays open;
* announced as capability `staff_auth`; a server without it behaves as today.

The traffic is plain HTTP in the local network, so this keeps honest users in
their role; it is not protection against someone who listens on the Wi-Fi.

---

## 11. Place at an external positioning service (ReactVision Advanced VPS)

The app can be built to recognise the room through ReactVision's Advanced VPS
instead of this server. For that mode the server only **keeps two facts per
room** and hands them to every device; it does not talk to the service.

```
PATCH /maps/{map_id}
{"vps": {"provider": "reactvision",
         "location_id": "<the service's location id>",
         "door": {"position": [x, y, z], "quaternion_xyzw": [x, y, z, w], "width": 0.9, "height": 2.05},
         "note": "scanned 2026-11-22"}}
```

* `location_id` (required, 1-128 characters): what the visitor's app passes to
  `startTracking(locationId)`.
* `door` (optional): the door in the frame of **that service's map** (metres,
  Y up - the frame of `<ViroVPSAnchor>` content), same doorway convention as
  section 5. The service has no call to store a placed object, so the place
  the staff chose has to live here.
* `provider` defaults to `"reactvision"`; `note` is free text (max 200).
  Unknown fields → `422` (so that a key never ends up here by mistake).
  `{"vps": null}` removes the entry. The server adds `updated_utc`.
* Read it back in `GET /maps` and `GET /maps/{map_id}` as `"vps"` (`null` when
  not set). It survives a new scan of the room on this server.

The two frames are unrelated: `vps.door` is **not** the door of section 5 in
other coordinates, and the server does not convert between them. A staff
member who wants both ways for one room places the door once per way.

**Not built: handing out keys for the scan upload.** Sending a scan to the
service from the app (`uploadScanRecording`) needs a short-lived *user token*
(`rv_ut_...`, one hour) that a backend creates with the account's *secret key*
(`rv_secret_...`); the secret key must never be in the app or in this public
repository. When the owner has an account, this server would get:

1. the secret key and project id from a file outside the repository (or
   environment variables), never returned by any endpoint;
2. one endpoint, e.g. `POST /vps/user-token`, that asks the service for a user
   token and returns it with its expiry - the app's `fetchToken` calls it;
3. a check that the caller is staff (see "No access control" above) - without
   it anyone in the network could spend the account's paid scan minutes.

Until then the staff can scan with the service's own StudioGo app and type the
resulting `location_id` in.

---

## Change log

* 2026-11-20 — first draft.
* 2026-11-20 — implemented. Added (no changes to drafted fields):
  `openings[].height_measured`, `key_frames`, `stats`, source `sfm_points`;
  recording advice changed from "turns/walks" to "walks" (parallax is needed).
* 2026-11-20 — section 9 (devices, device log) drafted; capability `device_log`.
* 2026-11-20 — section 9 implemented as drafted (server 0.3.0); new capabilities
  `device_log` and `monitor_ui` (the latter: the server has the panel at `/ui`).
* 2026-11-21 — first phone captures (app/docs/capture-format.md): section 2 says
  how the files are read; a recording that is too short or does not move is
  refused at upload with `X-Error-Code`; the minimum of 10 pose lines became
  30 lines and 3 s; mesh layout of the app confirmed.
* 2026-11-21 — **revision 3, server 0.4.0: two modes of the app** (owner's
  decision: a staff member places the door, visitors receive it).
  Section 5 rewritten: the staff's door carries `width` / `height`, the Door
  object gains `confirmed`, `suggested`, `updated_utc`, `placed_by`;
  `PUT /maps/{id}/anchors/portal` accepts `width`, `height` and works without
  `/localize` in the recording's own AR session (new upload field
  `session_id`); its answer gains `alignment_used` and `portal`. Accepting the
  suggested doorway stays `PUT /maps/{id}/portal` (source `selected`) and now
  replaces a door placed by hand; `DELETE /maps/{id}/portal` removes the door
  of either kind.
  `GET /maps` gains `portal_confirmed`, `portal_size`, `vps`. New: header
  `X-Device-Role`, `PATCH /maps/{id}` and `DELETE /maps/{id}` (section 10),
  the `vps` entry of a room (section 11). Capabilities `staff_door`,
  `door_size`, `rooms_admin`. Changed meaning to mind: `width` / `height` of a
  `manual` door are no longer always `null`, and a rebuilt room loses its door.
  Planned and described, not built: staff PIN on the server (section 10).
* 2026-11-21 — room plan with `status: "partial"`: `reason` now names what was
  missing and what to do when wall-like surfaces were seen over too little of
  their height (text for the user, e.g. "fewer than two walls were found: 2 more
  wall-like surfaces were seen over less than 1.2 m of height ... tilt the phone
  up and down so that the walls are seen from the floor to the ceiling"); the
  same text is among the job's `warnings` as "room plan is partial: ...".
  No field changed; show `reason` as it is.
