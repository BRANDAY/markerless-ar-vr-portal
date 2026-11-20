# Rebuilding the door casing and the door leaf

The OBJ models and the textures in the parent folder are generated; the two wood photographs they are
made from are not in the repository.

1. Download the 2K diffuse JPEG of both textures (CC0):
   https://polyhaven.com/a/european_walnut_veneer_04 and https://polyhaven.com/a/oak_veneer_01
2. Python 3.13 with `numpy` and `pillow`, then:

```
python build_door.py --wood-casing european_walnut_veneer_04_diff_2k.jpg --wood-leaf oak_veneer_01_diff_2k.jpg --out <output folder>
```

A few seconds. Add `--preview door.glb --width 0.9 --height 2.1 --leaf left --leaf-angle 80` to also get
one assembled GLB for looking at the result in any glTF viewer (the app does not use it); `glbio.py`
is only needed for that.

What the script does:

- **Casing.** One cross-section (`PROFILE`: 8.5 cm wide face with a bead and a back band, 1.8 cm proud of
  the wall, plus a 2.2 cm thick jamb lining that reaches 6 cm into the inner world) is extruded into a
  1 m long side casing, a 1 m long head casing and two mitred corners. The app stretches the straight
  parts along their length only, so the cross-section never changes.
- **Shading.** Nothing is lit at run time. Ambient occlusion and a soft key light are computed along
  the perimeter of the cross-section and multiplied into the wood, one 256 px column of
  `door_casing.jpg` per part (side casing, head casing, threshold, plain wood); the grain runs along
  the 2048 px axis, which covers 2.2 m.
- **Window.** `portal_window.obj` is a transparent 1 × 1 m tunnel, 5.5 cm deep. The winding of its
  faces matters to the portal renderer (see the comment in `build_window`).
- **Door leaf.** Five planks with V grooves, three strap hinges with studs, knuckles and a ring handle
  on both faces. `door_leaf.jpg` is painted for the face as seen from the front (planks cut from the
  oak photograph, grooves, ironwork with its shadows); the sides of the ironwork use a small shaded
  sphere in the corner of the texture.

`stats.json` is the report of the build that produced the committed files. If a dimension changes
here, change it in `app/src/environments/DoorCasing.tsx` (`DOOR_CASING`) too.
