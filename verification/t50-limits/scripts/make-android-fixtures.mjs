// Source images for the phone ramp. Small files that decode to the stated megapixel count:
//   rgb-<n>mp.png   truly colourful RGB (so ImageMagick keeps three channels, as for a photograph)
//   rgba-<n>mp.png  RGB with an alpha channel, the 8 bytes-per-pixel worst case
//   frames-<w>x<n>.gif  a w x w canvas with n one-pixel frames; coalescing makes n full canvases
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fixtures', 'android');
mkdirSync(outDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function colourPng(w, h, channels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  const stride = 1 + w * channels;
  const parts = [];
  // Row by row, so the raw image (up to 200 MB) is never held at once.
  const deflate = deflateSync;
  let raw = Buffer.alloc(0);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) {
      const at = 1 + x * channels;
      row[at] = x & 255; row[at + 1] = y & 255; row[at + 2] = (x + y) & 255;
      if (channels === 4) row[at + 3] = 128 + ((x ^ y) & 127);
    }
    rows.push(row);
    if (rows.length === 512) { parts.push(Buffer.concat(rows)); rows.length = 0; }
  }
  if (rows.length) parts.push(Buffer.concat(rows));
  raw = Buffer.concat(parts);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflate(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function framesGif(side, frames) {
  const u16 = (n) => Buffer.from([n & 0xff, n >> 8]);
  const parts = [Buffer.from('GIF89a', 'ascii'), u16(side), u16(side), Buffer.from([0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])];
  // A Graphic Control Extension gives each frame a 100 ms delay; without one the animated WebP encoder refuses the file.
  const frame = Buffer.concat([Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]), Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])]);
  for (let i = 0; i < frames; i++) parts.push(frame);
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const sizes = { 12: [4000, 3000], 24: [6000, 4000], 36: [7500, 4800], 50: [8160, 6120], 52: [8192, 6400], 53: [8200, 6400] };
const wanted = [
  ...[12, 24, 36, 50, 52, 53].map((n) => [`rgb-${n}mp.png`, sizes[n], 3]),
  ...[24, 50].map((n) => [`rgba-${n}mp.png`, sizes[n], 4]),
];
for (const [name, [w, h], channels] of wanted) {
  const bytes = colourPng(w, h, channels);
  writeFileSync(join(outDir, name), bytes);
  console.log(name.padEnd(18), `${w}x${h}`, `${(w * h / 1e6).toFixed(1)} MP`, `${(bytes.length / 1024).toFixed(0)} KB`);
}
for (const [name, side, frames] of [['frames-590x100.gif', 590, 100], ['frames-1000x300.gif', 1000, 300]]) {
  const bytes = framesGif(side, frames);
  writeFileSync(join(outDir, name), bytes);
  console.log(name.padEnd(18), `${side}x${side} x ${frames}`, `${(side * side * frames / 1e6).toFixed(1)} M frame-px`, `${bytes.length} B`);
}
