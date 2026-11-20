/**
 * The room mesh as ViroReact's `snapshotWorldMeshToFile` writes it ("RVWM"), and its
 * conversion to a binary PLY file, the format the localization server and common mesh
 * tools read. Pure TypeScript.
 *
 * RVWM version 1, little-endian, seen in snapshots from a Xiaomi 14 Ultra (the layout
 * was worked out from the files, the library does not document it):
 *
 *   bytes 0-3    "RVWM"
 *   byte  4      version = 1
 *   bytes 5-8    V = number of vertices   (uint32)
 *   bytes 9-12   T = number of triangles  (uint32)
 *   V x 3 float32   positions x, y, z  - metres, AR world frame
 *   V x float32     one value per vertex, 0...1 (presumably the depth confidence)
 *   T x 3 uint32    vertex indices of the triangles
 */

export interface RvwmMesh {
  vertexCount: number;
  triangleCount: number;
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** One value per vertex, 0...1. */
  confidence: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

const HEADER_BYTES = 13;

/** Parses an RVWM version 1 file; null if the bytes are something else. */
export function parseRvwm(bytes: Uint8Array): RvwmMesh | null {
  if (bytes.length < HEADER_BYTES || bytes[0] !== 0x52 || bytes[1] !== 0x56 || bytes[2] !== 0x57 || bytes[3] !== 0x4d) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== 1) {
    return null;
  }
  const vertexCount = view.getUint32(5, true);
  const triangleCount = view.getUint32(9, true);
  if (HEADER_BYTES + vertexCount * 16 + triangleCount * 12 !== bytes.length) {
    return null;
  }
  // The data starts at an odd offset, so it is copied into aligned arrays.
  const positions = new Float32Array(vertexCount * 3);
  const confidence = new Float32Array(vertexCount);
  const indices = new Uint32Array(triangleCount * 3);
  let offset = HEADER_BYTES;
  for (let i = 0; i < positions.length; i++, offset += 4) {
    positions[i] = view.getFloat32(offset, true);
  }
  for (let i = 0; i < confidence.length; i++, offset += 4) {
    confidence[i] = view.getFloat32(offset, true);
  }
  for (let i = 0; i < indices.length; i++, offset += 4) {
    const index = view.getUint32(offset, true);
    if (index >= vertexCount) {
      return null;
    }
    indices[i] = index;
  }
  return { vertexCount, triangleCount, positions, confidence, indices };
}

/**
 * Binary little-endian PLY: vertices `x y z confidence` (float), faces as
 * `list uchar int vertex_indices`. Coordinates are written unchanged.
 */
export function meshToPly(mesh: RvwmMesh): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'comment AR world frame of the recording session: metres, right-handed, +Y up\n' +
    'comment converted by the AR portal app from a ViroReact world mesh snapshot (RVWM 1)\n' +
    `element vertex ${mesh.vertexCount}\n` +
    'property float x\n' +
    'property float y\n' +
    'property float z\n' +
    'property float confidence\n' +
    `element face ${mesh.triangleCount}\n` +
    'property list uchar int vertex_indices\n' +
    'end_header\n';
  const out = new Uint8Array(header.length + mesh.vertexCount * 16 + mesh.triangleCount * 13);
  for (let i = 0; i < header.length; i++) {
    out[i] = header.charCodeAt(i);
  }
  const view = new DataView(out.buffer);
  let offset = header.length;
  for (let v = 0; v < mesh.vertexCount; v++, offset += 16) {
    view.setFloat32(offset, mesh.positions[v * 3], true);
    view.setFloat32(offset + 4, mesh.positions[v * 3 + 1], true);
    view.setFloat32(offset + 8, mesh.positions[v * 3 + 2], true);
    view.setFloat32(offset + 12, mesh.confidence[v], true);
  }
  for (let t = 0; t < mesh.triangleCount; t++, offset += 13) {
    view.setUint8(offset, 3);
    view.setInt32(offset + 1, mesh.indices[t * 3], true);
    view.setInt32(offset + 5, mesh.indices[t * 3 + 1], true);
    view.setInt32(offset + 9, mesh.indices[t * 3 + 2], true);
  }
  return out;
}
