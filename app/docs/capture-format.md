# Capture format — what the app records and sends for a room scan

Version 1, **draft**. Written for the localization server (`POST /maps/{map_id}/recording`
in `localization-server/docs/api-v2.md`): the server's upload handler follows this
document.

Every statement below carries its source:

- **[lib]** read from the ViroReact 3.2.2 library (TypeScript sources, and string
  constants of the compiled Android recorder `ARSessionRecorder`) — not yet seen in a
  file from a phone;
- **[app]** produced by this app's own code, so it is as described;
- **[device]** checked in a capture made on a phone (Xiaomi 14 Ultra, Android 16).

Nothing is marked [device] yet. The section [Open points](#open-points) lists what the
first capture from a phone has to settle; this document is updated then.

## 1. A capture

One capture is one folder on the phone, in the app's private storage:

```
files/captures/capture-YYYYMMDD-HHMMSS/        local time of the start
  video.mp4        camera video                                   [lib]
  session.jsonl    camera intrinsics, one pose per video frame    [lib]
  planes.json      the planes the AR session detected             [app]
  world_mesh.*     the AR engine's fused mesh of the room         [lib], may be missing
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
| `mesh` | `world_mesh.*` if it exists and is OBJ or PLY (see section 5); otherwise not sent |
| `planes` (proposed, not in the draft contract) | `planes.json` |

The app currently sends `video`, `session_jsonl`, `mesh` + `mesh_format` (only when a
`world_mesh.obj` or `world_mesh.ply` exists), `replace=true` and `label`; `planes.json`
stays on the phone until the contract has a field for it.

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
applied as `R = Rz · Ry · Rx`. Quaternions are `[x, y, z, w]` (see open point 2).

## 3. `video.mp4` and `session.jsonl` [lib]

The recorder takes ARCore's camera image (not the rendered screen: **no virtual
objects** in the video) and encodes it as H.264 in an MP4 container.

- Pixels are in the **sensor's native orientation** (landscape for a phone held upright);
  the upright orientation is written as a rotation hint in the container. The app is
  locked to portrait.
- Resolution and frame rate: whatever the recorder chooses — see open point 4.
- No audio track is expected (open point 5).

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
  (sensor-native orientation); `width` × `height` is that frame's size.
- `pose`: one line per encoded video frame, in order — the n-th `pose` line belongs to
  the n-th frame. `t` is a timestamp in nanoseconds; a frame's time in the video is
  `t − t(first pose)`. `position` is the camera position in the AR world frame, metres.
  `orientation` is the camera orientation as a quaternion (order: open point 2).
  `gravity` is a 3-vector (frame and sign: open point 3).
- `imu`: raw accelerometer / gyroscope samples. Not needed for the map.

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
  wall into the room (ARCore's convention; open point 6).
- `planes[].alignment`, `classification`: as reported by the engine (`Vertical`,
  `HorizontalUpward`, `HorizontalDownward`, `Horizontal`; classification is usually empty
  on Android).
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

## 5. `world_mesh.*` [lib]

The AR engine can fuse its depth images into one mesh of the room ("world mesh",
accumulated while the scan mode is on). The app asks the engine to write it to a file
with `snapshotWorldMeshToFile` and copies that file into the capture as
`world_mesh.<extension the engine chose>`.

Known from the library: the mesh comes from ARCore's depth images (source `depth`) or,
without depth, from the plane polygons (source `plane`); voxel size 4 cm; depth range
5 m. **Not known**: the file format, and whether the call works outside the library's own
cloud-scan workflow at all (the app passes an identity transform so that the mesh stays
in the AR world frame). See open point 1. Until that is settled the server must not rely
on a mesh being present.

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

## Open points

Settled by the first capture pulled from a phone:

1. **World mesh**: does `snapshotWorldMeshToFile` produce a file with an identity
   transform; format (OBJ, PLY, something else); frame and units; size for a room.
2. **Quaternion order** of `pose.orientation` (`[x, y, z, w]` assumed) and whether it is
   the camera-to-world rotation of ARCore's camera frame (X right, Y up, −Z forward in
   sensor or in display orientation).
3. **`gravity`**: frame and sign.
4. **Video**: resolution, frame rate, the rotation hint's value for a phone held upright,
   and whether the number of `pose` lines equals the number of video frames.
5. **Audio**: whether the file has an audio track, and whether the recorder asks for the
   microphone permission.
6. **Planes**: whether `vertices` are plane-local with `y` ≈ 0 as assumed, and which way
   wall normals point.
