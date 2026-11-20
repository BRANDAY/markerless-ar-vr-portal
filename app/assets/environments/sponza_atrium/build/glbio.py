"""Tiny GLB (glTF 2.0 binary) writer: plain accessors, embedded images, optional KHR_materials_unlit.

No compression extensions on purpose (the target renderer, ViroReact 3.2.2, cannot read Draco,
meshopt, quantized attributes or KTX2).
"""
from __future__ import annotations

import json
import struct

import numpy as np

FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


class GlbBuilder:
    def __init__(self, generator: str, copyright_: str):
        self.bin = bytearray()
        self.j: dict = {
            "asset": {"version": "2.0", "generator": generator, "copyright": copyright_},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
            "textures": [],
            "images": [],
        }
        self.unlit_used = False

    def _view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.bin.extend(data)
        self.j["bufferViews"].append(view)
        return len(self.j["bufferViews"]) - 1

    def _accessor(self, arr: np.ndarray, comp: int, typ: str, target: int, normalized=False, minmax=False) -> int:
        acc = {"bufferView": self._view(arr.tobytes(), target), "componentType": comp, "count": int(arr.shape[0]),
               "type": typ}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        self.j["accessors"].append(acc)
        return len(self.j["accessors"]) - 1

    def add_image(self, data: bytes, mime: str, name: str) -> int:
        """Returns a texture index."""
        self.j["images"].append({"bufferView": self._view(data), "mimeType": mime, "name": name})
        self.j["textures"].append({"sampler": 0, "source": len(self.j["images"]) - 1, "name": name})
        return len(self.j["textures"]) - 1

    def add_material(self, name: str, texture: int | None, base_color=(1.0, 1.0, 1.0, 1.0), unlit=True,
                     double_sided=False, alpha_mode="OPAQUE", alpha_cutoff=0.5) -> int:
        pbr: dict = {"baseColorFactor": [float(c) for c in base_color], "metallicFactor": 0.0, "roughnessFactor": 1.0}
        if texture is not None:
            pbr["baseColorTexture"] = {"index": texture}
        mat: dict = {"name": name, "pbrMetallicRoughness": pbr, "doubleSided": bool(double_sided)}
        if alpha_mode != "OPAQUE":
            mat["alphaMode"] = alpha_mode
            if alpha_mode == "MASK":
                mat["alphaCutoff"] = alpha_cutoff
        if unlit:
            mat["extensions"] = {"KHR_materials_unlit": {}}
            self.unlit_used = True
        self.j["materials"].append(mat)
        return len(self.j["materials"]) - 1

    def add_mesh_node(self, name: str, material: int, pos: np.ndarray, idx: np.ndarray, nrm=None, uv=None,
                      col=None) -> None:
        attrs = {"POSITION": self._accessor(pos.astype("<f4"), FLOAT, "VEC3", ARRAY_BUFFER, minmax=True)}
        if nrm is not None:
            attrs["NORMAL"] = self._accessor(nrm.astype("<f4"), FLOAT, "VEC3", ARRAY_BUFFER)
        if uv is not None:
            attrs["TEXCOORD_0"] = self._accessor(uv.astype("<f4"), FLOAT, "VEC2", ARRAY_BUFFER)
        if col is not None:
            attrs["COLOR_0"] = self._accessor(col.astype(np.uint8), UBYTE, "VEC4", ARRAY_BUFFER, normalized=True)
        if pos.shape[0] <= 65535:
            ia = self._accessor(idx.astype("<u2").reshape(-1), USHORT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        else:
            ia = self._accessor(idx.astype("<u4").reshape(-1), UINT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        self.j["meshes"].append({"name": name, "primitives": [{"attributes": attrs, "indices": ia,
                                                               "material": material, "mode": 4}]})
        self.j["nodes"].append({"name": name, "mesh": len(self.j["meshes"]) - 1})
        self.j["scenes"][0]["nodes"].append(len(self.j["nodes"]) - 1)

    def write(self, path: str) -> int:
        if self.unlit_used:
            self.j["extensionsUsed"] = ["KHR_materials_unlit"]
        for key in ("textures", "images"):
            if not self.j[key]:
                del self.j[key]
        if "textures" not in self.j:
            del self.j["samplers"]
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.j, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as fh:
            fh.write(struct.pack("<4sII", b"glTF", 2, total))
            fh.write(struct.pack("<I4s", len(js), b"JSON"))
            fh.write(js)
            fh.write(struct.pack("<I4s", len(self.bin), b"BIN\x00"))
            fh.write(self.bin)
        return total
