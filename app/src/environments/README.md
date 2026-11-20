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
| Files | `sponza_atrium.glb` (21 349 604 bytes, 20.4 MB), `sponza_atrium_backwall.glb` (388 980 bytes) |
| Triangles | 411 799 (hall and sky dome) + 2 234 (wall with the doorway) |
| Draw calls | 26 + 1 (one mesh per material) |
| Textures | 26 embedded JPEG/PNG images (9.6 MB): 24 × 1024², one 512², one 256 × 1024, sky 4096 × 1024; about 150 MiB of GPU memory once decoded |
| Extent (doorway frame) | X −6.1 … +6.5 m, Y 0 … 13.4 m, Z 0 … −27.4 m; sky dome radius 400 m |
| glTF features | plain GLB, `KHR_materials_unlit`, `COLOR_0` (baked light), `MASK` alpha on the plants; no Draco/meshopt/KTX2 |

**Where the doorway is.** In the middle of an end wall of the ground-floor arcade, looking down the
long axis: 4.4 m of vaulted arcade, then an arch (columns 2.2 m left and right of the axis at
Z = −4.5 m), then the open court (18 m long, 4 m wide, open sky, two storeys of galleries) and the far
wall with a lion relief at Z = −27.4 m. The floor is level with the threshold (Y = 0) everywhere on the
ground floor. Free floor at the door: 4.4 m ahead and about 3 m to each side (two large vases stand at
X = ±4.1 m, Z = −2.3 m).

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
