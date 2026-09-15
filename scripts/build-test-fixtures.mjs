#!/usr/bin/env node
// Generates the decode fixtures in tests/fixtures/decode/ (T23 — Functional Design R-I9 to R-I16,
// R-I35; Technical Design §7.7). Run with `node scripts/build-test-fixtures.mjs`.
//
// The outputs are committed, so the permanent suite loads bytes rather than paying ImageMagick's
// initialisation on every run — but this generator is committed too, so every fixture is
// reproducible and reviewable rather than an opaque blob. Regenerating produces byte-identical
// files.
//
// Three things here are deliberately *not* ImageMagick's work, because ImageMagick is the thing
// under test and a shared bug would cancel itself out:
//
//   - the eight orientation transforms, computed on raw RGBA in plain JavaScript;
//   - the EXIF APP1 segment, built by hand as a TIFF header plus one IFD0 entry and spliced into
//     the JPEG after SOI;
//   - the ICC profile, built by hand as a minimal but valid ICC v2 matrix/TRC profile.
//
// ImageMagick is used only to compress pixels into a container, which is not what any T23 test
// asserts. The ICC profile is ours, so nothing here carries a third-party licence obligation, and
// no byte of it comes from the machine-local photo fixtures directory.

import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ImageMagick,
  MagickFormat,
  MagickReadSettings,
  ImageProfile,
  initializeImageMagick,
} from '@imagemagick/magick-wasm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'decode')

await initializeImageMagick(
  readFileSync(
    join(ROOT, 'node_modules', '@imagemagick', 'magick-wasm', 'dist', 'x86', 'magick.wasm'),
  ),
)

// ---------------------------------------------------------------------------------------------
// The canonical upright image: a 3x2 grid of 20px cells, 60x40, six distinct saturated colours.
//
// Non-square so that a transform which swaps the axes is visible in the dimensions, and six
// *distinct* cells so that every one of the eight dihedral transforms produces a different picture.
// Four of the eight orientations are mirrored, and a mirror is invisible in the dimensions alone —
// which is why every assertion built on this image samples cell colours, not just width and height.
// ---------------------------------------------------------------------------------------------

export const CELL = 20
export const COLS = 3
export const ROWS = 2
export const WIDTH = CELL * COLS
export const HEIGHT = CELL * ROWS

/** Row-major, top-left first. Index = row * COLS + column. */
export const CELL_COLOURS = [
  [230, 25, 25], // red
  [25, 200, 25], // green
  [25, 60, 230], // blue
  [235, 215, 30], // yellow
  [30, 210, 215], // cyan
  [220, 40, 210], // magenta
]

/** A smooth two-axis gradient: cheap to store, expensive to decode. See `slow.jp2` below. */
function gradientImage(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      pixels[i] = Math.round((255 * x) / (width - 1))
      pixels[i + 1] = Math.round((255 * y) / (height - 1))
      pixels[i + 2] = 128
      pixels[i + 3] = 255
    }
  }
  return { width, height, pixels }
}

function uprightImage() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const colour = CELL_COLOURS[Math.floor(y / CELL) * COLS + Math.floor(x / CELL)]
      const i = (y * WIDTH + x) * 4
      pixels[i] = colour[0]
      pixels[i + 1] = colour[1]
      pixels[i + 2] = colour[2]
      pixels[i + 3] = 255
    }
  }
  return { width: WIDTH, height: HEIGHT, pixels }
}

// ---------------------------------------------------------------------------------------------
// The eight transforms, on raw RGBA.
//
// An EXIF orientation value says where the stored image's first row and first column belong in the
// *displayed* image. So to build a fixture that must decode to the canonical upright image, the
// stored pixels are the *inverse* of that value's display transform.
// ---------------------------------------------------------------------------------------------

function remap(image, outWidth, outHeight, source) {
  const out = new Uint8Array(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const [sx, sy] = source(x, y, image.width, image.height)
      const si = (sy * image.width + sx) * 4
      const di = (y * outWidth + x) * 4
      out[di] = image.pixels[si]
      out[di + 1] = image.pixels[si + 1]
      out[di + 2] = image.pixels[si + 2]
      out[di + 3] = image.pixels[si + 3]
    }
  }
  return { width: outWidth, height: outHeight, pixels: out }
}

const identity = (i) => i
const flop = (i) => remap(i, i.width, i.height, (x, y, w) => [w - 1 - x, y])
const flip = (i) => remap(i, i.width, i.height, (x, y, w, h) => [x, h - 1 - y])
const rotate180 = (i) => remap(i, i.width, i.height, (x, y, w, h) => [w - 1 - x, h - 1 - y])
const transpose = (i) => remap(i, i.height, i.width, (x, y) => [y, x])
const transverse = (i) => remap(i, i.height, i.width, (x, y, w, h) => [w - 1 - y, h - 1 - x])
const rotate90 = (i) => remap(i, i.height, i.width, (x, y, w, h) => [y, h - 1 - x])
const rotate270 = (i) => remap(i, i.height, i.width, (x, y, w) => [w - 1 - y, x])

/**
 * Orientation value -> the transform producing the *stored* pixels from the upright image.
 * 2, 4, 5 and 7 are the mirrored cases; a pipeline that treats them as rotations produces an image
 * that is the right size and the wrong way round.
 */
const STORED_FOR_ORIENTATION = {
  1: identity, // TopLeft      — already upright
  2: flop, // TopRight     — mirrored horizontally
  3: rotate180, // BottomRight
  4: flip, // BottomLeft   — mirrored vertically
  5: transpose, // LeftTop      — mirrored across the main diagonal
  6: rotate270, // RightTop     — displayed by rotating 90 clockwise
  7: transverse, // RightBottom  — mirrored across the anti-diagonal
  8: rotate90, // LeftBottom   — displayed by rotating 90 anticlockwise
}

// ---------------------------------------------------------------------------------------------
// EXIF: a TIFF header plus an IFD0 holding exactly one Orientation entry, wrapped in an APP1
// segment. Nothing else — no camera make, no GPS — so a test that finds anything beyond orientation
// in a decoded fixture has found a bug in the fixture, not in the pipeline.
// ---------------------------------------------------------------------------------------------

function exifApp1Segment(orientation) {
  const tiff = new Uint8Array(26)
  const view = new DataView(tiff.buffer)
  view.setUint16(0, 0x4949, true) // "II": little-endian
  view.setUint16(2, 42, true) // TIFF magic
  view.setUint32(4, 8, true) // offset of IFD0
  view.setUint16(8, 1, true) // one entry
  view.setUint16(10, 0x0112, true) // tag: Orientation
  view.setUint16(12, 3, true) // type: SHORT
  view.setUint32(14, 1, true) // count: 1
  view.setUint16(18, orientation, true) // value, in the 4-byte inline value field
  view.setUint32(22, 0, true) // no IFD1

  // "Exif\0\0" as bytes. Written out rather than via TextEncoder, which is not among the globals
  // this repository's ESLint config grants to scripts/.
  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  const payload = new Uint8Array(header.length + tiff.length)
  payload.set(header, 0)
  payload.set(tiff, header.length)

  const segment = new Uint8Array(4 + payload.length)
  segment[0] = 0xff
  segment[1] = 0xe1
  segment[2] = (payload.length + 2) >> 8
  segment[3] = (payload.length + 2) & 0xff
  segment.set(payload, 4)
  return segment
}

function spliceAfterSoi(jpeg, segment) {
  const out = new Uint8Array(jpeg.length + segment.length)
  out.set(jpeg.subarray(0, 2), 0)
  out.set(segment, 2)
  out.set(jpeg.subarray(2), 2 + segment.length)
  return out
}

// ---------------------------------------------------------------------------------------------
// A minimal ICC v2 RGB matrix/TRC profile. Display P3 primaries, Bradford-adapted to the D50 PCS,
// with the sRGB electro-optical curve sampled into a 1024-point `curv` tag.
//
// Written by hand rather than copied from a system profile: an installed profile is somebody
// else's copyrighted work and could not be committed to an AGPL repository without an attribution
// directory it does not warrant. These bytes are ours.
// ---------------------------------------------------------------------------------------------

const signature = (text) => new Uint8Array([...text].map((c) => c.charCodeAt(0)))
const s15Fixed16 = (value) => Math.round(value * 65536)

function xyzTag(x, y, z) {
  const bytes = new Uint8Array(20)
  const view = new DataView(bytes.buffer)
  bytes.set(signature('XYZ '), 0)
  view.setInt32(8, s15Fixed16(x))
  view.setInt32(12, s15Fixed16(y))
  view.setInt32(16, s15Fixed16(z))
  return bytes
}

function srgbCurveTag(points = 1024) {
  const bytes = new Uint8Array(12 + points * 2)
  const view = new DataView(bytes.buffer)
  bytes.set(signature('curv'), 0)
  view.setUint32(8, points)
  for (let i = 0; i < points; i++) {
    const encoded = i / (points - 1)
    const linear = encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4)
    view.setUint16(12 + i * 2, Math.round(linear * 65535))
  }
  return bytes
}

function descriptionTag(text) {
  const ascii = `${text}\0`
  // ICC v2 textDescriptionType: ASCII count and string, then the empty Unicode and ScriptCode
  // sub-records the type requires (2 + 4 + 4 + 2 + 1 + 67 bytes of zeroes).
  const bytes = new Uint8Array(12 + ascii.length + 78)
  const view = new DataView(bytes.buffer)
  bytes.set(signature('desc'), 0)
  view.setUint32(8, ascii.length)
  for (let i = 0; i < ascii.length; i++) bytes[12 + i] = ascii.charCodeAt(i)
  return bytes
}

function textTag(text) {
  const ascii = `${text}\0`
  const bytes = new Uint8Array(8 + ascii.length)
  bytes.set(signature('text'), 0)
  for (let i = 0; i < ascii.length; i++) bytes[8 + i] = ascii.charCodeAt(i)
  return bytes
}

function buildIccProfile(description) {
  const tags = [
    ['desc', descriptionTag(description)],
    ['cprt', textTag('Generated test fixture, no rights reserved')],
    ['wtpt', xyzTag(0.9642, 1.0, 0.82491)],
    ['rXYZ', xyzTag(0.51512, 0.2412, -0.00105)],
    ['gXYZ', xyzTag(0.29198, 0.69225, 0.04189)],
    ['bXYZ', xyzTag(0.1571, 0.06657, 0.78407)],
    ['rTRC', srgbCurveTag()],
    ['gTRC', srgbCurveTag()],
    ['bTRC', srgbCurveTag()],
  ]

  const tableSize = 4 + tags.length * 12
  const entries = []
  const blobs = []
  let offset = 128 + tableSize
  for (const [name, data] of tags) {
    entries.push([name, offset, data.length])
    blobs.push(data)
    offset += data.length
    while (offset % 4 !== 0) {
      offset += 1
      blobs.push(new Uint8Array(1))
    }
  }

  const profile = new Uint8Array(offset)
  const view = new DataView(profile.buffer)
  view.setUint32(0, offset) // profile size
  view.setUint32(8, 0x02100000) // version 2.1
  profile.set(signature('mntr'), 12) // device class: display
  profile.set(signature('RGB '), 16)
  profile.set(signature('XYZ '), 20)
  profile.set(signature('acsp'), 36)
  view.setUint32(64, 0) // rendering intent: perceptual
  view.setInt32(68, s15Fixed16(0.9642)) // PCS illuminant: D50
  view.setInt32(72, s15Fixed16(1.0))
  view.setInt32(76, s15Fixed16(0.82491))
  view.setUint32(128, tags.length)

  let p = 132
  for (const [name, tagOffset, length] of entries) {
    profile.set(signature(name), p)
    view.setUint32(p + 4, tagOffset)
    view.setUint32(p + 8, length)
    p += 12
  }

  let w = 128 + tableSize
  for (const blob of blobs) {
    profile.set(blob, w)
    w += blob.length
  }
  return profile
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

function encode(image, format, mutate) {
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: image.width,
    height: image.height,
    depth: 8,
  })
  return ImageMagick.read(image.pixels, settings, (magickImage) => {
    // Not 100 for AVIF: AOM reads quality 100 as lossless, and lossless conflicts with this build's
    // default chroma-delta-q setting ("Only --enable_chroma_deltaq=0 can be used with
    // --lossless=1"). 95 with 4:4:4 chroma keeps the cell colours well inside the tolerance the
    // assertions use.
    magickImage.quality = format === MagickFormat.Avif ? 95 : 100
    // 4:4:4. Chroma subsampling would bleed neighbouring cell colours across the boundaries the
    // orientation assertions sample either side of.
    //
    // The AVIF define goes under `heic:`, not `avif:` — the same namespace trap as `defineCicp`
    // below, and one worth stating twice because it fails silently in both places: `avif:chroma=444`
    // produces a file byte-identical to passing no define at all (506 bytes either way, against 551
    // for `heic:chroma=444`), so the safety margin the comment above describes simply would not
    // exist.
    magickImage.settings.setDefine(MagickFormat.Jpeg, 'sampling-factor', '1x1')
    magickImage.settings.setDefine(MagickFormat.Heic, 'chroma', '444')
    mutate?.(magickImage)
    let bytes = null
    magickImage.write(format, (data) => {
      bytes = new Uint8Array(data)
    })
    return bytes
  })
}

function write(name, bytes) {
  writeFileSync(join(OUT_DIR, name), bytes)
  process.stdout.write(`${name} — ${bytes.length} bytes\n`)
}

mkdirSync(OUT_DIR, { recursive: true })

const upright = uprightImage()

// --- the eight-orientation set ---------------------------------------------------------------
for (let value = 1; value <= 8; value++) {
  const stored = STORED_FOR_ORIENTATION[value](upright)
  write(
    `orientation-${value}.jpg`,
    spliceAfterSoi(encode(stored, MagickFormat.Jpeg), exifApp1Segment(value)),
  )
}

// --- the third orientation state: no EXIF at all ----------------------------------------------
// Distinct from orientation-1.jpg, which carries a tag that *says* upright. Absent and
// present-and-default are different states and the pipeline must not conflate them.
write('orientation-absent.jpg', encode(upright, MagickFormat.Jpeg))

// --- colour ------------------------------------------------------------------------------------
const iccProfile = buildIccProfile('Display P3 test fixture')
write('icc-profile.bin', iccProfile)
write(
  'icc-p3.jpg',
  encode(upright, MagickFormat.Jpeg, (image) =>
    image.setProfile(new ImageProfile('icc', iccProfile)),
  ),
)

// An AVIF whose colour is signalled only by an `nclx` box: no ICC profile anywhere in the file.
// This is R-I35's case, and the one a pipeline that only looks for a profile reads as sRGB.
// 12/13/6 is Display P3 primaries, the sRGB transfer function, and BT.601 matrix coefficients.
const CICP = { primaries: 12, transfer: 13, matrix: 6 }

/**
 * Writes the `colr`/`nclx` box.
 *
 * The namespace is `heic:`, not `avif:`, even when the output is AVIF — one coder serves the whole
 * HEIF family and reads its options under the one prefix. Setting them under `avif:` is silently
 * ineffective: the encode succeeds and produces a file with no colour signalling at all, which is
 * precisely the state R-I35 is about, so it makes a convincing-looking but useless fixture.
 */
function defineCicp(image) {
  image.settings.setDefine(
    MagickFormat.Heic,
    'cicp',
    `${CICP.primaries},${CICP.transfer},${CICP.matrix}`,
  )
  image.settings.setDefine(MagickFormat.Heic, 'preserve-cicp', 'true')
}
write('cicp-p3.avif', encode(upright, MagickFormat.Avif, defineCicp))

// The same container family carrying an ICC profile instead, so decode's ICC branch is proven on
// AVIF and not only on JPEG.
//
// There is deliberately no both-signals-present file here: asked for an ICC profile and CICP at
// once, this build's HEIF writer emits the profile and drops the `nclx` box, so such a fixture
// cannot be generated with the tools in the build. The ICC-over-CICP precedence is proven instead
// by a hand-built box tree in src/pipeline/stages/colour.spec.ts, and against a real
// profile-and-nclx AVIF in verification/t23-decode/.
write(
  'icc-p3.avif',
  encode(upright, MagickFormat.Avif, (image) => {
    image.setProfile(new ImageProfile('icc', iccProfile))
    defineCicp(image)
  }),
)

// An ordinary AVIF with neither signal — the untagged case (R-I14).
write('untagged.avif', encode(upright, MagickFormat.Avif))

// --- inputs for the §10.4 thumbnail fallback ---------------------------------------------------
//
// JPEG 2000 is measured to be undecodable by `createImageBitmap` on Chromium, Firefox *and* WebKit,
// while being a format `domain/classify.ts` accepts as supported input — so it drives the fallback
// on every engine rather than on the two that happen to lack a decoder. TIFF does not: WebKit
// decodes it natively through ImageIO, so a TIFF-based test exercises the fallback on two engines
// out of three and silently proves something weaker on the third.
write('plain.jp2', encode(upright, MagickFormat.Jp2))

// A JP2 whose decode takes long enough to be observable: R-G12 asks that leaving Gallery *stops*
// an in-flight decode, and a 60x40 image finishes faster than a test can react, so a test built on
// one would pass whether the work was stopped or merely finished and discarded.
//
// A smooth gradient rather than noise: decode cost scales with pixel count while compressed size
// scales with entropy, so this is ~590 ms of synchronous ImageMagick work in ~38 KB of committed
// fixture. High-entropy content of the same dimensions costs the same time and 700 KB.
write('slow.jp2', encode(gradientImage(4000, 3000), MagickFormat.Jp2))
write('plain.tif', encode(upright, MagickFormat.Tiff))
