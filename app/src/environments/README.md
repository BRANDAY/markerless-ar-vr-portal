# Environments (the virtual world behind the portal)

Each environment is one self-contained React component that draws the world in the doorway's local
frame, the same frame `VirtualRoom` uses:

- origin **on the floor, in the middle of the threshold**;
- **+Y** up, the world extends towards **−Z**, **+Z** is the real-world side;
- metres, scale 1:1.

So an environment is a drop-in replacement for `<VirtualRoom />` inside the `ViroPortalScene`:

```tsx
import { SponzaAtrium } from '../environments/SponzaAtrium';

<ViroPortalScene passable ...>
  <ViroPortal>{/* door frame model */}</ViroPortal>
  <ViroSkyBox color="#070716" />            {/* fallback colour; the model has its own sky dome */}
  <ViroNode position={[0, -DOOR_ORIGIN_HEIGHT, 0]}>
    <SponzaAtrium onLoadEnd={...} onError={...} />
  </ViroNode>
</ViroPortalScene>
```

## Sponza atrium (`SponzaAtrium.tsx`)

The atrium of the Sponza Palace in Dubrovnik (16th century), after the "Crytek Sponza" model
(CC BY 3.0). Credits and licences: `assets/environments/sponza_atrium/LICENSES.md`.

| | |
|---|---|
| Files | `sponza_atrium.glb` (21 350 668 bytes, 20.4 MB), `sponza_atrium_backwall.glb` (388 980 bytes) |
| Triangles | 411 790 (hall and sky dome) + 2 234 (wall with the doorway) |
| Draw calls | 26 + 1 (one mesh per material) |
| Textures | 26 embedded JPEG/PNG images (9.6 MB): 24 × 1024², one 512², one 256 × 1024, sky 4096 × 1024; about 150 MiB of GPU memory once decoded |
| Extent (doorway frame) | X −6.1 … +6.5 m, Y 0 … 13.4 m, Z 0 … −27.4 m; sky dome radius 400 m |
| glTF features | plain GLB, `KHR_materials_unlit`, `COLOR_0` (baked light), `MASK` alpha on the plants; no Draco/meshopt/KTX2 |

**Where the doorway is.** In the middle of an end wall of the ground-floor arcade, looking down the
long axis: 4.4 m of vaulted arcade, then an arch (columns 2.2 m left and right of the axis at
Z = −4.5 m), then the open court (18 m long, 4 m wide, open sky, two storeys of galleries) and the far
wall with a lion relief at Z = −27.4 m. The floor is level with the threshold (Y = 0) everywhere on the
ground floor. Free floor at the door: 4.4 m ahead and about 3 m to each side (two large vases stand at
X = ±4.1 m, Z = −2.3 m). The stone base course of the end wall (8 cm high) is cut away within 0.55 m of
the door axis, so nothing stands on the floor in a doorway up to 1 m wide.

**Lights and masks.** None. Lighting (sky, sun, diffuse bounces) is baked into vertex colours and all
materials are unlit, so the component adds no lights, AR-side lights do not affect it and it does not
light AR objects. Nothing needs a `lightReceivingBitMask`.

**The wall around the doorway.** `sponza_atrium_backwall.glb` is the end wall the visitor sees after
turning around. It is single-sided and lies 1 cm on the real side of the doorway plane; from the real
side it is back-face culled, so it does not hide the view through the doorway. Nothing else of the
model is on the real side of the plane. `showBackWall={false}` removes it (use it if a device ever
shows a stone wall instead of the hall when looking in from the real side).

**Doorway size.** The scene does not depend on it. A frame of any width and height can be used; the
frame should stand out from the wall by at least a centimetre towards the hall.

**Renderer settings that fit this scene** (on `ViroARSceneNavigator`; not required): `shadowsEnabled`,
`bloomEnabled` and `pbrEnabled` can be `false` — nothing here uses them. The colours were tuned for a
plain linear → sRGB output; with `hdrEnabled` the tone-mapping pass may make the hall darker or
flatter.

**Not verified on a device.** The files were checked with the Khronos glTF validator (no errors, no
warnings) and rendered in three.js; they were not loaded in ViroReact. Things to look at on the first
run: that the hall is visible through the doorway from the real side (back-face culling of the wall),
that vertex colours are applied (the arcade is clearly darker than the sunlit court), the length of
the freeze while the models load, and the frame rate.

**Previews** (three.js renders of the shipped files): `assets/environments/sponza_atrium/preview/`.

**Rebuilding.** `assets/environments/sponza_atrium/build/README.md`.

## Door casing and door leaf (`DoorCasing.tsx`)

A walnut door casing that fits a real doorway of any size, plus an optional oak plank door with strap
hinges. Credits and licences: `assets/environments/door_casing/LICENSES.md` (textures CC0, models made
for this project).

```tsx
import { DoorCasing, DoorLeaf, doorCasingOriginHeight } from '../environments/DoorCasing';

const originHeight = doorCasingOriginHeight(opening.height);   // = height / 2, no threshold offset

<ViroPortalScene passable position={/* centre of the opening */} ...>
  <ViroPortal>
    <DoorCasing width={opening.width} height={opening.height} />
  </ViroPortal>
  <ViroSkyBox color="#070716" />
  <ViroNode position={[0, -originHeight, 0]}>
    <SponzaAtrium />
    <DoorLeaf width={opening.width} height={opening.height} hinge="right" />   {/* optional */}
  </ViroNode>
</ViroPortalScene>
```

`DoorCasing` replaces the `Viro3DObject` with `door_frame.obj` and must be a direct child of
`ViroPortal` (it renders seven `Viro3DObject`s and nothing else). `DoorLeaf` belongs to the inner
world, next to the environment. Both register their own materials when the module is imported.

| | |
|---|---|
| Parameters | `width`, `height` = clear size of the real doorway in metres (floor to the underside of the head) |
| Casing | 8.5 cm wide moulded face around the opening, 1.8 cm proud of the wall on the real side; jamb lining 2.2 cm thick reaching 6 cm into the inner world; threshold bar 1.2 cm high (`threshold={false}` removes it) |
| Outer size | (width + 0.17) × (height + 0.085) m |
| Origin | centre of the opening; the floor is at y = −height / 2; the frame straddles z = 0 (+0.018 … −0.06) |
| Door leaf | (width + 0.03) × (height + 0.009) m, 4.2 cm thick, hinge axis 8.5 cm behind the doorway plane; `open`, `openAngle` (default 100°), `hinge`, `animated` |
| Triangles | casing and window 240 (7 draw calls); leaf 1 226 (1 draw call) |
| Files | 8 OBJ models (277 kB together), `door_casing.jpg` and `door_leaf.jpg` (1024 × 2048, 357 kB and 334 kB, about 11 MiB of GPU memory each), `portal_window.png` (8 × 8, fully transparent) |

**How it scales.** The two side casings are stretched only in Y, the head casing and the threshold only
in X, the mitred corners are never scaled, so the moulding keeps its cross-section for any doorway.
The wood grain stretches with the part (designed for 0.8 × 2.0 m; ±25 % is not noticeable). The door
leaf is scaled as a whole, its ironwork stretches with it.

**Lights and masks.** None; all materials are `Constant` and the shading is painted into the textures.
`tint` (a colour multiplied into the wood) can make the casing or the leaf darker to match a dim room;
it cannot make them brighter than the texture.

**The transparent window** is the same device the current frame uses (an OBJ whose material has a
fully transparent PNG): a tunnel from the doorway plane to 5.5 cm behind it, 8 mm larger than the
opening at the sides and the top so that its walls hide inside the lining, with its bottom exactly on
the floor.

**With other environments.** The casing does not depend on the environment. `VirtualRoom` has a front
wall with a hole cut for the old frame at z = −0.15; with this casing that hole no longer matches.

**Not verified on a device.** The parts were checked in three.js (assembled by the same placement
rules, two doorway sizes) and with `tsc`; nothing was run in ViroReact. Things to look at on the first
run:

- the inner world is visible through the doorway (the transparent PNG keeps its alpha);
- seven `Viro3DObject` children under one `ViroPortal`, some scaled along one axis only (allowed by
  the bridge source, each child must be exactly a `Viro3DObject`);
- walking through fast: the tunnel is 5.5 cm deep, the previous frame had 14 cm against a one-frame
  flash of the camera image. If the flash is back, increase `LINING_D` and `TUNNEL_D` in
  `build_door.py` and `liningDepth` here, at the price of a deeper lining;
- from the real side at very flat angles (more than about 45° off the door axis) the outer side of
  the lining can show beyond the casing, because the real wall does not hide virtual objects;
- `tint` (relies on `diffuseColor` being multiplied with the texture);
- the swing of the leaf (`ViroAnimations` with an absolute `rotateY`); `animated={false}` switches
  to an instant change. `onClick` on the leaf is passed through but taps inside a portal were not tried.

**Previews** (three.js renders with a mock wall on the real side): `assets/environments/door_casing/preview/`.

**Rebuilding.** `assets/environments/door_casing/build/README.md`.
