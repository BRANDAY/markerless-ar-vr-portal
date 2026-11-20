# Rebuilding the Sponza atrium environment

The GLB files in the parent folder are generated; the sources are not in the repository.

1. Download and unpack the model (CC BY 3.0):
   https://casual-effects.com/g3d/data10/common/model/crytek_sponza/sponza.zip
2. Download the sky (CC0), the tone-mapped JPEG of
   https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky
3. Python 3.13 with `numpy`, `pillow` and `embreex` (Embree ray casting), then:

```
python build_sponza.py --src <folder with sponza.obj> --sky <sky jpg> --work <cache folder> --out <output folder>
```

About 10 minutes on a 6-core desktop CPU; no GPU and no Blender are needed. The two stages are cached
in the work folder (`geom.npz`, `bake.npz`); delete a cache file to redo its stage. `--exposure`,
`--white`, `--bounce`, `--ambient` and `--texture-size` only affect the fast export stage.

What the script does: scales the model to metres and moves it into the doorway frame (origin on the
floor in the middle of the threshold, scene towards −Z); removes the relief around the doorway and the
geometry that cannot be seen from the ground floor; cuts the base course of the end wall out of the
doorway (`DOOR_CLEAR_HALF`, done at export, so it does not invalidate the light bake); splits edges longer than 0.45 m; computes sky
light, a soft sun and seven diffuse bounces per vertex; tone-maps the result into `COLOR_0`; writes
plain GLB files with `KHR_materials_unlit` materials and embedded textures.

`stats.json` is the report of the build that produced the committed files (triangles per material,
texture sizes, lighting parameters).

`objio.py` reads OBJ/MTL, `glbio.py` writes GLB; both are small and have no dependencies besides numpy.
