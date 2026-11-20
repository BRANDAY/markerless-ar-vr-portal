# locserver — self-hosted markerless visual localisation

A small server that recognises a previously scanned room from a single camera
image and tells an AR app where a virtual object (here: a doorway, the "portal")
has to be placed so that it appears at the same real-world position in every
app session — without markers, QR codes, GPS or manual placement, and without a
paid cloud service.

It is the self-hosted alternative to ViroReact's cloud VPS / Google Cloud
Anchors for the "Markerless AR-to-VR Portal" proof of concept. It is an
independent project: the mobile app talks to it over HTTP on the local Wi-Fi.

```
            ONCE (offline)                                EVERY APP SESSION (online)

 room video / images / AR recording            phone: camera image (+ its AR camera pose)
              │                                              │  HTTP POST /localize
              ▼                                              ▼
   ┌────────────────────┐                      ┌──────────────────────────────┐
   │  locserver-build-  │                      │  locserver-serve  (FastAPI)  │
   │  map (CLI)         │                      │                              │
   │                    │                      │  ALIKED keypoints            │
   │  frame selection   │                      │  VLAD retrieval: top-k map   │
   │  (subsample, blur) │                      │    images                    │
   │  ALIKED keypoints  │      map directory   │  LightGlue 2D-2D matches     │
   │  LightGlue matches │ ───────────────────► │    -> 2D-3D correspondences  │
   │  COLMAP SfM        │   features.npz       │  PnP + RANSAC (COLMAP)       │
   │  (+ metric scale   │   map.json           │    -> camera pose in the map │
   │   if AR poses)     │   anchors.json       │  + AR camera pose            │
   └────────────────────┘                      │    -> T_arworld_from_map     │
                                               │    -> anchor "portal" in AR  │
                                               │       world (pos + Euler)    │
                                               └──────────────────────────────┘
```

Contents: [Stack](#stack-and-licences) · [Setup](#setup-windows) ·
[Build a map](#build-a-map) · [Run the server](#run-the-server) ·
[API](#api-reference) · [Conventions](#coordinate-conventions) ·
[App integration](#how-the-mobile-app-is-expected-to-call-it) ·
[Measured numbers](#measured-numbers) · [Limitations](#limitations-and-what-is-not-verified)

---

## Stack and licences

The pipeline is the "hierarchical localisation" recipe (retrieve similar map
images → match local features → PnP), built from these parts:

| Part | What | Licence | Source |
|---|---|---|---|
| ALIKED (`aliked-n16`) | learned keypoints + 128-d descriptors | BSD-3-Clause | <https://github.com/Shiaoming/ALIKED> |
| LightGlue (ALIKED weights) | learned feature matcher | Apache-2.0 | <https://github.com/cvg/LightGlue> |
| COLMAP via `pycolmap` 4.2 | SfM (mapping), PnP + RANSAC (localisation) | BSD-3-Clause | <https://github.com/colmap/colmap> |
| VLAD over ALIKED descriptors | global descriptor for retrieval (own code, codebook trained on the map) | — (this project) | `src/locserver/features.py` |
| PyTorch 2.14.1 + cu126 | inference | BSD-3-Clause | <https://pytorch.org> |
| FastAPI / Uvicorn | HTTP API | MIT / BSD-3-Clause | |
| OpenCV | image and video decoding | Apache-2.0 | |

No SuperGlue and no SuperPoint are used (both are non-commercial); every
component above is permissively licensed. This project itself: Apache-2.0.

**Why not `hloc` itself.** `hloc` (cvg/Hierarchical-Localization) was checked
first: its `main` branch does *resolve* for Python 3.13 on Windows together
with `pycolmap` 4.2.1 (`uv pip compile`, 2026-11-20), but it was not adopted:

* it is a batch toolbox built around HDF5 feature files and text pair lists; a
  server needs one in-memory query in ~1 s without touching the disk;
* its last changelog entry is from 2023 and `pycolmap` 4.x changed the database
  and pose APIs (rigs/frames), so each `hloc` code path would have had to be
  verified separately anyway;
* it pulls extra dependencies (h5py, gdown, plotly, kornia, third-party
  submodules such as NetVLAD weights from mirrors) that are not needed here.

So the same recipe is implemented directly on LightGlue + `pycolmap` (about
1,500 lines), which also keeps every step testable.

**Retrieval.** For a single room a heavy global-descriptor network is not
needed. The server aggregates the ALIKED descriptors of an image into a VLAD
vector (32 clusters × 128 d, codebook fitted on the map). No extra model, no
extra download, no extra licence.

### GPU support

The development PC has a GTX 1050 Ti (Pascal, 4 GB). Current PyTorch CUDA
builds (cu128 and newer) no longer contain kernels for Pascal cards. The last
official Windows wheels that do are the **CUDA 12.6** builds, and the last
PyTorch release shipping them is **2.14.1** (2.15 dropped cu126). The project
therefore pins `torch==2.14.1` from the `cu126` index; `torch.cuda.get_arch_list()`
reports `sm_61` and inference runs on the card. On a machine without a usable
GPU everything falls back to CPU automatically (`--device cpu` forces it).

---

## Setup (Windows)

Requirements: Windows 10/11, [uv](https://docs.astral.sh/uv/), git, ~7 GB of
disk for the environment. Python 3.13 is installed by uv if missing. No conda,
COLMAP binary, ffmpeg, Docker or compiler is needed.

```powershell
cd localization-server
. .\env.ps1        # puts venv, caches and model weights on E:\VR-FESB (edit the file to change)
uv sync            # creates the environment and installs everything (~3 GB download)
uv run pytest      # 63 tests, a few seconds, no GPU needed
```

`env.ps1` must be dot-sourced in every new PowerShell window. It sets:

| Variable | Value | Purpose |
|---|---|---|
| `UV_PROJECT_ENVIRONMENT` | `E:\VR-FESB\venv` | the virtual environment (~6 GB) |
| `UV_CACHE_DIR` | `E:\VR-FESB\uv-cache` | uv's package cache |
| `TORCH_HOME` | `E:\VR-FESB\torch` | model weights (downloaded on first use, 48 MB) |
| `HF_HOME` | `E:\VR-FESB\hf` | Hugging Face cache (not used by the default models) |
| `LOCSERVER_DATASETS` | `E:\VR-FESB\datasets` | public test data |
| `LOCSERVER_WORK` | `E:\VR-FESB\work` | evaluation reports, upload scratch space |

Set `LOCSERVER_ROOT` before sourcing it to use another drive. Optional:
`LOCSERVER_MAPS_DIR` (default `data\maps` in the project) and
`LOCSERVER_CALIB_DIR` (default `data\calibration`).

---

## Build a map

A map is built once from a walk through the room.

```powershell
# your own room: put the video at data\input\room.mp4
uv run locserver-build-map data\input\room.mp4 --map-id room

# the public test sequence (see "Downloads")
uv run locserver-build-map E:\VR-FESB\datasets\tum_fr1_room\rgbd_dataset_freiburg1_room --map-id tum_room --every 8
```

Accepted inputs:

| Input | Scale of the map |
|---|---|
| video file (`.mp4`, `.mov`, …); the phone's rotation tag is honoured | arbitrary ("map units") |
| folder of images | arbitrary |
| ViroReact AR recording folder (`video.mp4` + `session.jsonl`) | **metric**, map frame = AR world of the mapping session (y up) |
| TUM RGB-D sequence folder (`rgb.txt` + `groundtruth.txt`) — test data | **metric** (motion-capture frame) |

What happens: frames are subsampled (`--fps 3` by default, at most
`--max-frames 200`), from every window only the sharpest frame is kept, frames
far below the median sharpness are rejected, images are scaled to
`--max-size 1024`; ALIKED features are extracted; each frame is matched with its
6 successors and its 8 most similar other frames (loop closure); COLMAP
verifies the matches and runs incremental SfM with a single shared camera whose
focal length and radial distortion are self-calibrated. In a sequential capture,
short runs of images that "jump" off the camera path (a step more than 8× the
median step away and back) are treated as wrongly registered and left out of
the map (`dropped_outlier_images` in `map.json`).

If the capture carries metric camera poses (AR recording, test data), they are
used twice: as position priors inside COLMAP's bundle adjustment (σ = 5 cm,
robust loss), which stops the model from drifting, and for a final RANSAC
similarity fit that makes the map metric. `map.json` reports how well the model
agrees with those poses (`metric_alignment`: inliers within 10 cm, RMS, max).
`--no-pose-priors` keeps only the final fit, `--no-poses` ignores the poses.

A plain video cannot tell how large the room is, so its map is **not metric**
(`"metric": false` in `GET /maps`). The scale is then obtained from the phone's
AR tracking at run time — see [alignment](#alignment-to-the-ar-session).

Tips for the mapping video (they matter more than any parameter):

* walk slowly (≈ 0.3 m/s) and move sideways — pure rotation on the spot gives
  no depth; 40–90 s is plenty for one room;
* cover the area around the future doorway from the positions and heights from
  which users will look at it; close the loop (end where you started);
* landscape or portrait both work, but use the orientation the app will use;
* lights on, no people walking through, avoid pointing at blank walls only.

The output is printed as JSON (registered images, 3D points, reprojection
error, timings) and stored in `data\maps\<map-id>\`:

```
map.json        metadata: metric flag, scale, camera, statistics, build options and timings
anchors.json    named poses in map coordinates (edited through the API)
features.npz    everything the server needs: keypoints, descriptors, 3D points, poses, VLAD index
sfm\            the COLMAP model (open it with the COLMAP GUI if you like)
points.ply      the sparse point cloud (MeshLab, CloudCompare)
images\         the mapping frames
```

Rebuilding a map (`--overwrite`) creates a new coordinate frame; existing
anchors are therefore moved aside to `anchors.stale.json` instead of being kept.

---

## Run the server

```powershell
. .\env.ps1
uv run locserver-serve                 # 0.0.0.0:8077, all maps in data\maps
uv run locserver-serve --port 8077 --device cpu --maps-dir D:\maps
```

Interactive API docs: <http://localhost:8077/docs>. From the phone use the PC's
LAN address, e.g. `http://192.168.1.74:8077` (Wi-Fi) — phone and PC must be on
the same network.

**Firewall.** Windows blocks inbound connections by default. The server does
not change system settings; run this once in an *administrator* PowerShell:

```powershell
New-NetFirewallRule -DisplayName "locserver 8077" -Direction Inbound -Protocol TCP -LocalPort 8077 -Action Allow -Profile Private
```

(remove it again with `Remove-NetFirewallRule -DisplayName "locserver 8077"`).

Quick check without a phone:

```powershell
curl.exe http://localhost:8077/health
curl.exe -F "image=@data\maps\tum_room\images\000400.jpg" -F "map_id=tum_room" http://localhost:8077/localize
uv run locserver-localize some_photo.jpg --map-id tum_room      # same thing without the server
```

---

## API reference

All responses are JSON. Errors use HTTP status codes with `{"detail": "..."}`
(404 unknown map/anchor, 413 upload too large, 422 bad input).

### `GET /health`

```json
{"status": "ok", "version": "0.1.0", "device": "cuda", "device_name": "NVIDIA GeForce GTX 1050 Ti",
 "models": {"extractor": "aliked-n16", "matcher": "lightglue-aliked", "max_keypoints": 2048},
 "maps": ["tum_room"], "sessions": 0, "uptime_s": 12.3}
```

### `GET /maps` · `GET /maps/{map_id}` · `POST /maps/reload`

`GET /maps` lists the loaded maps with `metric`, `scale_m_per_unit`,
`num_images`, `num_points3D` and anchor names. `GET /maps/{map_id}` returns the
full `map.json` plus the anchors. `POST /maps/reload` rescans the maps
directory (after building a map while the server is running).

### Anchors: `GET|PUT|DELETE /maps/{map_id}/anchors/{name}` · `GET /maps/{map_id}/anchors`

An anchor is a named rigid pose in map coordinates — the doorway's predefined
position lives here as anchor `portal`. Two ways to store one:

```powershell
# 1. directly in map coordinates (rotation optional: quaternion_xyzw or rotation_euler_deg)
curl.exe -X PUT http://localhost:8077/maps/room/anchors/portal -H "Content-Type: application/json" -d '{\"position\": [2.0, 0.0, -3.0], \"rotation_euler_deg\": [0, 90, 0], \"note\": \"doorway\"}'

# 2. authoring from the app: "the doorway is HERE in my current AR session"
#    (pose of the doorway in AR world + the alignment of that session)
curl.exe -X PUT http://localhost:8077/maps/room/anchors/portal -H "Content-Type: application/json" -d '{\"ar_pose\": {\"position\": [0.4, 0.0, -2.1], \"rotation\": [0, 35, 0]}, \"session_id\": \"author-1\"}'
```

In form 2 the alignment is taken from `session_id` (a session that already has
a complete alignment) or passed explicitly as `"T_arworld_from_map": [[4x4]]`.
The second form is how the portal position is "predefined" in practice: once,
at authoring time, somebody places the doorway by hand in AR and stores it;
every later session restores it automatically.

`GET` returns `{"map_id", "name", "frame": "map", "position": [x,y,z],
"quaternion_xyzw": [x,y,z,w], "note", "updated_utc"}`.

### `POST /localize` (multipart/form-data)

| Field | Type | Meaning |
|---|---|---|
| `image` | file | JPEG/PNG camera image. Exactly one of `image` / `video`. |
| `video` | file | short clip; the sharpest frame of each of `max_frames` (default 3) equal parts is localised |
| `session_jsonl` | file | ViroReact `session.jsonl` belonging to `video`: gives per-frame AR poses and intrinsics |
| `map_id` | text | may be omitted if exactly one map is loaded |
| `fx, fy, cx, cy` | numbers | optional intrinsics of the uploaded image in pixels; `width, height` if they refer to another resolution |
| `intrinsics_mode` | `auto` \| `map` | `map`: the image comes from the same camera and zoom as the mapping capture |
| `device_id` | text | enables the per-device focal-length cache (see below) |
| `image_rotation_cw` | 0/90/180/270 | rotate the upload clockwise by this to make it upright (intrinsics are rotated with it) |
| `ar_pose` | JSON text | AR camera pose of this frame: `{"position":[x,y,z], "forward":[..], "up":[..]}` or `{"position":[..], "rotation":[ex,ey,ez]}` — exactly what ViroReact's `onCameraTransformUpdate` delivers |
| `ar_position`, `ar_rotation`, `ar_forward`, `ar_up` | `"x,y,z"` | the same as separate fields |
| `session_id` | text | accumulate observations of one app session (see alignment) |
| `persist_scale` | bool | store a reliably estimated scale in the map |

```powershell
curl.exe -F "image=@frame.jpg" -F "map_id=room" -F "device_id=pixel7" -F "session_id=run42" `
  -F "ar_pose={\"position\":[0.5,1.5,-1.0],\"forward\":[-1,0,0],\"up\":[0,1,0]}" http://192.168.1.74:8077/localize
```

Response (shortened):

```json
{
  "success": true,
  "quality": "good",
  "reason": null,
  "map_id": "room", "map_metric": false, "map_scale_m_per_unit": null,
  "pose": {
    "T_map_from_cvcam": [[..4x4..]],   "T_cvcam_from_map": [[..4x4..]],
    "T_map_from_arcam": [[..4x4..]],
    "position": [x, y, z],             "quaternion_xyzw": [x, y, z, w],
    "quaternion_xyzw_arcam": [x, y, z, w]
  },
  "num_keypoints": 1432, "num_matches": 612, "num_inliers": 388, "inlier_ratio": 0.634,
  "reprojection_error_px": {"mean": 1.9, "median": 1.6},
  "intrinsics_used": {"fx": 742.1, "fy": 742.1, "cx": 512.0, "cy": 384.0, "width": 1024, "height": 768, "hfov_deg": 69.2},
  "intrinsics_source": "estimated",
  "working_size": [1024, 768],
  "retrieved": [{"image": "000412.jpg", "matches_3d": 231}, "..."],
  "thresholds": {"good": {"min_inliers": 60, "min_inliers_if_focal_estimated": 100, "min_inlier_ratio": 0.25},
                 "weak": {"min_inliers": 25, "min_inliers_if_focal_estimated": 40}, "ransac_max_error_px": 8.0},
  "timings_ms": {"extract": 150.2, "retrieve": 1.1, "match": 820.4, "pose": 9.8, "total": 985.0},
  "frames": [{"index": 0, "success": true, "quality": "good", "num_inliers": 388, "has_ar_pose": true, "T_cvcam_from_map": [[...]]}],
  "session": {"session_id": "run42", "num_observations": 3},
  "alignment": { "...": "see below" },
  "elapsed_ms": 1012.4
}
```

`pose` is the camera in the map: `T_map_from_cvcam` with OpenCV camera axes,
`T_map_from_arcam` the same camera with ViroReact/OpenGL axes; `position` is the
camera centre (identical for both); `quaternion_xyzw` belongs to
`T_map_from_cvcam`, `quaternion_xyzw_arcam` to `T_map_from_arcam`. Intrinsics
and reprojection errors refer to `working_size` (the image after rotation and
down-scaling to the map's `image_max_size`); the pose does not depend on it.

#### Quality verdict

| `quality` | Rule | Meaning for the client |
|---|---|---|
| `good` | inliers ≥ 60 (≥ 100 if the focal length was estimated) **and** inlier ratio ≥ 0.25 | use the pose |
| `weak` | inliers ≥ 25 (≥ 40 if the focal length was estimated) | plausible, do not rely on it alone; send more frames |
| `failed` | anything else (`success: false`, `pose: null`, `reason` says why) | not this room / view not mapped / too dark or blurred |

Inliers are 2D–3D correspondences within 8 px of the PnP solution at the
working resolution. A pose whose estimated horizontal field of view is outside
25°–130° is rejected. The thresholds are returned with every response and are
set in `LocalizeOptions` (`src/locserver/localize.py`).

#### Intrinsics

The server works without intrinsics. In order of preference it uses: the
intrinsics sent with the request → `intrinsics_mode=map` (the map's own
self-calibrated camera) → the cached calibration of `device_id` → estimating
the focal length inside PnP (principal point assumed at the image centre, no
distortion). `intrinsics_source` says which one was used.

Estimating the focal length from one image costs accuracy (see measured
numbers), mostly along the viewing direction. Therefore, when `device_id` is
sent, every `good` result with an estimated focal length adds one sample to a
per-device calibration; after 5 samples that agree within 3 % (robust spread)
it is locked and used as fixed intrinsics from then on (`GET /calibration`,
`DELETE /calibration/{device_id}`). Calibrations are per aspect ratio, because
a cropped video stream has a different field of view than a photo.

A ViroReact recording carries the real intrinsics in `session.jsonl`; when it
is uploaded with the clip they are used automatically.

### Alignment to the AR session

What the app needs is not the camera pose in the map but the transform from
the map to **its current AR world**, which is different in every session. When
an AR camera pose accompanies the image, the response contains:

```json
"alignment": {
  "status": "ok",
  "T_arworld_from_map": [[..4x4 similarity: upper-left 3x3 = scale * R ..]],
  "scale": 1.0,
  "scale_source": "map_metric",
  "scale_reliable": true,
  "rotation_quaternion_xyzw": [x, y, z, w], "translation": [x, y, z],
  "observations_total": 1, "observations_used": 1, "inlier_mask": [true],
  "position_rms_m": 0.0, "rotation_max_deg": 0.0, "baseline_m": 0.0, "scale_rel_std": null,
  "anchors": {
    "portal": {"position": [-2.5, 0.0, -1.0], "rotation_euler_deg": [0, 90, 0], "quaternion_xyzw": [0, 0.7071, 0, 0.7071]}
  },
  "ar_pose_pairing": "request", "from_weak_localization_only": false, "scale_persisted": false
}
```

`anchors.<name>.position` (metres) and `rotation_euler_deg` can be passed
straight to `<ViroNode position={...} rotation={...}>`; the node's content must
be authored in metres with scale 1.

`scale_source` / `status`:

| Situation | Result |
|---|---|
| metric map (`map_metric`) | one frame is enough: `status: "ok"` |
| non-metric map whose scale was calibrated before (`map_calibrated`) | one frame is enough |
| non-metric map, ≥ 2 frames of this session taken ≥ 0.15 m apart | scale estimated from the AR tracking (`estimated_from_session`), `status: "ok"` |
| non-metric map, one frame or no camera travel | `status: "scale_unknown"`: only the rotation is known, `T_arworld_from_map` is `null`, `anchors` is empty |

Multi-frame estimation (`src/locserver/geometry.py: align_observations`): each
observation pairs a localised frame with the AR pose of the same instant. The
rotation is the chordal mean of the per-frame rotations; scale and translation
are a least-squares fit of the camera centres given that rotation; outliers are
removed by RANSAC over all minimal sets (an observation is an inlier if its
camera centre fits within 0.10 m and its rotation within 5°). Plain Umeyama on
the camera centres alone is deliberately not used: users walk roughly straight,
and collinear points leave the rotation about the walking direction undefined.

`scale_reliable` is true when the camera travelled ≥ 0.5 m among ≥ 3 inlier
frames and the estimated relative scale uncertainty (`scale_rel_std`) is ≤ 5 %.
With `persist_scale=true` such a scale is written to the map
(`scale_source: "ar_session"`), after which single frames suffice. A scale can
also be set by hand: `PUT /maps/{map_id}/scale {"scale_m_per_unit": 0.37}`.

Two ways to supply several observations:

* **session id** — send `session_id` with every `/localize` call of one app
  run. The server keeps the observations (30 min idle timeout, last 60) and
  every response carries the alignment over all of them.
  `GET /sessions/{id}` returns the current alignment, `DELETE` forgets it.
  Start a new id whenever the AR session restarts (its world frame changes).
* **stateless** — `POST /align` with the observations collected by the client:

```json
{"map_id": "room", "persist_scale": false, "observations": [
   {"T_cvcam_from_map": [[..from pose.T_cvcam_from_map..]], "ar_pose": {"position": [..], "forward": [..], "up": [..]}, "weight": 388},
   {"T_cvcam_from_map": [[...]], "ar_pose": {"position": [..], "rotation": [..]}}
]}
```

A clip uploaded together with its `session.jsonl` already contains one AR pose
per frame, so a single request yields several observations.

---

## Coordinate conventions

**Notation.** `T_a_from_b` is a 4×4 matrix that maps homogeneous column vectors
from frame `b` to frame `a`: `X_a = T_a_from_b · X_b`. Its last column is the
origin of `b` expressed in `a`. Matrices are JSON arrays of 4 rows (row-major).
Quaternions are `[x, y, z, w]` (unit, Hamilton) and every JSON key holding one
ends in `_xyzw`.

| Frame | Axes | Units |
|---|---|---|
| `map` | the SfM model (COLMAP "world"); right-handed, orientation arbitrary unless built from an AR recording (then y up) | metres if `metric`, else arbitrary "map units" |
| `cvcam` | camera, COLMAP/OpenCV: **x right, y down, z forward** (into the scene) | as the map |
| `arcam` | camera, ViroReact/ARCore/OpenGL: **x right, y up, looking along −z** | metres |
| `arworld` | AR session world: right-handed, **y up** (gravity), origin and heading where tracking started | metres |
| `anchor` | object frame, ViroReact convention: x right, y up, +z out of the front face | metres |

The two camera conventions differ by a 180° turn about x:

```
X_arcam = diag(1, −1, −1) · X_cvcam
```

Pixel coordinates follow COLMAP: the centre of the top-left pixel is
(0.5, 0.5), `u = fx·x/z + cx`, `v = fy·y/z + cy` with (x, y, z) in `cvcam`.

**ViroReact rotations.** `rotation={[x, y, z]}` is in degrees and means

```
R = Rz(z) · Ry(y) · Rx(x)        (rotate about the fixed X axis first, then Y, then Z)
```

for column vectors in a right-handed frame. This was read from the renderer
source (`VROQuaternion::VROQuaternion(x, y, z)` in ReactVision/virocore builds
`q = qz ⊗ qy ⊗ qx`; `VROQuaternion::toEuler()`, which produces the `rotation`
of the camera callbacks, is its inverse with y limited to ±90°). The camera
callbacks report `position`, `rotation`, `forward = R·(0,0,−1)` and
`up = R·(0,1,0)` of the renderer camera. The server accepts either
`forward` + `up` (preferred: no Euler ambiguity, no gimbal lock) or `rotation`.

**The alignment formula.** With the PnP result `T_cvcam_from_map = [R_c | t_c]`
(map units), the AR camera pose `T_arworld_from_arcam = [R_a | p_a]` (metres)
and `s` metres per map unit:

```
X_arworld = s · R · X_map + t        R = R_a · diag(1,−1,−1) · R_c
                                     t = s · R_a · diag(1,−1,−1) · t_c + p_a
anchor in AR world:   position = s · R · p_anchor + t,    rotation = R · R_anchor
```

### Worked example

A metric map with y up; the portal anchor is at `[2, 0, −3]` in the map with
identity rotation (the doorway faces map +z).

1. The server localises a photo: the camera is at `[2, 1.5, 0]` in the map,
   upright, looking along map −z — i.e. straight at the doorway from 3 m,
   1.5 m above the floor. In COLMAP form:

   ```
   T_cvcam_from_map = [[1,  0,  0, −2.0],
                       [0, −1,  0,  1.5],
                       [0,  0, −1,  0.0],
                       [0,  0,  0,  1  ]]
   ```

2. In today's AR session ViroReact reports for the same instant
   `position = [0.5, 1.5, −1]`, `rotation = [0, 90, 0]` (so `forward = [−1, 0, 0]`,
   `up = [0, 1, 0]`): this session started with a different origin and heading.

3. `R = R_y(90°) · diag(1,−1,−1) · diag(1,−1,−1) = R_y(90°)` and
   `t = R_y(90°)·diag(1,−1,−1)·[−2, 1.5, 0] + [0.5, 1.5, −1] = [0.5, 0, 1]`:

   ```
   T_arworld_from_map = [[ 0, 0, 1, 0.5],
                         [ 0, 1, 0, 0  ],
                         [−1, 0, 0, 1  ],
                         [ 0, 0, 0, 1  ]]
   ```

4. Portal in the AR world: `R_y(90°)·[2, 0, −3] + [0.5, 0, 1] = [−2.5, 0, −1]`,
   rotation `[0, 90, 0]`. Check: the camera at `[0.5, 1.5, −1]` looks along −x;
   the portal is 3 m further along −x and 1.5 m lower — the same relation as in
   the map. The app renders
   `<ViroNode position={[-2.5, 0, -1]} rotation={[0, 90, 0]}>`.

This exact example is the test `test_localize_worked_example_from_readme`.

---

## How the mobile app is expected to call it

One-time authoring (per room):

1. Record the room, build the map on the PC (`locserver-build-map`), start the server.
2. In an authoring screen of the app: localise a few frames with a `session_id`
   until `alignment.status == "ok"`, let the author place the doorway in AR,
   then `PUT /maps/{map}/anchors/portal` with the doorway's AR pose and the
   `session_id`. (Or put map coordinates there by hand.)

Every normal session:

```
start AR session, wait until tracking is NORMAL
repeat every ~1–2 s while the user looks around / walks:
    frame    = current camera image (see note below)
    cam      = latest onCameraTransformUpdate value, captured at the same moment
    response = POST /localize  {image, map_id, device_id, session_id, ar_pose: cam}
    if response.alignment.status == "ok" and
       (response.quality == "good" or response.alignment.observations_used >= 3):
        p = response.alignment.anchors.portal
        show <ViroNode position={p.position} rotation={p.rotation_euler_deg}> … doorway … </ViroNode>
        stop (or keep refining every few seconds and update if the pose moves < 0.3 m)
on failure: keep trying; after ~10 s tell the user to look at a textured part of the room
```

Fetch example (React Native):

```js
const body = new FormData();
body.append('image', {uri: fileUri, name: 'frame.jpg', type: 'image/jpeg'});
body.append('map_id', 'room');
body.append('device_id', 'pixel7-arframe');
body.append('session_id', sessionId);            // new id for every AR session start
body.append('ar_pose', JSON.stringify({position: cam.position, forward: cam.forward, up: cam.up}));
const res = await fetch('http://192.168.1.74:8077/localize', {method: 'POST', body});
const {success, quality, alignment} = await res.json();
```

Notes for the app side:

* **Pairing matters.** The AR pose must belong to the very same instant as the
  image. A 100 ms mismatch while walking at 1 m/s is a 10 cm error. Capture the
  pose immediately before/after grabbing the frame and ask the user to hold
  still for the shot, or use the recording (`video.mp4` + `session.jsonl`),
  where each frame has its own pose.
* **Frame source.** ViroReact has no public "grab camera frame" call. The
  expected source is a ~1 s `startRecording()`/`stopRecording()` clip uploaded
  as `video` + `session_jsonl`. A screenshot of the AR view
  (`takeScreenshot`) also works as `image` as long as no virtual content is
  drawn over it; its field of view differs from the raw camera image, which
  the focal-length estimation / `device_id` cache absorbs.
* **Image orientation.** The server expects an upright image (as the user sees
  the scene). If you send a raw sensor image (landscape while the phone is held
  in portrait) add `image_rotation_cw=90` (or 270, depending on the device).
* **Cleartext HTTP.** Android blocks `http://` by default in release builds:
  allow it for the server's address (`android:usesCleartextTraffic="true"` or a
  network security config) — LAN only, there is no authentication.
* **Drift.** ARCore's world drifts slowly; re-localising every 10–20 s and
  re-placing the doorway only when it moved noticeably keeps it locked.

---

## Evaluation

```powershell
# A: hold out part of a map and localise it against the rest (works for any map, also your own)
uv run locserver-evaluate --map-id room --perturb all

# B: frames never used for the map, compared with independent ground truth (TUM test data)
uv run locserver-evaluate --map-id tum_room --gt-capture E:\VR-FESB\datasets\tum_fr1_room\rgbd_dataset_freiburg1_room --device both
```

Protocol A removes every 5th block of 4 consecutive map images (20 %) from the
map in memory, together with all 3D points that are then seen by fewer than two
remaining images, localises the removed images and compares with their SfM
poses. It needs no ground truth, but it is optimistic: the remaining 3D points
were triangulated with the help of the held-out views, and the queries come
from the same walk and lighting.

Protocol B localises frames that never entered SfM at all and compares with
the capture's own metric poses (motion capture for TUM, ARCore for a ViroReact
recording). This is the honest number; it includes the error of the map itself.
A small constant rotation between the pose source's body frame and the camera's
optical frame is estimated on the map images and removed from the query ground
truth (its size is printed), so that it is not counted as localisation error.

`--perturb` degrades the query images before localisation: `dark`, `bright`,
`low_contrast`, `gamma_bright`, `warm_tint`, `blur`, `downscale`, `noise`,
`dark_noise` (definitions in `src/locserver/evaluate.py`). It is a first proxy
for the lighting test, not a replacement for re-visiting the real room in the
evening. `--intrinsics map|estimate|both` compares known against unknown
intrinsics. A JSON report with every query is written to `LOCSERVER_WORK`.

## Measured numbers

MEASURED_NUMBERS_PLACEHOLDER

---

## Downloads

Everything was fetched from the official sources; nothing else is downloaded at
run time.

| What | Source | Size | Where |
|---|---|---|---|
| Python packages (PyPI): pycolmap 4.2.1, opencv-python 5.1.0, numpy, fastapi, uvicorn, python-multipart, kornia, …; dev: pytest, httpx, scipy, imageio-ffmpeg | <https://pypi.org> | ≈ 0.5 GB installed | `E:\VR-FESB\venv`, cache in `E:\VR-FESB\uv-cache` |
| torch 2.14.1+cu126, torchvision 0.29.1+cu126 | <https://download.pytorch.org/whl/cu126> | ≈ 2.5 GB download, ≈ 5 GB installed | same |
| LightGlue (code, commit `5a650c4`) | <https://github.com/cvg/LightGlue> | < 1 MB | same |
| ALIKED weights `aliked-n16.pth` | <https://github.com/Shiaoming/ALIKED/raw/main/models/aliked-n16.pth> | 2.6 MB | `E:\VR-FESB\torch\hub\checkpoints` |
| LightGlue weights `aliked_lightglue.pth` (v0.1_arxiv) | <https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv/aliked_lightglue.pth> | 45.4 MB | same |
| Test data: TUM RGB-D `freiburg1_room` (CC BY 4.0), RGB + ground truth extracted, depth skipped | <https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_room.tgz> | 782 MB archive | `E:\VR-FESB\datasets\tum_fr1_room` |

The test sequence is from: J. Sturm et al., "A Benchmark for the Evaluation of
RGB-D SLAM Systems", IROS 2012.

---

## Limitations and what is not verified

* **Nothing here has run against a real phone yet.** The ViroReact side
  (image source, pose pairing, image orientation, field of view of the frames)
  is implemented from documentation and from the open-source renderer code.
* **ViroReact recording reader** (`src/locserver/recording.py`): the
  `session.jsonl` schema was taken from the writer's source
  (`ARSessionRecorder.java` in ReactVision/virocore) and the reader is tested
  on synthetic recordings in that schema, including the container rotation tag.
  Still to confirm on a device (marked `TODO(device)` in the file): that the
  display-oriented pose matches the upright-rotated sensor image, the sign of
  the orientation hint, and frame/pose pairing when the encoder drops frames.
* **Whether `onCameraTransformUpdate` delivers degrees** was verified in source
  only for `getCameraOrientationAsync`; sending `forward` + `up` avoids the
  question.
* **Lighting, moved furniture, people** were only approximated by synthetic
  image perturbations. Real evening/daylight differences change shadows and
  reflections, which a brightness curve does not model.
* **Scale of a plain-video map** comes from ARCore at run time and inherits its
  error; a metric map from an AR recording avoids that but its reader is the
  unverified part above.
* **Accuracy needs parallax.** Far-away, low-texture or repetitive views
  (blank walls, ceilings, identical cabinet doors) give weak or failed results;
  the verdict thresholds are tuned on one public sequence only.
* **One room, one server.** Retrieval is a VLAD index held in memory; fine for
  a few hundred map images, not for a building. One localisation runs at a time
  (4 GB VRAM); requests queue.
* **No authentication, no TLS.** Intended for a trusted local network only.
* Timings on the development PC were measured while another application was
  using the same GPU (see the note in "Measured numbers").
