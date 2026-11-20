# Sponza atrium environment — credits and licences

Files in this folder: `sponza_atrium.glb`, `sponza_atrium_backwall.glb` (derived works, see "Changes").

## 3D model and its textures

**"Crytek Sponza"** — a model of the atrium of the Sponza Palace in Dubrovnik, Croatia.

- © 2010 Frank Meinl, Crytek.
- Based on the original Sponza model by Marko Dabrovic (2002).
- Corrected and repackaged by Morgan McGuire (2011) for the
  McGuire Computer Graphics Archive, https://casual-effects.com/data
- Licence: **Creative Commons Attribution 3.0 Unported (CC BY 3.0)**,
  https://creativecommons.org/licenses/by/3.0/ — as stated for this model in the McGuire Computer
  Graphics Archive (`info.js` of the model: `license: CC BY 3.0`, `copyright: © 2010 Frank Meinl, Crytek`).
- Downloaded on 2026-11-20 from
  https://casual-effects.com/g3d/data10/common/model/crytek_sponza/sponza.zip

Citation requested by the archive:

> Morgan McGuire, Computer Graphics Archive, July 2017 (https://casual-effects.com/data)

Note: other distributions of the same model carry different terms (for example the copy in
KhronosGroup/glTF-Sample-Assets refers to a CRYENGINE licence). The files here are derived only from
the archive copy named above, under the licence stated there.

### Changes made to the model (CC BY 3.0 requires that changes are indicated)

- Converted from OBJ to binary glTF (GLB), scaled from centimetres to metres and moved so that the
  origin is the threshold of a doorway in the middle of one end wall.
- The lion relief and its frame on that end wall were removed (the doorway takes their place); that
  wall is stored as a separate single-sided model.
- The stone base course of that wall was cut away within 0.55 m of the door axis, so that the floor
  runs level through the doorway.
- Geometry that cannot be seen from the ground floor was removed; large triangles were subdivided.
- Lighting (sky, sun and diffuse bounces) was computed offline and stored as vertex colours; all
  materials are unlit. Normal, bump and specular maps of the original are not used.
- Textures were re-encoded as JPEG or PNG at up to 1024 × 1024 pixels.
- A sky dome was added (see below).

## Sky

**"Kloofendal 48d Partly Cloudy (Pure Sky)"** — HDRI by Greg Zaal (sky edits: Jarod Guest), Poly Haven,
https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky — licence **CC0 1.0** (public domain,
https://polyhaven.com/license). The upper half of the tone-mapped JPEG is used as the texture of the
sky dome.

## Build scripts

`build/*.py` in this folder were written for this project.
