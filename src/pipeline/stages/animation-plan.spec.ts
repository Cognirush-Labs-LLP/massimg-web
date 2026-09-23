import { describe, expect, it } from 'vitest'
import {
  APNG_MAX_DELAY_MS,
  AnimationFormatError,
  APNG_DEFLATE_ITERATIONS,
  APNG_DEFLATE_METHOD,
  GIF_LOOPS_WHEN_ABSENT,
  WEBP_MIN_DELAY_MS,
  apngDelayFraction,
  apngOptimizerOptions,
  attachApngIccp,
  crc32,
  gifTotalPlays,
  setApngFrameDelays,
  setWebpFrameDurations,
  readApngAnimation,
  readGifAnimation,
  readWebpAnimation,
  readWebpIccProfile,
  readWebpOrientation,
  setApngLoopCount,
} from './animation-plan'

// Every container below is built byte by byte in this file. That is not a convenience: these
// readers are what the e2e tests assert *against*, so checking them only against the encoders they
// exist to keep honest would prove nothing.
//
// The committed fixtures — real GIF, WebP and APNG files from ffmpeg, img2webp and webpmux — drive
// the same readers in `tests/e2e/animation.spec.ts`, where a spec can read from disk, together with
// a check that `crc32` reproduces every CRC ffmpeg wrote. `src/**` compiles under
// `tsconfig.app.json`, which deliberately has no Node types, so a unit test here cannot open a file
// and should not try.
//
// What lives here rather than there: the cases no encoder on this machine emits — a missing `acTL`,
// a truncated chunk, `delay_den` of 0 and of 3, a frame with no Graphic Control Extension, an
// odd-length RIFF chunk, a big-endian TIFF, a loop count of 2^32 - 1.

/** The same shape scripts/build-animated-fixtures.mjs writes, so both halves describe one animation. */
const DELAYS_MS = [40, 120, 40, 200, 80, 40]
const LOOPS = 3
const WIDTH = 64
const HEIGHT = 64

// ---------------------------------------------------------------------------------------------
// Byte builders.
// ---------------------------------------------------------------------------------------------

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = []

  for (const part of parts) {
    for (const byte of part) flat.push(byte)
  }

  return new Uint8Array(flat)
}

function u16le(value: number): number[] {
  return [value & 255, (value >>> 8) & 255]
}

function u24le(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
}

function u32le(value: number): number[] {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 255, value & 255]
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

// --- GIF --------------------------------------------------------------------------------------

/** One frame: a Graphic Control Extension, an image descriptor, and an empty LZW sub-block chain. */
function gifFrame(delayMs: number | null, { localTable = false } = {}): number[] {
  const parts: number[] = []

  if (delayMs !== null) {
    parts.push(0x21, 0xf9, 4, 0x00, ...u16le(Math.round(delayMs / 10)), 0x00, 0x00)
  }

  parts.push(0x2c, 0, 0, 0, 0, ...u16le(WIDTH), ...u16le(HEIGHT), localTable ? 0x81 : 0x00)

  if (localTable) {
    parts.push(...new Array<number>(3 * 4).fill(0x40))
  }

  // The LZW minimum code size, then one empty sub-block chain: no image data is decoded here, and a
  // reader that needed to would have an LZW implementation to share a bug with.
  parts.push(0x02, 0x00)

  return parts
}

function netscapeBlock(loops: number): number[] {
  return [0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, ...u16le(loops), 0]
}

function gif({
  loops,
  delays,
  globalTable = false,
}: {
  loops: number | null
  delays: (number | null)[]
  globalTable?: boolean
}): Uint8Array {
  const parts: number[] = [
    ...ascii('GIF89a'),
    ...u16le(WIDTH),
    ...u16le(HEIGHT),
    globalTable ? 0x81 : 0x00,
    0x00,
    0x00,
  ]

  if (globalTable) {
    parts.push(...new Array<number>(3 * 4).fill(0x40))
  }

  if (loops !== null) {
    parts.push(...netscapeBlock(loops))
  }

  for (const delay of delays) {
    parts.push(...gifFrame(delay))
  }

  parts.push(0x3b)

  return new Uint8Array(parts)
}

const GIF_6F = gif({ loops: LOOPS, delays: DELAYS_MS })

// --- WebP -------------------------------------------------------------------------------------

function riffChunk(fourcc: string, payload: number[]): number[] {
  // RIFF pads every odd-length payload to an even boundary, and the pad byte is not counted in the
  // size field. A walker that forgets it desynchronises on the first odd chunk.
  const padded = payload.length % 2 === 1 ? [...payload, 0] : payload

  return [...ascii(fourcc), ...u32le(payload.length), ...padded]
}

function webp(chunks: number[][]): Uint8Array {
  const body = [...ascii('WEBP'), ...chunks.flat()]

  return bytes(ascii('RIFF'), u32le(body.length), body)
}

const VP8X_ANIMATION = 0x02
const VP8X_ICC = 0x20
const VP8X_EXIF = 0x08

function vp8x(flags: number): number[] {
  return riffChunk('VP8X', [flags, 0, 0, 0, ...u24le(WIDTH - 1), ...u24le(HEIGHT - 1)])
}

function anim(loops: number): number[] {
  return riffChunk('ANIM', [0, 0, 0, 255, ...u16le(loops)])
}

function anmf(delayMs: number): number[] {
  return riffChunk('ANMF', [
    ...u24le(0),
    ...u24le(0),
    ...u24le(WIDTH - 1),
    ...u24le(HEIGHT - 1),
    ...u24le(delayMs),
    0,
  ])
}

const WEBP_6F = webp([vp8x(VP8X_ANIMATION), anim(LOOPS), ...DELAYS_MS.map(anmf)])

/** A little-endian TIFF stream holding exactly one IFD0 entry. */
function tiffOrientation(value: number): number[] {
  return [
    ...ascii('II'),
    ...u16le(42),
    ...u32le(8),
    ...u16le(1),
    ...u16le(0x0112),
    ...u16le(3),
    ...u32le(1),
    ...u16le(value),
    0,
    0,
    ...u32le(0),
  ]
}

// --- APNG -------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * A chunk with a real CRC, computed by the module's own `crc32`.
 *
 * That is circular on its own, which is why the e2e checks the same function against every CRC
 * ffmpeg wrote into the committed fixture — an independent implementation, on twenty-odd chunks.
 */
function pngChunk(type: string, data: number[]): number[] {
  const typed = [...ascii(type), ...data]

  return [...u32be(data.length), ...typed, ...u32be(crc32(new Uint8Array(typed)))]
}

function ihdr(): number[] {
  return pngChunk('IHDR', [...u32be(WIDTH), ...u32be(HEIGHT), 8, 6, 0, 0, 0])
}

function fctl(delayNum: number, delayDen: number, sequence: number): number[] {
  return pngChunk('fcTL', [
    ...u32be(sequence),
    ...u32be(WIDTH),
    ...u32be(HEIGHT),
    ...u32be(0),
    ...u32be(0),
    ...u16be(delayNum),
    ...u16be(delayDen),
    0,
    0,
  ])
}

/** `frames` are `[delay_num, delay_den]` pairs — the form the chunk really stores. */
function apng({
  frames,
  declared,
  loops,
}: {
  frames: [number, number][]
  declared?: number
  loops: number
}): Uint8Array {
  const parts: number[] = [
    ...PNG_SIGNATURE,
    ...ihdr(),
    ...pngChunk('acTL', [...u32be(declared ?? frames.length), ...u32be(loops)]),
  ]

  frames.forEach(([num, den], index) => {
    parts.push(...fctl(num, den, index))
    parts.push(...(index === 0 ? pngChunk('IDAT', [1, 2, 3]) : pngChunk('fdAT', [0, 0, 0, index])))
  })

  parts.push(...pngChunk('IEND', []))

  return new Uint8Array(parts)
}

/**
 * The denominators ffmpeg actually wrote into the committed APNG fixture: 25, 5, and 1000 for the
 * frame whose delay was forced. UPNG writes 1000 throughout, so a reader tested only against UPNG's
 * output would never meet the other two.
 */
const APNG_FRAMES: [number, number][] = [
  [1, 25],
  [3, 25],
  [1, 25],
  [1, 5],
  [2, 25],
  [40, 1000],
]

const APNG_6F = apng({ frames: APNG_FRAMES, loops: LOOPS })

const STILL_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...ihdr(),
  ...pngChunk('IDAT', [1, 2, 3]),
  ...pngChunk('IEND', []),
])

/**
 * Truncation must be an `AnimationFormatError` and never a `RangeError`, which `worker.ts` reports
 * to the user as the machine running out of memory (T23 met exactly that bug).
 */
function expectFormatErrorOnTruncation(
  read: (input: Uint8Array) => unknown,
  whole: Uint8Array,
  lengths: number[],
): void {
  for (const length of lengths) {
    let thrown: unknown

    try {
      read(whole.slice(0, length))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AnimationFormatError)
    expect(thrown).not.toBeInstanceOf(RangeError)
  }
}

// ---------------------------------------------------------------------------------------------

describe('readGifAnimation', () => {
  it('reads the canvas, the frame count, the delays and the loop count', () => {
    const info = readGifAnimation(GIF_6F)

    expect(info.width).toBe(WIDTH)
    expect(info.height).toBe(HEIGHT)
    expect(info.frameCount).toBe(6)
    expect(info.frames.map((frame) => frame.delayMs)).toEqual(DELAYS_MS)
    expect(info.loops).toBe(LOOPS)
    expect(info.loopSignal).toEqual({ kind: 'present', loops: LOOPS })
  })

  it('reads a single-frame GIF as one frame', () => {
    expect(readGifAnimation(gif({ loops: 0, delays: [40] })).frameCount).toBe(1)
  })

  it('accepts GIF87a as well as GIF89a', () => {
    const eightySeven = GIF_6F.slice()
    eightySeven.set(ascii('GIF87a'), 0)

    expect(readGifAnimation(eightySeven).frameCount).toBe(6)
  })

  it('skips global and local colour tables of the size the packed field declares', () => {
    const withTables = bytes(
      ascii('GIF89a'),
      u16le(WIDTH),
      u16le(HEIGHT),
      [0x81, 0x00, 0x00],
      new Array<number>(3 * 4).fill(0x40),
      netscapeBlock(7),
      gifFrame(50, { localTable: true }),
      [0x3b],
    )
    const info = readGifAnimation(withTables)

    expect(info.frameCount).toBe(1)
    expect(info.frames[0]?.delayMs).toBe(50)
    expect(info.loops).toBe(7)
  })

  // The three loop states. The difference between them is the one thing here most easily got wrong,
  // and the consequence — an animation that loops for ever when the file said once — is visible to
  // the user and permanent.
  it('distinguishes a finite count, infinity and no record at all', () => {
    expect(readGifAnimation(gif({ loops: 3, delays: DELAYS_MS })).loopSignal).toEqual({
      kind: 'present',
      loops: 3,
    })
    expect(readGifAnimation(gif({ loops: 0, delays: DELAYS_MS })).loopSignal).toEqual({
      kind: 'present',
      loops: 0,
    })
    expect(readGifAnimation(gif({ loops: null, delays: DELAYS_MS })).loopSignal).toEqual({
      kind: 'absent',
    })
  })

  it('resolves a missing NETSCAPE2.0 block to one play, not to infinity', () => {
    expect(GIF_LOOPS_WHEN_ABSENT).toBe(1)
    expect(readGifAnimation(gif({ loops: null, delays: DELAYS_MS })).loops).toBe(1)
    // And an explicit 0 stays 0, so the two never collapse onto each other.
    expect(readGifAnimation(gif({ loops: 0, delays: DELAYS_MS })).loops).toBe(0)
  })

  it('ignores an application extension that is not NETSCAPE2.0', () => {
    const other = bytes(
      ascii('GIF89a'),
      u16le(WIDTH),
      u16le(HEIGHT),
      [0x00, 0x00, 0x00],
      [0x21, 0xff, 11, ...ascii('XMP DataXMP'), 4, 9, 9, 9, 9, 0],
      gifFrame(40),
      [0x3b],
    )

    expect(readGifAnimation(other).loopSignal).toEqual({ kind: 'absent' })
  })

  it('reads a frame with no Graphic Control Extension as a zero delay', () => {
    expect(readGifAnimation(gif({ loops: 0, delays: [null] })).frames).toEqual([{ delayMs: 0 }])
  })

  it('does not carry a delay forward from one frame to the next', () => {
    expect(readGifAnimation(gif({ loops: 0, delays: [90, null] })).frames).toEqual([
      { delayMs: 90 },
      { delayMs: 0 },
    ])
  })

  it('converts centiseconds to milliseconds', () => {
    expect(readGifAnimation(gif({ loops: 0, delays: [10, 250] })).frames).toEqual([
      { delayMs: 10 },
      { delayMs: 250 },
    ])
  })

  it('refuses bytes that are not a GIF', () => {
    expect(() => readGifAnimation(new Uint8Array(20))).toThrow(AnimationFormatError)
    expect(() => readGifAnimation(WEBP_6F)).toThrow(AnimationFormatError)
  })

  it('reports truncation as a format error rather than a RangeError', () => {
    expectFormatErrorOnTruncation(readGifAnimation, GIF_6F, [
      5,
      12,
      20,
      40,
      GIF_6F.length - 1,
      GIF_6F.length - 3,
    ])
  })

  it('refuses a GIF with no image descriptors', () => {
    expect(() => readGifAnimation(gif({ loops: 0, delays: [] }))).toThrow(/no image descriptors/)
  })

  it('refuses an unknown block marker rather than guessing', () => {
    const corrupt = GIF_6F.slice()
    corrupt[13] = 0x5a

    expect(() => readGifAnimation(corrupt)).toThrow(/is not known/)
  })
})

describe('gifTotalPlays', () => {
  // The conversion this module exists to make explicit. GIF's block counts repeats *after* the
  // first play; WebP and APNG count total plays. Two independent implementations produce these
  // numbers for the same files — libwebp's gif2webp and ImageMagick's animationIterations — and
  // `tests/e2e/animation.spec.ts` checks ours against the second of them.
  it('adds the first play to a finite repeat count', () => {
    expect(gifTotalPlays({ kind: 'present', loops: 1 })).toBe(2)
    expect(gifTotalPlays({ kind: 'present', loops: 3 })).toBe(4)
    expect(gifTotalPlays({ kind: 'present', loops: 10 })).toBe(11)
  })

  it('leaves infinity alone', () => {
    expect(gifTotalPlays({ kind: 'present', loops: 0 })).toBe(0)
  })

  // The trap inside the trap: `GIF_LOOPS_WHEN_ABSENT` is already a total-plays figure, so a blanket
  // `+1` over every case would turn "play once" into "play twice".
  it('does not add a play to a missing record, which already means one play', () => {
    expect(gifTotalPlays({ kind: 'absent' })).toBe(1)
    expect(gifTotalPlays({ kind: 'absent' })).toBe(GIF_LOOPS_WHEN_ABSENT)
  })

  it('is applied to a real GIF without changing what the reader reports', () => {
    const info = readGifAnimation(GIF_6F)

    // The reader is the byte oracle and stays raw...
    expect(info.loops).toBe(LOOPS)
    // ...and the conversion is the only place the convention changes.
    expect(gifTotalPlays(info.loopSignal)).toBe(LOOPS + 1)
  })

  it('is monotonic and never below one for a finite count', () => {
    for (let stored = 1; stored <= 20; stored += 1) {
      expect(gifTotalPlays({ kind: 'present', loops: stored })).toBe(stored + 1)
    }
  })
})

describe('readWebpAnimation', () => {
  it('reads the canvas, the frame count, the delays and the loop count', () => {
    const info = readWebpAnimation(WEBP_6F)

    expect(info.width).toBe(WIDTH)
    expect(info.height).toBe(HEIGHT)
    expect(info.frameCount).toBe(6)
    expect(info.frames.map((frame) => frame.delayMs)).toEqual(DELAYS_MS)
    expect(info.loops).toBe(LOOPS)
  })

  it('always reports a loop record, since ANIM is mandatory for an animation', () => {
    expect(readWebpAnimation(WEBP_6F).loopSignal).toEqual({ kind: 'present', loops: LOOPS })
    expect(readWebpAnimation(webp([vp8x(VP8X_ANIMATION), anim(0), anmf(40)])).loopSignal).toEqual({
      kind: 'present',
      loops: 0,
    })
  })

  // An odd-length XMP chunk sits between ANIM and the frames: a walker that forgets RIFF's pad byte
  // desynchronises here and finds no frames at all.
  it('walks past an odd-length chunk without losing alignment', () => {
    const built = webp([
      vp8x(VP8X_ANIMATION),
      anim(9),
      riffChunk('XMP ', [1, 2, 3]),
      anmf(11),
      anmf(22),
    ])
    const info = readWebpAnimation(built)

    expect(info.frameCount).toBe(2)
    expect(info.frames.map((frame) => frame.delayMs)).toEqual([11, 22])
    expect(info.loops).toBe(9)
  })

  it('reads a three-byte duration past 65535 ms', () => {
    expect(readWebpAnimation(webp([vp8x(VP8X_ANIMATION), anim(0), anmf(200_000)])).frames).toEqual([
      { delayMs: 200_000 },
    ])
  })

  it('refuses a WebP with no VP8X, no animation flag, no ANIM or no frames', () => {
    expect(() => readWebpAnimation(webp([riffChunk('VP8 ', [0, 0])]))).toThrow(/no VP8X/)
    expect(() => readWebpAnimation(webp([vp8x(VP8X_ICC), anim(0), anmf(40)]))).toThrow(
      /animation flag/,
    )
    expect(() => readWebpAnimation(webp([vp8x(VP8X_ANIMATION), anmf(40)]))).toThrow(/no ANIM/)
    expect(() => readWebpAnimation(webp([vp8x(VP8X_ANIMATION), anim(0)]))).toThrow(/no ANMF/)
  })

  it('refuses bytes that are not a WebP', () => {
    expect(() => readWebpAnimation(GIF_6F)).toThrow(AnimationFormatError)
    expect(() => readWebpAnimation(new Uint8Array(0))).toThrow(AnimationFormatError)
  })

  it('reports truncation as a format error rather than a RangeError', () => {
    expectFormatErrorOnTruncation(readWebpAnimation, WEBP_6F, [
      4,
      11,
      13,
      30,
      WEBP_6F.length - 2,
      WEBP_6F.length - 7,
    ])
  })
})

describe('readWebpIccProfile', () => {
  const profile = [0, 0, 2, 44, 1, 2, 3, 4, 5, 6]

  it('lifts the profile the ICCP chunk carries, byte for byte', () => {
    const built = webp([
      vp8x(VP8X_ANIMATION | VP8X_ICC),
      riffChunk('ICCP', profile),
      anim(LOOPS),
      anmf(40),
    ])

    expect([...(readWebpIccProfile(built) ?? [])]).toEqual(profile)
  })

  it('lifts an odd-length profile without the RIFF pad byte', () => {
    const odd = [1, 2, 3]
    const built = webp([vp8x(VP8X_ANIMATION | VP8X_ICC), riffChunk('ICCP', odd), anim(0), anmf(40)])

    expect([...(readWebpIccProfile(built) ?? [])]).toEqual(odd)
  })

  it('returns null for an animation with no ICCP chunk', () => {
    expect(readWebpIccProfile(WEBP_6F)).toBeNull()
  })

  it('returns an owned buffer, not a window onto the source', () => {
    const built = webp([
      vp8x(VP8X_ANIMATION | VP8X_ICC),
      riffChunk('ICCP', profile),
      anim(0),
      anmf(40),
    ])
    const lifted = readWebpIccProfile(built)

    expect(lifted?.byteOffset).toBe(0)
    expect(lifted?.byteLength).toBe(lifted?.buffer.byteLength)
  })
})

describe('readWebpOrientation', () => {
  function withExif(tiff: number[]): Uint8Array {
    return webp([vp8x(VP8X_ANIMATION | VP8X_EXIF), anim(0), anmf(40), riffChunk('EXIF', tiff)])
  }

  it('reads a tag that asks for a transform', () => {
    expect(readWebpOrientation(withExif(tiffOrientation(6)))).toEqual({ kind: 'present', value: 6 })
  })

  it('reads all eight values', () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(readWebpOrientation(withExif(tiffOrientation(value)))).toEqual({
        kind: 'present',
        value,
      })
    }
  })

  // Present-and-default is its own state: a file that says "1" is not a file that says nothing,
  // even though the pixels end up identical either way.
  it('reports a tag that says upright as present, not as absent', () => {
    expect(readWebpOrientation(withExif(tiffOrientation(1)))).toEqual({ kind: 'present', value: 1 })
  })

  it('reports no EXIF chunk as absent', () => {
    expect(readWebpOrientation(WEBP_6F)).toEqual({ kind: 'absent' })
  })

  it('reads a big-endian TIFF as well as a little-endian one', () => {
    const motorola = [
      ...ascii('MM'),
      ...u16be(42),
      ...u32be(8),
      ...u16be(1),
      ...u16be(0x0112),
      ...u16be(3),
      ...u32be(1),
      ...u16be(8),
      0,
      0,
      ...u32be(0),
    ]

    expect(readWebpOrientation(withExif(motorola))).toEqual({ kind: 'present', value: 8 })
  })

  it('finds the orientation entry after another tag', () => {
    const twoEntries = [
      ...ascii('II'),
      ...u16le(42),
      ...u32le(8),
      ...u16le(2),
      // ImageWidth first, so the walk has to step over a whole 12-byte entry.
      ...u16le(0x0100),
      ...u16le(3),
      ...u32le(1),
      ...u16le(64),
      0,
      0,
      ...u16le(0x0112),
      ...u16le(3),
      ...u32le(1),
      ...u16le(3),
      0,
      0,
      ...u32le(0),
    ]

    expect(readWebpOrientation(withExif(twoEntries))).toEqual({ kind: 'present', value: 3 })
  })

  // Five files that all mean "nothing is known about orientation", none of which means "the image
  // is upright" — which is why they share the `absent` answer rather than a value of 1.
  it('reports a damaged, empty or orientation-free EXIF chunk as absent', () => {
    expect(
      readWebpOrientation(withExif([...ascii('II'), ...u16le(42), ...u32le(8), ...u16le(0)])),
    ).toEqual({ kind: 'absent' })
    expect(readWebpOrientation(withExif([1, 2, 3]))).toEqual({ kind: 'absent' })
    expect(readWebpOrientation(withExif([]))).toEqual({ kind: 'absent' })
    expect(readWebpOrientation(withExif([...ascii('II'), ...u16le(7), ...u32le(8)]))).toEqual({
      kind: 'absent',
    })
    expect(readWebpOrientation(withExif([...ascii('II'), ...u16le(42), ...u32le(4000)]))).toEqual({
      kind: 'absent',
    })
  })

  it('reports an orientation value outside 1-8 as absent rather than trusting it', () => {
    expect(readWebpOrientation(withExif(tiffOrientation(0)))).toEqual({ kind: 'absent' })
    expect(readWebpOrientation(withExif(tiffOrientation(9)))).toEqual({ kind: 'absent' })
  })
})

describe('readApngAnimation', () => {
  it('reads the canvas, the frame count, the delays and the loop count', () => {
    const info = readApngAnimation(APNG_6F)

    expect(info.width).toBe(WIDTH)
    expect(info.height).toBe(HEIGHT)
    expect(info.frameCount).toBe(6)
    expect(info.frames.map((frame) => frame.delayMs)).toEqual(DELAYS_MS)
    expect(info.loops).toBe(LOOPS)
  })

  // The committed fixture's delays are 1/25, 3/25, 1/5 and 2/25 — ffmpeg's own denominators. A
  // reader that assumed 1000 divides by 1000 where it should divide by 25 or by 5, so it reads
  // those delays 40x and 200x too small — and would still pass a test written only against UPNG's
  // output, which is all /1000.
  it('reads denominators other than 1000', () => {
    expect(
      readApngAnimation(apng({ frames: APNG_FRAMES, loops: 0 })).frames.map((f) => f.delayMs),
    ).toEqual(DELAYS_MS)
  })

  it('reads a delay denominator of zero as hundredths of a second', () => {
    expect(readApngAnimation(apng({ frames: [[4, 0]], loops: 1 })).frames).toEqual([
      { delayMs: 40 },
    ])
  })

  it('rounds a denominator that does not divide a second', () => {
    expect(readApngAnimation(apng({ frames: [[1, 3]], loops: 1 })).frames).toEqual([
      { delayMs: 333 },
    ])
    expect(readApngAnimation(apng({ frames: [[2, 3]], loops: 1 })).frames).toEqual([
      { delayMs: 667 },
    ])
  })

  it('reads a zero delay as zero rather than as a missing value', () => {
    expect(readApngAnimation(apng({ frames: [[0, 1000]], loops: 1 })).frames).toEqual([
      { delayMs: 0 },
    ])
  })

  it('reads the loop count from acTL, infinity and the maximum included', () => {
    for (const loops of [0, 1, 3, 65535, 0xffffffff]) {
      expect(readApngAnimation(apng({ frames: [[1, 25]], loops })).loops).toBe(loops)
    }
  })

  it('refuses a PNG with no acTL, which is a still image and not an animation', () => {
    expect(() => readApngAnimation(STILL_PNG)).toThrow(/no acTL/)
  })

  it('refuses an acTL whose frame count disagrees with the fcTL chunks', () => {
    expect(() =>
      readApngAnimation(
        apng({
          frames: [
            [1, 25],
            [1, 25],
          ],
          declared: 5,
          loops: 1,
        }),
      ),
    ).toThrow(/declares 5 frames but the file carries 2/)
  })

  it('refuses an fcTL that is not 26 bytes', () => {
    const short = new Uint8Array([
      ...PNG_SIGNATURE,
      ...ihdr(),
      ...pngChunk('acTL', [...u32be(1), ...u32be(0)]),
      ...pngChunk('fcTL', [1, 2, 3]),
      ...pngChunk('IEND', []),
    ])

    expect(() => readApngAnimation(short)).toThrow(/is 3 bytes, not 26/)
  })

  it('refuses bytes that are not a PNG', () => {
    expect(() => readApngAnimation(GIF_6F)).toThrow(/signature missing/)
  })

  it('reports truncation as a format error rather than a RangeError', () => {
    expectFormatErrorOnTruncation(readApngAnimation, APNG_6F, [
      4,
      10,
      30,
      60,
      APNG_6F.length - 1,
      APNG_6F.length - 12,
    ])
  })
})

describe('crc32', () => {
  // The published check value for CRC-32/ISO-HDLC, which is the variant every PNG chunk carries.
  it('produces the specification check value for "123456789"', () => {
    expect(crc32(new Uint8Array(ascii('123456789')))).toBe(0xcbf43926)
  })

  it('produces zero for no bytes', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('produces an unsigned 32-bit value when the high bit is set', () => {
    const value = crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]))

    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(0xffffffff)
  })

  it('is position-sensitive', () => {
    expect(crc32(new Uint8Array([1, 2]))).not.toBe(crc32(new Uint8Array([2, 1])))
  })

  it('reads only the bytes a subarray has in view', () => {
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9])

    expect(crc32(whole.subarray(2, 5))).toBe(crc32(new Uint8Array([1, 2, 3])))
  })
})

describe('setApngLoopCount', () => {
  it('round-trips every loop count through readApngAnimation', () => {
    for (const loops of [0, 1, 3, 7, 65535, 0xffffffff]) {
      expect(readApngAnimation(setApngLoopCount(APNG_6F, loops)).loops).toBe(loops)
    }
  })

  it('leaves the frame count and the delays alone, and changes at most eight bytes', () => {
    const patched = setApngLoopCount(APNG_6F, 9)
    const before = readApngAnimation(APNG_6F)
    const after = readApngAnimation(patched)

    expect(after.frameCount).toBe(before.frameCount)
    expect(after.frames).toEqual(before.frames)
    expect(patched.length).toBe(APNG_6F.length)

    // Four bytes of num_plays and four of the acTL CRC, and nothing else in the file.
    const differing = [...patched].filter((byte, index) => byte !== APNG_6F[index]).length

    expect(differing).toBeLessThanOrEqual(8)
  })

  it('writes a CRC that matches every chunk in the result', () => {
    const patched = setApngLoopCount(APNG_6F, 12)
    let at = 8

    while (at + 8 <= patched.length) {
      const length =
        ((patched[at] as number) << 24) |
        ((patched[at + 1] as number) << 16) |
        ((patched[at + 2] as number) << 8) |
        (patched[at + 3] as number)
      const stored =
        (((patched[at + 8 + length] as number) << 24) |
          ((patched[at + 9 + length] as number) << 16) |
          ((patched[at + 10 + length] as number) << 8) |
          (patched[at + 11 + length] as number)) >>>
        0

      expect(crc32(patched.subarray(at + 4, at + 8 + length))).toBe(stored)

      const type = String.fromCharCode(...patched.subarray(at + 4, at + 8))
      at += 12 + length
      if (type === 'IEND') break
    }
  })

  it('returns an owned buffer and does not modify its input', () => {
    const copy = APNG_6F.slice()
    const patched = setApngLoopCount(APNG_6F, 5)

    expect(APNG_6F).toEqual(copy)
    expect(patched.byteOffset).toBe(0)
    expect(patched.byteLength).toBe(patched.buffer.byteLength)
  })

  it('refuses a loop count that is not a whole number in range', () => {
    for (const value of [-1, 1.5, Number.NaN, 0x100000000]) {
      expect(() => setApngLoopCount(APNG_6F, value)).toThrow(RangeError)
    }
  })

  it('refuses a PNG with no acTL', () => {
    expect(() => setApngLoopCount(STILL_PNG, 3)).toThrow(AnimationFormatError)
  })
})

describe('APNG_MAX_DELAY_MS', () => {
  it('is the largest value a uint16 of milliseconds can hold', () => {
    expect(APNG_MAX_DELAY_MS).toBe(65535)
  })

  // GIF stores centiseconds in its own uint16, so 65535 cs is a legal delay and is 655,350 ms — an
  // order of magnitude past what an APNG written with delay_den 1000 can express. The reader
  // reports it truthfully; what the writer does about it is Pass B's decision, and this is the
  // number that decision has to be made against.
  it('is an order of magnitude below the longest delay a GIF can ask for', () => {
    const extreme = readGifAnimation(gif({ loops: 0, delays: [655350] }))

    expect(extreme.frames[0]?.delayMs).toBe(655350)
    expect(extreme.frames[0]?.delayMs).toBeGreaterThan(APNG_MAX_DELAY_MS)
  })
})

// ---------------------------------------------------------------------------------------------
// The writer's byte surgery (T29 Pass B).
// ---------------------------------------------------------------------------------------------

describe('setWebpFrameDurations', () => {
  it('rewrites every duration and leaves the rest of the file alone', () => {
    const patched = setWebpFrameDurations(WEBP_6F, [1, 2, 3, 4, 5, 6])

    expect(readWebpAnimation(patched).frames.map((f) => f.delayMs)).toEqual([1, 2, 3, 4, 5, 6])
    expect(patched.length).toBe(WEBP_6F.length)
    expect(readWebpAnimation(patched).loops).toBe(LOOPS)
    expect(readWebpAnimation(patched).frameCount).toBe(6)
  })

  // The case the whole function exists for: ImageMagick's writer replaces anything under 10 ms with
  // 100 ms, so these are the values that have to be put back.
  it('restores a sub-centisecond duration', () => {
    const clamped = setWebpFrameDurations(WEBP_6F, [100, 100, 100, 100, 100, 100])
    const restored = setWebpFrameDurations(clamped, [45, 33, 7, 101, 999, 1])

    expect(readWebpAnimation(restored).frames.map((f) => f.delayMs)).toEqual([
      45, 33, 7, 101, 999, 1,
    ])
    expect(WEBP_MIN_DELAY_MS).toBe(10)
  })

  it('writes the full 24-bit range', () => {
    const patched = setWebpFrameDurations(WEBP_6F, [0, 255, 256, 65535, 65536, 16777215])

    expect(readWebpAnimation(patched).frames.map((f) => f.delayMs)).toEqual([
      0, 255, 256, 65535, 65536, 16777215,
    ])
  })

  it('does not modify its input and owns its buffer', () => {
    const copy = WEBP_6F.slice()
    const patched = setWebpFrameDurations(WEBP_6F, DELAYS_MS)

    expect(WEBP_6F).toEqual(copy)
    expect(patched.byteOffset).toBe(0)
    expect(patched.byteLength).toBe(patched.buffer.byteLength)
  })

  it('refuses a delay list of the wrong length, or a duration out of range', () => {
    expect(() => setWebpFrameDurations(WEBP_6F, [1, 2])).toThrow(AnimationFormatError)
    expect(() => setWebpFrameDurations(WEBP_6F, [1, 2, 3, 4, 5, -1])).toThrow(RangeError)
    expect(() => setWebpFrameDurations(WEBP_6F, [1, 2, 3, 4, 5, 16777216])).toThrow(RangeError)
  })
})

describe('apngDelayFraction', () => {
  it('uses a denominator of 1000 for anything that fits', () => {
    for (const ms of [0, 1, 40, 999, 65535]) {
      expect(apngDelayFraction(ms)).toEqual({ num: ms, den: 1000 })
    }
  })

  // Past 65535 the uint16 wraps, so the fraction has to be reduced instead. These are exact, not
  // approximations: 65536 ms is 8192/125 of a second.
  it('reduces a delay that overflows the uint16', () => {
    expect(apngDelayFraction(65536)).toEqual({ num: 8192, den: 125 })
    expect(apngDelayFraction(70000)).toEqual({ num: 70, den: 1 })
    // The longest delay a GIF can ask for: 65535 centiseconds.
    expect(apngDelayFraction(655350)).toEqual({ num: 13107, den: 20 })
  })

  it('is exact for every delay a GIF can produce', () => {
    // GIF stores centiseconds, so every delay it can express is a multiple of 10 ms.
    for (let centiseconds = 0; centiseconds <= 65535; centiseconds += 257) {
      const fraction = apngDelayFraction(centiseconds * 10)

      expect(fraction).not.toBeNull()
      expect((fraction as { num: number }).num / (fraction as { den: number }).den).toBeCloseTo(
        centiseconds / 100,
        9,
      )
    }
  })

  it('returns null only where no exact fraction fits', () => {
    // 16,777,215 ms is the longest a WebP can store: 3355443/200, whose numerator does not fit.
    expect(apngDelayFraction(16777215)).toBeNull()
    // And one that does, just above the wrap.
    expect(apngDelayFraction(66000)).not.toBeNull()
  })

  it('refuses a delay that is not a whole number of milliseconds', () => {
    expect(() => apngDelayFraction(1.5)).toThrow(RangeError)
    expect(() => apngDelayFraction(-1)).toThrow(RangeError)
  })
})

describe('setApngFrameDelays', () => {
  it('rewrites every delay and reads back exactly', () => {
    const patched = setApngFrameDelays(APNG_6F, [1, 2, 3, 4, 5, 6])

    expect(readApngAnimation(patched).frames.map((f) => f.delayMs)).toEqual([1, 2, 3, 4, 5, 6])
  })

  // The overflow case. UPNG would have written 65536 as 0; this writes 8192/125.
  it('writes a delay that overflows the uint16 as an exact fraction', () => {
    const patched = setApngFrameDelays(APNG_6F, [65536, 70000, 655350, 40, 40, 40])
    const read = readApngAnimation(patched)

    expect(read.frames.map((f) => f.delayMs)).toEqual([65536, 70000, 655350, 40, 40, 40])
  })

  it('leaves the frame count and the loop count alone, and keeps every CRC valid', () => {
    const patched = setApngFrameDelays(APNG_6F, [10, 20, 30, 40, 50, 60])
    const read = readApngAnimation(patched)

    expect(read.frameCount).toBe(6)
    expect(read.loops).toBe(LOOPS)
    expect(patched.length).toBe(APNG_6F.length)

    let at = 8
    while (at + 8 <= patched.length) {
      const length =
        ((patched[at] as number) << 24) |
        ((patched[at + 1] as number) << 16) |
        ((patched[at + 2] as number) << 8) |
        (patched[at + 3] as number)
      const stored =
        (((patched[at + 8 + length] as number) << 24) |
          ((patched[at + 9 + length] as number) << 16) |
          ((patched[at + 10 + length] as number) << 8) |
          (patched[at + 11 + length] as number)) >>>
        0

      expect(crc32(patched.subarray(at + 4, at + 8 + length))).toBe(stored)

      const type = String.fromCharCode(...patched.subarray(at + 4, at + 8))
      at += 12 + length
      if (type === 'IEND') break
    }
  })

  // Clamping would change how long a frame is on screen without saying so, and R-X46's caveat set is
  // closed — there is no caveat for a shortened delay, so there is no honest way to do it quietly.
  it('refuses a delay the format cannot express exactly, rather than clamping it', () => {
    expect(() => setApngFrameDelays(APNG_6F, [16777215, 40, 40, 40, 40, 40])).toThrow(
      /cannot express a delay of 16777215 ms exactly/,
    )
  })

  it('refuses a delay list of the wrong length', () => {
    expect(() => setApngFrameDelays(APNG_6F, [1, 2])).toThrow(AnimationFormatError)
  })

  it('does not modify its input', () => {
    const copy = APNG_6F.slice()
    setApngFrameDelays(APNG_6F, [1, 2, 3, 4, 5, 6])

    expect(APNG_6F).toEqual(copy)
  })
})

describe('attachApngIccp', () => {
  const iccp = pngChunk('iCCP', [...ascii('icc'), 0, 0, 1, 2, 3])

  // The trap T27's note warns about: `png-plan.ts`'s `rewritePngChunks` whitelist has no acTL, fcTL
  // or fdAT, so an APNG put through it comes out a still image. This keeps them.
  it('keeps the animation chunks an APNG is made of', () => {
    const attached = attachApngIccp(APNG_6F, new Uint8Array(iccp))
    const read = readApngAnimation(attached)

    expect(read.frameCount).toBe(6)
    expect(read.loops).toBe(LOOPS)
    expect(read.frames.map((f) => f.delayMs)).toEqual(DELAYS_MS)
  })

  it('places the profile immediately after IHDR', () => {
    const attached = attachApngIccp(APNG_6F, new Uint8Array(iccp))
    const types: string[] = []
    let at = 8

    while (at + 8 <= attached.length) {
      const length =
        ((attached[at] as number) << 24) |
        ((attached[at + 1] as number) << 16) |
        ((attached[at + 2] as number) << 8) |
        (attached[at + 3] as number)
      const type = String.fromCharCode(...attached.subarray(at + 4, at + 8))
      types.push(type)
      at += 12 + length
      if (type === 'IEND') break
    }

    expect(types[0]).toBe('IHDR')
    expect(types[1]).toBe('iCCP')
    expect(types).toContain('acTL')
    expect(types.filter((type) => type === 'fcTL')).toHaveLength(6)
  })

  // `sRGB` beside an `iCCP` is a second, disagreeing description of the same colour, and the two are
  // mutually exclusive in the PNG specification. UPNG writes one unconditionally.
  it('drops sRGB and the metadata chunks', () => {
    const noisy = new Uint8Array([
      ...PNG_SIGNATURE,
      ...ihdr(),
      ...pngChunk('sRGB', [0]),
      ...pngChunk('tEXt', [...ascii('date:create'), 0, 49]),
      ...pngChunk('tIME', [7, 230, 1, 1, 0, 0, 0]),
      ...pngChunk('acTL', [...u32be(1), ...u32be(3)]),
      ...fctl(40, 1000, 0),
      ...pngChunk('IDAT', [1, 2, 3]),
      ...pngChunk('IEND', []),
    ])
    const attached = attachApngIccp(noisy, new Uint8Array(iccp))
    const text = String.fromCharCode(...attached)

    expect(text).not.toContain('sRGB')
    expect(text).not.toContain('tEXt')
    expect(text).not.toContain('tIME')
    expect(readApngAnimation(attached).frameCount).toBe(1)
  })

  // R-I14: an untagged animation gains no profile, and still loses anything contradicting one.
  it('adds nothing for an untagged animation', () => {
    const attached = attachApngIccp(APNG_6F, null)

    expect(String.fromCharCode(...attached)).not.toContain('iCCP')
    expect(readApngAnimation(attached).frameCount).toBe(6)
  })

  it('returns an owned buffer', () => {
    const attached = attachApngIccp(APNG_6F, new Uint8Array(iccp))

    expect(attached.byteOffset).toBe(0)
    expect(attached.byteLength).toBe(attached.buffer.byteLength)
  })

  it('refuses a PNG that does not start with IHDR', () => {
    const headless = new Uint8Array([
      ...PNG_SIGNATURE,
      ...pngChunk('acTL', [...u32be(1), ...u32be(0)]),
      ...pngChunk('IEND', []),
    ])

    expect(() => attachApngIccp(headless, null)).toThrow(AnimationFormatError)
  })
})

describe('apngOptimizerOptions', () => {
  it('turns the quantizer off, because animated PNG is always lossless', () => {
    expect(apngOptimizerOptions()).toEqual({
      deflateMethod: APNG_DEFLATE_METHOD,
      iter: APNG_DEFLATE_ITERATIONS,
      disabledQuant: true,
    })
  })

  // Guards the decision, not just the value. apng-optimizer's `minQuality` is a request it neither
  // meets nor reports on \u2014 measured, 50/70/90/99/100 all returned the same file \u2014 so R-Q11's floor
  // cannot be enforced here and no quantized candidate is offered. A future change that reaches for
  // `minQuality` again should have to delete this test and read why it exists.
  it('never asks for quantization at any quality', () => {
    const options = apngOptimizerOptions()

    expect(options.minQuality).toBeUndefined()
    expect(options.maxQuality).toBeUndefined()
    expect(options.disabledQuant).toBe(true)
  })

  it('pins the effort settings \u00a77.3 records', () => {
    expect(APNG_DEFLATE_METHOD).toBe(1)
    expect(APNG_DEFLATE_ITERATIONS).toBe(5)
  })
})
