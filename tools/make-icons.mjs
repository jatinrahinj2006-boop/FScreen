/*
 * Generates the FScreen toolbar/store icons.
 * Run: node tools/make-icons.mjs
 *
 * Draws a "pane fullscreen" glyph: four corner brackets (fullscreen) around a
 * green vertical divider (the split-screen pane) on a dark rounded square.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [15, 23, 42, 255];      // slate-900
const FG = [255, 255, 255, 245];
const ACCENT = [74, 222, 128, 255]; // green-400

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, size * 0.22);

  const put = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = colour[3] / 255;
    rgba[i] = Math.round(rgba[i] * (1 - a) + colour[0] * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + colour[1] * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + colour[2] * a);
    rgba[i + 3] = 255;
  };

  // Rounded square body.
  const rx0 = radius;
  const ry0 = radius;
  const rx1 = size - radius;
  const ry1 = size - radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside;
      if (px < rx0 && py < ry0) inside = Math.hypot(px - rx0, py - ry0) <= radius;
      else if (px > rx1 && py < ry0) inside = Math.hypot(px - rx1, py - ry0) <= radius;
      else if (px < rx0 && py > ry1) inside = Math.hypot(px - rx0, py - ry1) <= radius;
      else if (px > rx1 && py > ry1) inside = Math.hypot(px - rx1, py - ry1) <= radius;
      else inside = px >= 0 && px <= size && py >= 0 && py <= size;
      if (inside) put(x, y, BG);
    }
  }

  // Corner brackets.
  const t = Math.max(2, Math.round(size * 0.11));
  const m = Math.round(size * 0.21);
  const len = Math.round(size * 0.24);

  const bar = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, colour);
  };

  // top-left
  bar(m, m, len, t, FG);
  bar(m, m, t, len, FG);
  // top-right
  bar(size - m - len, m, len, t, FG);
  bar(size - m - t, m, t, len, FG);
  // bottom-left
  bar(m, size - m - t, len, t, FG);
  bar(m, size - m - len, t, len, FG);
  // bottom-right
  bar(size - m - len, size - m - t, len, t, FG);
  bar(size - m - t, size - m - len, t, len, FG);

  // Green divider: the split-screen pane.
  const divW = Math.max(2, Math.round(size * 0.09));
  const divH = Math.max(3, Math.round(size * 0.3));
  bar(Math.round((size - divW) / 2), Math.round((size - divH) / 2), divW, divH, ACCENT);

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, draw(size));
  console.log(`wrote ${file}`);
}
