import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../icons");
mkdirSync(dir, { recursive: true });

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function png(size, paint) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const src = a / 255;
    const dst = rgba[i + 3] / 255;
    const out = src + dst * (1 - src);
    if (out <= 0) return;
    rgba[i] = Math.round((r * src + rgba[i] * dst * (1 - src)) / out);
    rgba[i + 1] = Math.round((g * src + rgba[i + 1] * dst * (1 - src)) / out);
    rgba[i + 2] = Math.round((b * src + rgba[i + 2] * dst * (1 - src)) / out);
    rgba[i + 3] = Math.round(out * 255);
  };
  paint(set, size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fillRect(set, x0, y0, w, h, color) {
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) set(x, y, ...color);
  }
}

function fillRound(set, size, color, radius) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
      const dy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius) set(x, y, ...color);
    }
  }
}

function paint(set, size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  fillRound(set, size, [42, 33, 24, 255], radius);
  const paperX = size * 0.2;
  const paperY = size * 0.16;
  const paperW = size * 0.6;
  const paperH = size * 0.68;
  fillRect(set, paperX, paperY, paperW, paperH, [242, 227, 198, 255]);
  const ink = [58, 42, 26, 230];
  const line = Math.max(1, Math.round(size * 0.045));
  for (let i = 0; i < 3; i++) {
    const width = size * (i === 2 ? 0.28 : 0.4);
    fillRect(set, size * 0.28, size * (0.32 + i * 0.14), width, line, ink);
  }
  fillRect(set, size * 0.58, size * 0.68, size * 0.22, Math.max(2, size * 0.14), [224, 138, 60, 255]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(dir, `icon${size}.png`), png(size, paint));
}
