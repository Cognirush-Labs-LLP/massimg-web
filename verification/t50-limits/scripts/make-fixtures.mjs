// Builds the small-file/huge-image fixtures. Nothing here is a real photograph: only the declared
// size and how little data backs it matter.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fixtures');
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
const ihdr = (w, h, depth, colourType) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = colourType;
  return chunk('IHDR', d);
};

// Grayscale PNG whose scanlines are all zero: deflate collapses them, so a gigapixel image is a few
// hundred KB. `depth` 1 keeps the raw stream small enough to deflate in memory here.
function zeroPng(w, h, depth, colourType = 0, channels = 1) {
  const rowBytes = 1 + Math.ceil((w * depth * channels) / 8);
  const raw = Buffer.alloc(rowBytes * h);
  return Buffer.concat([signature, ihdr(w, h, depth, colourType), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Animated GIF whose logical screen is `side`x`side` and which carries `frames` one-pixel frames.
// Coalescing it yields frames x side x side x 4 bytes from a file of a few KB.
function frameBombGif(side, frames) {
  const u16 = (n) => Buffer.from([n & 0xff, n >> 8]);
  const parts = [Buffer.from('GIF89a', 'ascii'), u16(side), u16(side), Buffer.from([0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])];
  const frame = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])]);
  for (let i = 0; i < frames; i++) parts.push(frame);
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// VP8L (lossless WebP) declaring 16383x16383 - the format's maximum - followed by a stub of data.
function webpBomb() {
  const bits = Buffer.alloc(5);
  bits[0] = 0x2f;
  const w = 16382, h = 16382; // stored as size - 1, 14 bits each
  const packed = BigInt(w) | (BigInt(h) << 14n);
  for (let i = 0; i < 4; i++) bits[1 + i] = Number((packed >> BigInt(8 * i)) & 0xffn);
  const payload = Buffer.concat([bits, Buffer.alloc(6)]);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8L', 0, 'ascii');
  chunkHeader.writeUInt32LE(payload.length, 4);
  const riffBody = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, payload]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(riffBody.length, 4);
  return Buffer.concat([riff, riffBody]);
}

const fixtures = {
  'gray-6mp.png': zeroPng(3000, 2000, 8),
  ...Object.fromEntries([100, 300, 600, 1200].map((n) => [`frames-${n}.gif`, frameBombGif(16, n)])),
  'bomb-webp-16k.webp': webpBomb(),
  'rgb-48mp.png': zeroPng(8000, 6000, 8, 2, 3),
  'rgba-48mp.png': zeroPng(8000, 6000, 8, 6, 4),
  'bomb-18k-area.png': zeroPng(18000, 18000, 1),
  'bomb-frames.gif': frameBombGif(3000, 3000),
  'legit-frames.gif': frameBombGif(200, 20),
  'legit-48mp.png': zeroPng(8000, 6000, 8),
  'bomb-data-1.6gp.png': zeroPng(40000, 40000, 1),
  'bomb-header-only-3.6gp.png': Buffer.concat([signature, ihdr(60000, 60000, 8, 0), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63]))]),
  'bomb-wide.png': Buffer.concat([signature, ihdr(2_000_000_000, 4, 8, 0), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63]))]),
};
for (const [name, bytes] of Object.entries(fixtures)) {
  writeFileSync(join(outDir, name), bytes);
  console.log(name.padEnd(30), `${bytes.length} bytes`);
}
