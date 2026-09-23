#!/usr/bin/env node
// Generates the animated fixtures in tests/fixtures/animated/ (T29 — Functional Design R-F5, R-Q9,
// R-Q10; Technical Design §4.2). Run with `node scripts/build-animated-fixtures.mjs`.
//
// The outputs are committed and this generator is committed with them, the same arrangement
// scripts/build-test-fixtures.mjs uses for the decode set.
//
// **Nothing here goes through ImageMagick, UPNG or apng-optimizer**, which is the whole point: T26
// and T27 both established that a fixture produced by the library under test only proves the
// library agrees with itself. The three containers come from three independent encoders —
//
//   GIF   ffmpeg's own GIF muxer
//   WebP  libwebp's img2webp
//   APNG  ffmpeg's own APNG muxer
//
// — and the frames they are built from are PNGs written here by hand (a signature, IHDR, one
// zlib-deflated IDAT and IEND), so even the input pixels owe nothing to the pipeline.
//
// Every fixture is deliberately awkward in three ways, because the easy version of each hides a
// class of bug:
//
//   1. **Unequal frame delays.** [40, 120, 40, 200, 80, 40] ms. Uniform delays are the default that
//      makes a delay bug invisible, and the values are chosen so that no two adjacent frames share
//      one — an off-by-one in frame order shows up as a wrong delay list.
//   2. **A finite, non-default loop count** of 3. Infinite is the default that hides a loop bug, so
//      the set also carries an explicitly-infinite GIF and one with no loop record at all: absent,
//      present-and-default and present-and-unusual are three different states.
//   3. **Per-frame distinguishable content.** Each frame is a different flat colour with a white
//      16x16 marker in one corner, so "frame 3 is frame 3" is checkable rather than "there are six
//      frames".
//
// A missing tool prints a reason and skips that file rather than failing, so a machine without
// Homebrew can still run the rest.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT_DIR = join(ROOT, 'tests', 'fixtures', 'animated')
const DECODE_FIXTURES = join(ROOT, 'tests', 'fixtures', 'decode')

// ---------------------------------------------------------------------------------------------
// The canonical animation. Mirrored in tests/e2e/animation.spec.ts — if this changes, that changes
// with it.
// ---------------------------------------------------------------------------------------------

export const WIDTH = 64
export const HEIGHT = 64

/** One flat colour per frame, the same six saturated values the decode fixtures use. */
export const FRAME_COLOURS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
]

/** Milliseconds. Unequal, and no two neighbours alike. */
export const FRAME_DELAYS_MS = [40, 120, 40, 200, 80, 40]

/** A finite, non-default loop count: 0 (infinite) is what a bug would leave behind. */
export const LOOP_COUNT = 3

/**
 * Durations that are **not** whole centiseconds, for the one fixture whose job is to catch a delay
 * being rounded.
 *
 * Every other animation here uses multiples of 10 ms, which is what GIF can store and what
 * ImageMagick reports for any container — so the whole set agreed with a decoder that silently
 * quantized to centiseconds, and did until this file was added. `999` and `1` bracket the range
 * where rounding is most visible: `1` becomes `0`, a frame with no duration at all.
 */
export const ODD_DELAYS_MS = [45, 33, 7, 101, 999, 1]

/** The larger fixture's shape: sixteen frames at 400x400, which decodes to 10.2 MB of pixels. */
export const LARGE_FRAME_COUNT = 16
export const LARGE_SIZE = 400
/** Uniform here on purpose: this fixture is about size, and the delay assertions live on the others. */
export const LARGE_DELAY_MS = 60

/** The fully transparent square, in the bottom-right corner. */
const TRANSPARENT_ORIGIN = 40
/** The white marker square, in the top-left corner. */
const MARKER_SIZE = 16

// ---------------------------------------------------------------------------------------------
// A minimal PNG writer: signature, IHDR, one deflated IDAT of filter-0 scanlines, IEND.
//
// CRC32 is implemented here as well as in src/pipeline/stages/animation-plan.ts, on purpose. The
// unit tests check the shipped implementation against the CRCs *this* one wrote into the committed
// fixtures, so the two are independent witnesses rather than one mistake agreeing with itself.
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function writePngBuffer(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0 // filter type 0, None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (1 + stride) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Inserts `chunk` immediately after IHDR, where the PNG specification wants iCCP and eXIf. */
function spliceAfterIhdr(png, chunk) {
  const pieces = [png.subarray(0, 8)]
  let at = 8

  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    pieces.push(png.subarray(at, at + 12 + length))
    if (type === 'IHDR') pieces.push(chunk)
    at += 12 + length
    if (type === 'IEND') break
  }

  return Buffer.concat(pieces)
}

// ---------------------------------------------------------------------------------------------
// Frame content.
// ---------------------------------------------------------------------------------------------

/**
 * One frame: a flat colour, a white marker square at the top left, and a fully transparent square
 * at the bottom right.
 *
 * The transparent square is in *every* frame and in the same place, so that a coalescing bug that
 * composites a frame over its predecessor cannot fill it in from below and hide itself.
 */
function frameImage(index, { transparent = true } = {}) {
  const [r, g, b] = FRAME_COLOURS[index % FRAME_COLOURS.length]
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4)

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4
      const marker = x < MARKER_SIZE && y < MARKER_SIZE
      const hole = transparent && x >= TRANSPARENT_ORIGIN && y >= TRANSPARENT_ORIGIN

      pixels[i] = marker ? 255 : r
      pixels[i + 1] = marker ? 255 : g
      pixels[i + 2] = marker ? 255 : b
      pixels[i + 3] = hole ? 0 : 255
    }
  }

  return pixels
}

/**
 * A frame of the larger `anim-16f-400.webp` set: the same flat colours, cycled, with a vertical bar
 * whose position encodes the frame index so that all sixteen frames are distinguishable from each
 * other rather than only from their neighbours.
 *
 * It exists because every other fixture here is 64x64, which is the right size for asserting pixel
 * values and the wrong size for anything about time or memory. Flat content keeps the file to a few
 * kilobytes while decoding to the full 400 x 400 x 4 per frame, which is what the cost is made of.
 */
export function largeFrameImage(index, width, height, frameCount) {
  const [r, g, b] = FRAME_COLOURS[index % FRAME_COLOURS.length]
  const pixels = new Uint8Array(width * height * 4)
  const barX = Math.floor((index * width) / frameCount)
  const barWidth = Math.max(2, Math.floor(width / frameCount))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const bar = x >= barX && x < barX + barWidth

      pixels[i] = bar ? 255 : r
      pixels[i + 1] = bar ? 255 : g
      pixels[i + 2] = bar ? 255 : b
      pixels[i + 3] = 255
    }
  }

  return pixels
}

/**
 * Frame `index` of the disposal set: an opaque dark field onto which one more coloured square is
 * painted per frame, so frame *n* shows *n* squares.
 *
 * Only the new square differs from the previous frame, so ffmpeg's GIF muxer writes each frame as
 * a small sub-rectangle with "do not dispose". Read without coalescing, frame 3 is a 16x16 tile;
 * read with it, it is the full canvas with three squares. That difference is what the fixture is
 * for, and it is a difference no amount of frame counting would notice.
 */
function disposalFrameImage(index) {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4)

  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 20
    pixels[i + 1] = 20
    pixels[i + 2] = 30
    pixels[i + 3] = 255
  }

  for (let square = 0; square <= index; square += 1) {
    const [r, g, b] = FRAME_COLOURS[square]
    const originX = (square % 3) * 16 + 8
    const originY = Math.floor(square / 3) * 16 + 8

    for (let y = originY; y < originY + 16; y += 1) {
      for (let x = originX; x < originX + 16; x += 1) {
        const i = (y * WIDTH + x) * 4
        pixels[i] = r
        pixels[i + 1] = g
        pixels[i + 2] = b
      }
    }
  }

  return pixels
}

// ---------------------------------------------------------------------------------------------
// Tool plumbing.
// ---------------------------------------------------------------------------------------------

const skipped = []

function hasTool(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function run(tool, args) {
  execFileSync(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] })
}

function write(name, bytes) {
  writeFileSync(join(OUT_DIR, name), bytes)
  process.stdout.write(`${name} — ${bytes.length} bytes\n`)
}

function skip(name, reason) {
  skipped.push(`${name}: ${reason}`)
  process.stdout.write(`${name} — SKIPPED (${reason})\n`)
}

/** The concat demuxer's script: one `file` line per frame, each followed by its duration. */
function concatScript(files, delaysMs) {
  return files.map((file, index) => `file '${file}'\nduration ${delaysMs[index] / 1000}\n`).join('')
}

// Everything below runs only when this file is executed directly. The builders above are exported
// so verification/t29-animated/ can generate its own sources from the same code rather than keeping
// a second, drifting copy of the frame content — importing this module must not rewrite the
// committed fixtures as a side effect.
const RUN_DIRECTLY =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (RUN_DIRECTLY) {
  generate()
}

function generate() {
  mkdirSync(OUT_DIR, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 't29-fixtures-'))

  try {
    // --- the source frames, as PNG files the tools can read --------------------------------------
    const framePaths = FRAME_COLOURS.map((_, index) => {
      const path = join(work, `frame-${index}.png`)
      writeFileSync(path, writePngBuffer(WIDTH, HEIGHT, frameImage(index)))
      return path
    })
    const disposalPaths = FRAME_COLOURS.map((_, index) => {
      const path = join(work, `disposal-${index}.png`)
      writeFileSync(path, writePngBuffer(WIDTH, HEIGHT, disposalFrameImage(index)))
      return path
    })

    const listPath = join(work, 'frames.txt')
    writeFileSync(listPath, concatScript(framePaths, FRAME_DELAYS_MS))
    const disposalListPath = join(work, 'disposal.txt')
    writeFileSync(disposalListPath, concatScript(disposalPaths, FRAME_DELAYS_MS))

    // --- GIF, three loop states ------------------------------------------------------------------
    //
    // ffmpeg's `-loop` writes the NETSCAPE2.0 application extension's count verbatim; `-loop -1`
    // omits the block entirely, which is the third state and the one a reader is most likely to
    // confuse with "loop forever".
    //
    // The palette filters are not optional. ffmpeg's default GIF path quantizes to a fixed 256-colour
    // cube with Bayer dithering, which turned a flat 230,25,25 field into dithered 252,36,85 and made
    // the disposal fixture's squares unreadable — so a test that asserts "frame 3 is the blue one"
    // could not be written against it. `palettegen=stats_mode=full` builds a palette from the whole
    // animation, `dither=none` keeps the flat colours exact, and `reserve_transparent` plus
    // `alpha_threshold` are what map a zero-alpha pixel onto GIF's transparent palette index instead
    // of some opaque colour. GIF's transparency is one index, not a channel; without these the hole
    // in every frame comes back solid.
    const PALETTE_FILTER =
      'split[a][b];[a]palettegen=stats_mode=full:reserve_transparent=1[p];' +
      '[b][p]paletteuse=dither=none:alpha_threshold=128'

    if (hasTool('ffmpeg')) {
      const gif = (name, list, loop) => {
        const path = join(work, name)
        run('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          list,
          '-filter_complex',
          PALETTE_FILTER,
          '-loop',
          String(loop),
          '-fps_mode',
          'vfr',
          '-f',
          'gif',
          path,
        ])
        write(name, readFileSync(path))
      }

      gif('anim-6f.gif', listPath, LOOP_COUNT)
      gif('anim-loop0.gif', listPath, 0)
      gif('anim-loopnone.gif', listPath, -1)
      gif('anim-disposal.gif', disposalListPath, LOOP_COUNT)

      // A single-frame GIF. `domain/classify.ts` reports it as not animated, so the still path takes
      // it — the one member of this set that must *not* reach decodeAnimation.
      const singlePath = join(work, 'single.txt')
      writeFileSync(singlePath, concatScript([framePaths[0]], [FRAME_DELAYS_MS[0]]))
      gif('anim-1f.gif', singlePath, 0)

      // --- APNG ----------------------------------------------------------------------------------
      //
      // `-final_delay` is needed because the muxer otherwise repeats the previous frame's delay for
      // the last one. `-plays` writes acTL's num_plays.
      //
      // ffmpeg writes fcTL delays as the rational that matches the timebase — 1/25, 3/25, 1/5, 2/25
      // here, *not* the /1000 UPNG writes. That is deliberate and valuable: a reader that assumes
      // delay_den is 1000 divides by 1000 where it should divide by 25, reading those delays 40x
      // too small, and a 1/5 delay 200x too small.
      const apngPath = join(work, 'anim.png')
      run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-plays',
        String(LOOP_COUNT),
        '-final_delay',
        `${FRAME_DELAYS_MS[FRAME_DELAYS_MS.length - 1]}/1000`,
        '-fps_mode',
        'vfr',
        '-f',
        'apng',
        apngPath,
      ])
      const apng = readFileSync(apngPath)
      write('anim-6f.png', apng)

      // The same APNG carrying an ICC profile. The profile is the one build-test-fixtures.mjs wrote
      // for the decode set — ours, so no third-party licence follows it into the repository — and the
      // iCCP chunk is assembled here rather than by an encoder, because no tool on this machine
      // attaches a profile to an APNG.
      const iccProfile = readFileSync(join(DECODE_FIXTURES, 'icc-profile.bin'))
      const iccpData = Buffer.concat([
        Buffer.from('icc\0', 'latin1'), // profile name, NUL-terminated
        Buffer.from([0]), // compression method: deflate, the only one defined
        deflateSync(iccProfile, { level: 9 }),
      ])
      write('anim-icc.png', spliceAfterIhdr(apng, pngChunk('iCCP', iccpData)))
    } else {
      for (const name of [
        'anim-6f.gif',
        'anim-loop0.gif',
        'anim-loopnone.gif',
        'anim-disposal.gif',
        'anim-1f.gif',
        'anim-6f.png',
        'anim-icc.png',
      ]) {
        skip(name, 'ffmpeg not on PATH')
      }
    }

    // --- WebP -------------------------------------------------------------------------------------
    //
    // img2webp takes a delay per frame and a loop count directly, and `-lossless` keeps the flat
    // colours exact so a frame's identity can be asserted on its pixel values rather than within a
    // tolerance.
    if (hasTool('img2webp')) {
      const webpPath = join(work, 'anim.webp')
      const args = ['-loop', String(LOOP_COUNT), '-lossless']
      framePaths.forEach((path, index) => args.push('-d', String(FRAME_DELAYS_MS[index]), path))
      args.push('-o', webpPath)
      run('img2webp', args)
      write('anim-6f.webp', readFileSync(webpPath))

      // One fixture that is not a toy. Every other file here is 64x64 — the right size for asserting
      // pixel values and the wrong size for anything about time or memory, where the cost is
      // frames x width x height x 4 and 64x64 is 16 KB a frame. This one is 1.2 KB on disk and
      // 10.2 MB decoded, which is the ratio that makes animated sources the highest-risk input
      // (R-B6).
      const largePaths = []
      for (let index = 0; index < LARGE_FRAME_COUNT; index += 1) {
        const path = join(work, `large-${index}.png`)
        writeFileSync(
          path,
          writePngBuffer(
            LARGE_SIZE,
            LARGE_SIZE,
            largeFrameImage(index, LARGE_SIZE, LARGE_SIZE, LARGE_FRAME_COUNT),
          ),
        )
        largePaths.push(path)
      }

      // The fixture that exists to catch a rounded delay. WebP stores milliseconds directly in a
      // 24-bit ANMF field, so these survive the container exactly; ImageMagick reports them as
      // [50, 30, 10, 100, 1000, 0], which is what makes this file worth committing.
      const oddPath = join(work, 'anim-odd-delays.webp')
      const oddArgs = ['-loop', String(LOOP_COUNT), '-lossless']
      framePaths.forEach((path, index) => oddArgs.push('-d', String(ODD_DELAYS_MS[index]), path))
      oddArgs.push('-o', oddPath)
      run('img2webp', oddArgs)
      write('anim-odd-delays.webp', readFileSync(oddPath))

      const largePath = join(work, 'anim-large.webp')
      const largeArgs = ['-loop', String(LOOP_COUNT), '-lossless']
      largePaths.forEach((path) => largeArgs.push('-d', String(LARGE_DELAY_MS), path))
      largeArgs.push('-o', largePath)
      run('img2webp', largeArgs)
      write('anim-16f-400.webp', readFileSync(largePath))

      // ImageMagick's WebP coder reports neither ICCP nor EXIF for an *animated* file, though it
      // reports both for a still one (measured, T29). These two fixtures are what prove the pipeline
      // reads them out of the container itself instead.
      if (hasTool('webpmux')) {
        const iccPath = join(work, 'anim-icc.webp')
        run('webpmux', [
          '-set',
          'icc',
          join(DECODE_FIXTURES, 'icc-profile.bin'),
          webpPath,
          '-o',
          iccPath,
        ])
        write('anim-icc.webp', readFileSync(iccPath))

        // A raw TIFF stream holding exactly one Orientation entry — WebP's EXIF chunk carries the
        // TIFF header directly, without JPEG's "Exif\0\0" prefix. Value 6 is a 90-degree clockwise
        // rotation, so applying it is visible in the dimensions of a non-square image and in the
        // marker's corner on this one.
        const tiff = Buffer.alloc(26)
        tiff.writeUInt16LE(0x4949, 0) // "II", little-endian
        tiff.writeUInt16LE(42, 2) // TIFF magic
        tiff.writeUInt32LE(8, 4) // offset of IFD0
        tiff.writeUInt16LE(1, 8) // one entry
        tiff.writeUInt16LE(0x0112, 10) // tag: Orientation
        tiff.writeUInt16LE(3, 12) // type: SHORT
        tiff.writeUInt32LE(1, 14) // count: 1
        tiff.writeUInt16LE(6, 18) // value, in the inline 4-byte value field
        tiff.writeUInt32LE(0, 22) // no IFD1
        const exifPath = join(work, 'exif.bin')
        writeFileSync(exifPath, tiff)

        const orientedPath = join(work, 'anim-exif.webp')
        run('webpmux', ['-set', 'exif', exifPath, webpPath, '-o', orientedPath])
        write('anim-exif.webp', readFileSync(orientedPath))
      } else {
        skip('anim-icc.webp', 'webpmux not on PATH')
        skip('anim-exif.webp', 'webpmux not on PATH')
      }
    } else {
      skip('anim-6f.webp', 'img2webp not on PATH')
      skip('anim-odd-delays.webp', 'img2webp not on PATH')
      skip('anim-16f-400.webp', 'img2webp not on PATH')
      skip('anim-icc.webp', 'img2webp not on PATH')
      skip('anim-exif.webp', 'img2webp not on PATH')
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  if (skipped.length > 0) {
    process.stdout.write(`\n${skipped.length} fixture(s) skipped:\n`)
    for (const line of skipped) process.stdout.write(`  ${line}\n`)
    process.stdout.write('Install the missing tools (Homebrew: ffmpeg, webp) and re-run.\n')
  }
}
