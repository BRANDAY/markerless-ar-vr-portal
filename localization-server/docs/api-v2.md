# API v2 — room recording, room plan, automatic doorway

**Status: implemented (2026-11-20), not yet tried with a recording from a
phone.** The table at the end says what was verified and how. Shapes may still
gain fields, but documented fields will not change meaning without a note in
the change log at the bottom.

Everything in the v1 reference (`README.md`, "API reference") stays valid.
v2 only **adds** endpoints and response fields.

Contents: [compatibility](#1-compatibility) · [recording upload](#2-upload-a-room-recording) ·
[jobs](#3-jobs-progress-of-a-build) · [room plan](#4-room-plan) · [portal](#5-portal-automatic-doorway) ·
[/localize additions](#6-localize-additions) · [client flows](#7-client-flows) · [status](#8-implementation-status)

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
  "api_revision": 2,
  "capabilities": ["recording_upload", "jobs", "room_plan", "auto_portal"],
  "jobs": {"running": 1, "queued": 0},
  "...": "all v1 fields unchanged"
}
```

  A client that needs a v2 feature checks `capabilities` (absent on a v1
  server → treat as empty list).
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
| `max_frames` | int | no (200) | upper bound of frames used for the map (build time grows with it), 30–400 |
| `detect_openings` | bool | no (true) | run the doorway search |

`map_id`: letters, digits, `_`, `-` (1–64 characters), as in v1.

Responses:

| Status | When |
|---|---|
| `202` + `{"job": Job}` | accepted; poll the job |
| `409` | the map exists and `replace` is not true, **or** a build for this `map_id` is already queued/running (`detail` contains its `job_id`) |
| `413` | upload larger than the limit (default 2048 MB, env `LOCSERVER_MAX_RECORDING_MB`) |
| `422` | missing file, unreadable `session.jsonl` (no intrinsics header / fewer than 10 pose lines), bad `map_id` |

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
The exact file the app produces will be described in
`app/docs/capture-format.md`; the server will follow that document. An
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

## 5. Portal: automatic doorway

Where the portal stands is resolved by the server in this order:

1. **manual** — an anchor named `portal` stored with the v1
   `PUT /maps/{map_id}/anchors/portal` (unchanged, always wins);
2. **selected** — an opening chosen explicitly (below);
3. **auto** — `room.best_opening_id`;
4. **none** — no portal. The server never falls back to "2 m in front of the
   camera"; that decision, if wanted, belongs to the app.

```
GET /maps/{map_id}/portal      -> Portal (frame "map")
PUT /maps/{map_id}/portal      {"opening_id": "o1"}     choose an opening;  {"opening_id": null} = back to auto
```

`DELETE /maps/{map_id}/anchors/portal` (v1) removes the manual pose and
returns to selected/auto.

```json
{
  "map_id": "room", "frame": "map",
  "source": "auto",
  "opening_id": "o0",
  "position": [x, y, z], "rotation_euler_deg": [0, 90, 0], "quaternion_xyzw": [0, 0.7071, 0, 0.7071],
  "width": 0.86, "height": 2.02,
  "confidence": 0.78,
  "reason": null
}
```

* `source`: `manual` | `selected` | `auto` | `none`.
* The pose is the doorway frame described under `portal_pose`.
* `width` / `height` / `confidence` / `opening_id` are `null` for `manual`.
* `source: "none"`: `position` and rotations are `null`, `reason` explains
  (`"no door opening was found in this room"`, `"the map has no room plan"`).
* `PUT` with an unknown `opening_id` → `404`.

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
    "frame": "arworld", "source": "auto", "opening_id": "o0",
    "position": [..], "rotation_euler_deg": [..], "quaternion_xyzw": [..],
    "width": 0.86, "height": 2.02, "confidence": 0.78, "reason": null
  },
  "room": { "...": "Room object of section 4 with frame = arworld" }
}
```

* `alignment.anchors.portal` is filled from the resolved portal (manual,
  selected or auto), so a v1 client that reads `anchors.portal` gets the
  automatic doorway without any change. With `source: "none"` the key
  `anchors.portal` is absent, exactly as in v1 when no anchor was stored.
* `alignment.portal` is always present when `status == "ok"`; check
  `portal.source != "none"` before using the pose.
* `alignment.room` is `null` when `include_room=false`, when the map has no
  plan, or when the alignment is not complete.
* All positions are transformed with `T_arworld_from_map`; lengths (`width`,
  `height`, `level`) are multiplied by the alignment scale (1 for metric
  maps).
* The same two fields are added to `POST /align` and `GET /sessions/{id}`.

`GET /maps` and `GET /maps/{map_id}` additionally report
`"room_status": "ok|partial|unavailable"`, `"portal_source": "manual|selected|auto|none"`,
`"gravity_aligned": bool`, `"label"`.

---

## 7. Client flows

**Scan a room**

1. Record `video.mp4` + `session.jsonl` (+ mesh snapshot if available).
2. `POST /maps/{map_id}/recording` → keep `job.job_id`.
3. Every 1–2 s `GET /jobs/{job_id}`: show `progress` (percent), `stage_index`
   / `stage_count` and `stage`. Stop on `succeeded` / `failed` / `cancelled`.
4. On success: `job.result.room` and `job.result.portal` say what was found.
   Optionally `GET /maps/{map_id}/room` and draw it right away (same AR
   session, see section 2).

**Use a room (every later session)**

1. `POST /localize` with frames + AR poses as in v1 (`session_id` for
   multi-frame alignment).
2. When `alignment.status == "ok"`:
   * place the doorway at `alignment.portal` (if `source != "none"`);
   * draw `alignment.room` (walls as quads/outlines from `corners`, room
     corners from `corners[].bottom`/`top`, the opening from
     `openings[].corners`).
3. `portal.source == "none"` → tell the user that no doorway was found; offer
   manual placement (v1 anchor `PUT`, form 2) or a new scan.

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

**Not verified: anything on a real room recorded with the phone.** No such
recording exists yet. In particular unknown: how well the depth network and
the door detector behave in the owner's room, and whether ARCore poses are good
enough over a whole scan.

## Change log

* 2026-11-20 — first draft.
* 2026-11-20 — implemented. Added (no changes to drafted fields):
  `openings[].height_measured`, `key_frames`, `stats`, source `sfm_points`;
  recording advice changed from "turns/walks" to "walks" (parallax is needed).
