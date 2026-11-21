// Generates every 3D asset of the app: the textures of the virtual room, the door-frame
// texture and the door-frame model (OBJ).
// Run: node scripts/generate-assets.mjs
//
// All files written by this script are original works of this project (no third-party
// assets). The generated PNGs are committed, so running the script is only needed after
// changing it. No dependencies: PNG encoding is done with node:zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const outDir = join(assetsDir, 'textures');
const modelDir = join(assetsDir, 'models');
mkdirSync(outDir, { recursive: true });
mkdirSync(modelDir, { recursive: true });

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** pixel(x, y) -> [r, g, b, a], each 0..255. */
function writePng(name, size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const file = join(outDir, name);
  writeFileSync(file, png);
  console.log(`${name}: ${png.length} bytes`);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Deterministic value noise so the output is byte-identical on every run.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const SIZE = 256;

// Floor: two-tone checkerboard, 8 x 8 squares, thin dark seams. The texture is stretched
// once over the whole floor (no UV tiling), so the squares come out about 0.5 m wide.
writePng('room_floor.png', SIZE, (x, y) => {
  const cell = SIZE / 8;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const seam = x % cell < 1 || y % cell < 1;
  const base = (cx + cy) % 2 === 0 ? [236, 226, 198] : [58, 74, 110];
  const shade = 0.94 + 0.06 * hash(x >> 2, y >> 2);
  const c = seam ? [24, 28, 40] : base.map((v) => Math.round(v * shade));
  return [...c, 255];
});

// Walls: magenta-to-violet panels with a bright cyan grid - obviously not a real room.
writePng('room_wall.png', SIZE, (x, y) => {
  const line = x % 64 < 3 || y % 64 < 3;
  const t = y / (SIZE - 1);
  const panel = mix([122, 44, 168], [48, 26, 110], t);
  const speck = 0.92 + 0.08 * hash(x >> 1, y >> 1);
  const c = line ? [64, 232, 240] : panel.map((v) => Math.round(v * speck));
  return [...c, 255];
});

// Ceiling: dark blue with scattered "stars".
writePng('room_ceiling.png', SIZE, (x, y) => {
  const star = hash(x, y) > 0.9965;
  const glow = hash(x >> 3, y >> 3) * 18;
  const c = star ? [255, 244, 200] : [14 + glow, 18 + glow, 48 + glow].map(Math.round);
  return [...c, 255];
});

// ---------------------------------------------------------------------------------------
// Door frame: texture + OBJ model
// ---------------------------------------------------------------------------------------
//
// What the ViroReact portal renderer needs from the child of <ViroPortal> (read from the
// virocore sources, see README "How the portal works"):
//  * it must be a Viro3DObject (primitives are rejected by the Android bridge);
//  * the inner scene is visible only where the model has geometry whose diffuse TEXTURE
//    alpha is <= 0.1 - an empty hole shows nothing, so the opening is filled with a
//    "window" quad that samples a fully transparent texel;
//  * the walk-through test uses the plane through the model origin with normal +Z and
//    the model's bounding box, so the origin is the centre of the opening and the frame
//    straddles z = 0.
//
// The transparent part is ONE flat quad in the crossing plane. That is the only form in
// which the inner world has been SEEN through the doorway on a phone (build 9cb8a8b,
// 2026-11-20). A "tunnel" of six transparent faces was tried against a one-frame flash of
// the camera image at the crossing; with it (and with the wooden casing's own window, a
// separate box with a fully transparent texture) the doorway showed no world at all on
// the first full pass (2026-11-21), so the tunnel is gone. The flash is the smaller evil.
//
// The texture is a 16 x 16 palette strip of four 4-texel columns: three opaque shades of
// the frame colour (front/back, sides, top/bottom faces - a baked "lighting") and one fully
// transparent column. Every face maps ALL its vertices to the centre of one column, so the
// sampled texel never depends on distance or mip level.
const FRAME_SHADES = [
  [236, 240, 245], // faces looking along +-Z (seen when facing the door)
  [150, 160, 176], // faces looking along +-X (inner and outer sides of the posts)
  [196, 204, 216], // faces looking along +-Y (top of the lintel, threshold)
];
writePng('door_frame.png', 16, (x) => {
  const column = Math.floor(x / 4);
  return column < 3 ? [...FRAME_SHADES[column], 255] : [0, 0, 0, 0];
});

/** Dimensions in metres, model origin = centre of the opening. Keep in sync with src/ar/doorGeometry.ts. */
const DOOR = {
  openingWidth: 0.9,
  openingHeight: 2.0,
  postWidth: 0.08,
  lintelHeight: 0.08,
  thresholdHeight: 0.02,
  depthFront: 0.06, // frame thickness on the AR side of the crossing plane (z > 0)
  depthBack: 0.14, // ... and on the room side (z < 0); also the length of the tunnel
};

function buildDoorFrameObj() {
  const positions = [];
  const faces = []; // [normalIndex, uvIndex, [four position indices]]
  const NORMALS = [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
  // vt indices (1-based): 1 = front/back shade, 2 = side shade, 3 = top/bottom shade, 4 = transparent.
  const UVS = [0.125, 0.375, 0.625, 0.875];
  const SHADE_OF_NORMAL = [1, 1, 2, 2, 3, 3];

  const quad = (normalIndex, uvIndex, corners) => {
    const base = positions.length;
    positions.push(...corners);
    faces.push([normalIndex, uvIndex, [base + 1, base + 2, base + 3, base + 4]]);
  };

  // Corners are listed counter-clockwise as seen from outside the box.
  const box = (x0, x1, y0, y1, z0, z1) => {
    const corners = [
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // +Z
      [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], // -Z
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], // +X
      [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // -X
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], // +Y
      [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // -Y
    ];
    corners.forEach((c, n) => quad(n + 1, SHADE_OF_NORMAL[n], c));
  };

  const hw = DOOR.openingWidth / 2;
  const hh = DOOR.openingHeight / 2;
  const zf = DOOR.depthFront;
  const zb = -DOOR.depthBack;
  const bottom = -hh - DOOR.thresholdHeight;
  const top = hh + DOOR.lintelHeight;
  const outer = hw + DOOR.postWidth;

  box(-outer, -hw, bottom, top, zb, zf); // left post
  box(hw, outer, bottom, top, zb, zf); // right post
  box(-hw, hw, hh, top, zb, zf); // lintel
  box(-hw, hw, bottom, -hh, zb, zf); // threshold

  // The transparent window (see the comment above). Its faces come LAST in the file, so
  // within the single draw call the opaque frame is drawn before them. It is 1 cm wider
  // than the opening on every side, i.e. its edges are hidden inside the frame.
  const o = 0.01;
  const a = hw + o;
  const b = hh + o;
  const windowAt = (z) =>
    quad(1, 4, [
      [-a, -b, z],
      [a, -b, z],
      [a, b, z],
      [-a, b, z],
    ]);
  windowAt(0); // in the crossing plane, facing +Z

  const f = (n) => Number(n.toFixed(4)).toString();
  const lines = [
    '# Door frame for the ViroReact portal. Generated by scripts/generate-assets.mjs - do not edit.',
    '# Units: metres. Origin: centre of the opening. The opening lies in the XY plane, +Z = AR side.',
    'o door_frame',
    ...positions.map((p) => `v ${f(p[0])} ${f(p[1])} ${f(p[2])}`),
    ...UVS.map((u) => `vt ${u} 0.5`),
    ...NORMALS.map((n) => `vn ${n[0]} ${n[1]} ${n[2]}`),
  ];
  for (const [n, t, [a, b, c, d]] of faces) {
    lines.push(`f ${a}/${t}/${n} ${b}/${t}/${n} ${c}/${t}/${n}`);
    lines.push(`f ${a}/${t}/${n} ${c}/${t}/${n} ${d}/${t}/${n}`);
  }
  return lines.join('\n') + '\n';
}

const obj = buildDoorFrameObj();
writeFileSync(join(modelDir, 'door_frame.obj'), obj);
console.log(`door_frame.obj: ${obj.length} bytes`);

// ---- the window alone, for the wooden casing ------------------------------------------
//
// A unit quad (1 x 1 m, centred, in the plane z = 0, facing +Z) that samples the
// transparent column of door_frame.png: the same texture and the same kind of face as
// the window of the frame above. The app scales it to the doorway and gives it to the
// portal as its ONLY child; the wood is drawn beside the portal, not inside it.
// Two tiny transparent triangles in front of and behind the plane give the model a
// bounding box with some depth: the renderer's walk-through test looks at that box.
function buildPortalWindowObj() {
  const e = 0.002; // size of the two triangles, in the unit square
  const d = 0.05; // how far they stand off the plane, metres (z is not scaled)
  const lines = [
    '# Window of the portal: one transparent quad. Generated by scripts/generate-assets.mjs - do not edit.',
    '# Units: a unit square, scaled by the app. Origin: its centre. +Z = AR side.',
    'o portal_window',
    'v -0.5 -0.5 0',
    'v 0.5 -0.5 0',
    'v 0.5 0.5 0',
    'v -0.5 0.5 0',
    `v -0.5 -0.5 ${d}`,
    `v ${-0.5 + e} -0.5 ${d}`,
    `v -0.5 ${-0.5 + e} ${d}`,
    `v 0.5 0.5 ${-d}`,
    `v ${0.5 - e} 0.5 ${-d}`,
    `v 0.5 ${0.5 - e} ${-d}`,
    'vt 0.875 0.5',
    'vn 0 0 1',
    'f 1/1/1 2/1/1 3/1/1',
    'f 1/1/1 3/1/1 4/1/1',
    'f 5/1/1 6/1/1 7/1/1',
    'f 8/1/1 9/1/1 10/1/1',
  ];
  return lines.join('\n') + '\n';
}
const windowObj = buildPortalWindowObj();
writeFileSync(join(modelDir, 'portal_window.obj'), windowObj);
console.log(`portal_window.obj: ${windowObj.length} bytes`);
