import assert from 'node:assert/strict';
import { test } from 'node:test';

import { meshToPly, parseRvwm } from './meshFormat';

/** One quad made of two triangles, in the RVWM layout. */
function sampleRvwm(): Uint8Array {
  const positions = [0, 0, 0, 1, 0, 0, 1, 2.5, 0, 0, 2.5, -0.25];
  const confidence = [0.1, 0.5, 0.75, 1];
  const indices = [0, 1, 2, 0, 2, 3];
  const bytes = new Uint8Array(13 + 4 * 16 + 2 * 12);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x56, 0x57, 0x4d, 1]);
  view.setUint32(5, 4, true);
  view.setUint32(9, 2, true);
  let offset = 13;
  for (const value of [...positions, ...confidence]) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  for (const index of indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }
  return bytes;
}

test('RVWM: a snapshot is parsed', () => {
  const mesh = parseRvwm(sampleRvwm());
  assert.ok(mesh);
  assert.equal(mesh.vertexCount, 4);
  assert.equal(mesh.triangleCount, 2);
  assert.deepEqual(Array.from(mesh.positions.slice(6, 12)), [1, 2.5, 0, 0, 2.5, -0.25]);
  assert.deepEqual(Array.from(mesh.confidence), [Math.fround(0.1), 0.5, 0.75, 1]);
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2, 0, 2, 3]);
});

test('RVWM: a view into a larger buffer is parsed as well', () => {
  const sample = sampleRvwm();
  const padded = new Uint8Array(sample.length + 7);
  padded.set(sample, 7);
  assert.equal(parseRvwm(padded.subarray(7))?.triangleCount, 2);
});

test('RVWM: other bytes are refused', () => {
  const sample = sampleRvwm();
  assert.equal(parseRvwm(new Uint8Array(4)), null);
  assert.equal(parseRvwm(sample.slice(0, sample.length - 1)), null, 'wrong length');
  const wrongMagic = sample.slice();
  wrongMagic[0] = 0x50;
  assert.equal(parseRvwm(wrongMagic), null);
  const wrongVersion = sample.slice();
  wrongVersion[4] = 2;
  assert.equal(parseRvwm(wrongVersion), null);
  const wrongIndex = sample.slice();
  new DataView(wrongIndex.buffer).setUint32(wrongIndex.length - 4, 4, true);
  assert.equal(parseRvwm(wrongIndex), null, 'index beyond the vertices');
});

test('PLY: header and binary body', () => {
  const mesh = parseRvwm(sampleRvwm());
  assert.ok(mesh);
  const ply = meshToPly(mesh);
  const text = Buffer.from(ply).toString('latin1');
  const end = text.indexOf('end_header\n') + 'end_header\n'.length;
  const header = text.slice(0, end);
  assert.ok(header.startsWith('ply\nformat binary_little_endian 1.0\n'));
  assert.ok(header.includes('element vertex 4\n'));
  assert.ok(header.includes('property float confidence\n'));
  assert.ok(header.includes('element face 2\nproperty list uchar int vertex_indices\n'));
  assert.equal(ply.length, end + 4 * 16 + 2 * 13);

  const view = new DataView(ply.buffer, end);
  assert.equal(view.getFloat32(2 * 16 + 4, true), 2.5, 'y of the third vertex');
  assert.equal(view.getFloat32(3 * 16 + 12, true), 1, 'confidence of the fourth vertex');
  const faces = 4 * 16;
  assert.equal(view.getUint8(faces), 3);
  assert.deepEqual(
    [1, 5, 9].map((at) => view.getInt32(faces + 13 + at, true)),
    [0, 2, 3],
    'second triangle',
  );
});
