# Capture format — what the app records and sends for a room scan

Version 1, checked against captures from a phone on 2026-11-20 (two short ones, 15 and
18 frames; a full room scan has not been examined yet). Written for the localization server (`POST /maps/{map_id}/recording`
in [`localization-server/docs/api-v2.md`](https://github.com/BRANDAY/arportal-localization-server/blob/main/docs/api-v2.md)): the server's upload handler follows this
document.

Every statement below carries its source:

- **[lib]** read from the ViroReact 3.2.2 library (TypeScript sources, and string
  constants of the compiled Android recorder `ARSessionRecorder`) — not yet seen in a
  file from a phone;
- **[app]** produced by this app's own code, so it is as described;
- **[device]** checked in a capture made on a phone (Xiaomi 14 Ultra, Android 16).

The section [Checked on a device](#checked-on-a-device) lists what the first captures
settled and what is still open.

## 1. A capture

One capture is one folder on the phone, in the app's private storage:

```
files/captures/capture-YYYYMMDD-HHMMSS/        local time of the start
  video.mp4        camera video                                   [lib]
  session.jsonl    camera intrinsics, one pose per video frame    [lib]
  planes.json      the planes the AR session detected             [app]
  world_mesh.bin   the AR engine's fused mesh of the room         [device], may be missing
  world_mesh.ply   the same mesh converted by the app             [app], may be missing
  capture.json     bookkeeping: times, recorder result            [app]
```

`video.mp4` and `session.jsonl` are written by ViroReact's session recorder
(`startRecording(outputDir)` / `stopRecording()`); the other files are written by the app
when the recording stops. A capture made with "Save mesh" alone has no `video.mp4` and no
`session.jsonl`.

Mapping to the upload request of `api-v2.md`:

| Multipart field | File |
| --- | --- |
| `video` | `video.mp4` |
| `session_jsonl` | `session.jsonl` |
| `mesh` + `mesh_format=ply` | `world_mesh.ply` if it exists (see section 5); otherwise not sent |
| `planes` (proposed, not in the draft contract) | `planes.json` |

The app currently sends `video`, `session_jsonl`, `mesh` + `mesh_format` (only when a
`world_mesh.ply` exists), `replace=true`, `device_id` and `label`; `planes.json` stays on
the phone until the contract has a field for it.

`planes.json` is a proposal to the server: it is small, always available (the fused mesh
is not), already sorted into walls / floor / ceiling, and a wall plane with a hole or a
gap between two wall planes is a direct hint for a door opening.

## 2. Coordinate frame

Everything in a capture is in **the AR world frame of the session that recorded it**:

- metres;
- right-handed, **+Y up** (gravity-aligned);
- origin and heading: where the phone was when the AR session started, looking along
  **−Z** (ARCore's convention);
- the frame is fixed for the session and is the same for `session.jsonl`, `planes.json`
  and the mesh. A new app start is a new frame.

Rotations in the app's own files are ViroReact Euler angles in degrees `[x, y, z]`,
applied as `R = Rz · Ry · Rx`. Quaternions are `[x, y, z, w]` [device].

## 3. `video.mp4` and `session.jsonl` [device]

The recorder takes ARCore's camera image (not the rendered screen: **no virtual
objects** in the video) and encodes it as H.264 (`avc1`) in an MP4 container.

- **1920 x 1080 pixels in the sensor's native orientation** (landscape, although the
  phone is held upright). The container carries a rotation of **90 degrees clockwise**
  (track matrix `[0 1; -1 0]`): a player that honours it shows an upright 1080 x 1920
  picture. The app is locked to portrait.
- **Variable frame rate.** The time between frames in the two captures was 33 to 133 ms
  (15 frames in 0.87 s, about 16 frames per second on average); the track's time scale
  is 90 000. Do not assume 30 fps: take frame times from the container or from the `t` of
  the pose lines.
- One video track, **no audio track**. The recorder does not ask for the microphone: the
  permission `RECORD_AUDIO` is declared by the library but was never requested or granted.

**Image and pose are in different orientations.** The pose of a frame (below) is given
for the camera frame of the *upright* picture (X right, Y up on the portrait screen),
while the stored pixels and the intrinsics are those of the *landscape* sensor image. To
use them together, either rotate each frame 90 degrees clockwise and the intrinsics with
it (`fx' = fy`, `fy' = fx`, `cx' = height - cy`, `cy' = cx`, size 1080 x 1920), or keep
the landscape image and turn the camera frame by 90 degrees about its Z axis.

`session.jsonl` is one JSON object per line. Line types, with the recorder's format
strings:

```
{"type":"header","intrinsics":{"fx":%.4f,"fy":%.4f,"cx":%.4f,"cy":%.4f,"width":%d,"height":%d},
 "extrinsics":{"q_imu_cam":[0,0,0,1],"p_imu_cam":[0,0,0],"time_offset":0.0},"depth":%b}
{"type":"pose","t":%d,"orientation":[%.6f,%.6f,%.6f,%.6f],"position":[%.6f,%.6f,%.6f],
 "gravity":[%.6f,%.6f,%.6f]}          optionally with ,"gps":{"lat","lon","alt","h_accuracy","heading","heading_accuracy"}
{"type":"imu","t":%d,"accel":[...],"gyro":[...]}
{"type":"depth",...}                   only when depth capture is on; the app does not turn it on
```

- `header`: first line, once. `intrinsics` are in pixels of the video frame as stored
  (landscape, 1920 x 1080). Seen on the Xiaomi 14 Ultra: `fx` 1315.49, `fy` 1304.20,
  `cx` 970.97, `cy` 549.04. `extrinsics` is the constant shown above; `depth` is `false`.
- `pose`: one line per encoded video frame, in order — the n-th `pose` line belongs to
  the n-th frame (15 lines for 15 frames, 18 for 18).
  - `t`: nanoseconds of a clock that counts from the phone's start (not the time of
    day); a frame's time in the video is `t − t(first pose)`.
  - `position`: camera position in the AR world frame, metres.
  - `orientation`: unit quaternion **`[x, y, z, w]`**, rotation **from the camera frame
    to the world frame**. The camera frame is X right, Y up, −Z forward **as seen on the
    upright (portrait) screen**. Check from a capture: with the phone held upright,
    `R · [0, 1, 0]` was `[0.26, 0.97, 0.03]` (up) and `R · [0, 0, −1]` matched the
    viewing direction the app showed.
  - `gravity`: the accelerometer reading at that frame in the camera frame above, m/s²,
    length 9.81, **pointing up** (it is the reaction to gravity, not gravity itself):
    `R · gravity` was `[−0.31, 9.80, −0.05]` and `[−0.09, 9.80, 0.17]`. In the **first**
    pose line it is `[0, 0, 0]`.
- `imu`: raw accelerometer (m/s²) and gyroscope (rad/s) samples, about 57 per second,
  same clock as the poses. Not needed for the map.

## 4. `planes.json` [app]

The app's own model of the room, built from the plane anchors of the AR session at the
moment the recording stopped. UTF-8 JSON, one object:

```json
{
  "format": "arportal-planes",
  "version": 1,
  "frame": "AR world frame of the recording session: metres, right-handed, +Y up",
  "rotation_convention": "Euler degrees [x,y,z], R = Rz*Ry*Rx (ViroReact)",
  "floor_y": -1.37,
  "planes": [
    {
      "id": "…",
      "kind": "wall",
      "alignment": "Vertical",
      "classification": "",
      "position": [x, y, z],
      "rotation_euler_deg": [rx, ry, rz],
      "normal": [nx, ny, nz],
      "area_m2": 4.2,
      "vertices": [[x, y, z], …],
      "vertices_local": [[x, 0, z], …]
    }
  ],
  "corners": [
    { "position": [x, y, z], "height_m": 2.4, "wall_ids": ["…", "…"] }
  ],
  "raw_anchors": [ … ]
}
```

- `floor_y`: world Y of the floor, or `null` when no upward-facing plane was found. It
  is the height of the lowest upward-facing plane of at least 0.5 m² (of the lowest one
  of any size when there is no such plane).
- `planes[].kind`:
  - `wall` — vertical plane;
  - `floor` — upward-facing plane within 0.15 m of `floor_y`;
  - `surface` — upward-facing plane higher than that (table, bed, shelf);
  - `ceiling` — downward-facing plane.
- `planes[].position`, `rotation_euler_deg`: pose of the plane's own frame in the world
  frame. In its own frame the plane spans X and Z, and +Y is its normal.
- `planes[].vertices_local`: the boundary polygon in the plane's frame (`y` = 0), in the
  order the AR engine reports it. `vertices`: the same points in the world frame
  (`position + R · vertex_local`). The polygon is simple (no holes) and need not be
  convex. If the engine gave no polygon, it is the rectangle of the plane's extent.
- `planes[].normal`: unit vector, `R · [0, 1, 0]`. For a wall it points away from the
  wall into the room (ARCore's convention; not yet checked on a device, see below).
- `planes[].alignment`, `classification`: as reported by the engine (`Vertical`,
  `HorizontalUpward`, `HorizontalDownward`, `Horizontal`). The floor planes of the first
  captures had the classification `Floor` [device].
- `corners`: where two walls meet. `position` is on the floor (`y` = `floor_y`, or the
  lowest point of the two walls when the floor is unknown); `height_m` is how far the
  lower of the two walls reaches above it. Two walls give a corner when their directions
  differ by at least 30° and their intersection line lies no more than 0.6 m beyond the
  detected end of either wall. This is the app's guess for drawing; the server should
  work from `planes`.
- `raw_anchors`: the anchors as ViroReact delivered them (`anchorId`, `position`,
  `rotation`, `center`, `width`, `height`, `alignment`, `classification`, `vertices`),
  for debugging.

Planes describe only what the AR session found: weakly textured walls are often missing
or partial, and the planes of one wall can overlap.

## 5. `world_mesh.bin` and `world_mesh.ply` [device]

The AR engine fuses its depth images into one mesh of the room ("world mesh",
accumulated while the scan mode is on; voxel size 4 cm, depth range 5 m). On the Xiaomi
14 Ultra it reported the source `depth`, and after ten seconds of looking around about
100 000 triangles. The app asks the engine to write the mesh to a file
(`snapshotWorldMeshToFile` with an identity transform, so the mesh stays in the AR world
frame) and copies that file into the capture as `world_mesh.bin`.

`world_mesh.bin` is the engine's own format, "RVWM" version 1, little-endian. The layout
below was worked out from two snapshots (the library does not document it):

```
bytes 0-3     "RVWM"
byte  4       version = 1
bytes 5-8     V = number of vertices   (uint32)
bytes 9-12    T = number of triangles  (uint32)
V x 3 float32    positions x, y, z   metres, AR world frame
V x float32      one value per vertex, 0...1 (presumably the depth confidence; not verified)
T x 3 uint32     vertex indices of the triangles
```

Sizes seen: 239 kB (6 560 vertices, 11 170 triangles) and 1.86 MB (50 321 vertices,
88 212 triangles).

`world_mesh.ply` is the same mesh converted by the app (`src/room/meshFormat.ts`), and
the file that is uploaded as `mesh`: binary little-endian PLY, vertex properties
`float x, y, z, confidence`, faces as `list uchar int vertex_indices`, coordinates
unchanged. It is missing if the conversion failed (the reason is in `capture.json`).

The mesh exists only while the scan mode is on; a recording made with the scan mode off
has no mesh. Not checked yet: how well the mesh agrees with the camera poses and with
the real walls.

## 6. `capture.json` [app]

```json
{
  "format": "arportal-capture",
  "version": 1,
  "started_utc": "2026-11-20T17:12:03.120Z",
  "stopped_utc": "2026-11-20T17:13:31.560Z",
  "recording": { "success": true, "durationSec": 88.4, "frames": 2652, "depthFrames": 0, "gpsFixes": 0, "bytes": 123456789 },
  "world_mesh": "saved world_mesh.obj (812 kB, from …)",
  "mesh_stats": { "available": true, "reason": "", "vertexCount": 0, "triangleCount": 0, "source": "depth", "accumulated": true }
}
```

`recording` is the recorder's own result object; `world_mesh` is a human-readable note
on what happened to the mesh snapshot; `mesh_stats` is the engine's last report. For
people and debugging, not for the server.

## Checked on a device

Xiaomi 14 Ultra, Android 16, two captures of 2026-11-20 (15 and 18 frames, phone held
upright). The six points that were open in the draft:

| # | Question | Answer |
| --- | --- | --- |
| 1 | World mesh: does the snapshot work with an identity transform, which format | **Settled.** It works; the file is the engine's binary "RVWM" format, not OBJ or PLY. The app converts it to PLY (section 5) |
| 2 | Quaternion order and frame of `pose.orientation` | **Settled.** `[x, y, z, w]`, camera to world, camera frame of the upright screen (section 3) |
| 3 | `gravity`: frame and sign | **Settled.** Camera frame, pointing up, 9.81 m/s²; zero in the first pose line (section 3) |
| 4 | Video: resolution, frame rate, rotation, poses per frame | **Settled.** 1920 x 1080 landscape with a 90° clockwise rotation tag; variable frame rate, about 16 fps; one pose line per frame (section 3) |
| 5 | Audio track, microphone permission | **Settled.** No audio track, the microphone is not asked for (section 3) |
| 6 | Planes: are `vertices` plane-local, which way do wall normals point | **Half settled.** The anchors' vertices are plane-local with `y` = 0, and `center` is `[0, 0, 0]`. **Open:** the direction of wall normals - no vertical plane was detected in these captures |

Changed against the draft, for whoever reads the files:

- the camera frame of the poses is that of the **upright** picture, while pixels and
  intrinsics are **landscape** - they have to be brought together (section 3);
- the frame rate is variable and about half of what a 30 fps assumption gives;
- `gravity` points up and is zero in the first pose line;
- the mesh arrives as `world_mesh.ply` (binary PLY with an extra `confidence` property),
  no longer "OBJ or PLY, format unknown".

Still open:

- wall normals (point 6) and whether vertical planes are found at all in a normal room;
- a full recording of one to two minutes: its size, frame count, and how the upload and
  the server cope with it;
- how well the mesh matches the poses and the room.
