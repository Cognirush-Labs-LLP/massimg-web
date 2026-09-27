// The pure half of the animated paths (Technical Design §4.2's `decode-frames` row; Functional
// Design R-F5, R-Q9, R-Q10). Independent readers for what an animated container *says* about
// itself, plus the PNG byte surgery the animated PNG writer will need.
//
// Kept apart from `animation.ts` for the reason `png-plan.ts` is kept apart from `png.ts`: anything
// that imports `codecs/loader.ts` cannot run under Vitest (T22's note), and everything below is a
// pure transform of bytes.
//
// **These readers are the ground truth the tests assert against, so they deliberately share no code
// with the decoders or the encoders.** A round trip through the library under test only proves the
// library agrees with itself (T26, T27); a container read by hand does not have that problem.
//
// Measured facts this module exists because of (T29):
//
//   - **The three containers do not store the same quantity, and this is the trap the whole module
//     is shaped around.** GIF's NETSCAPE2.0 block stores the number of *additional repeats* after
//     the first play; WebP's `ANIM.loop_count` and APNG's `acTL.num_plays` store the number of
//     *total plays*. Zero means infinite in all three. So a GIF storing 3 plays four times and a
//     WebP storing 3 plays three times, and passing the stored number through unchanged loses a
//     play on GIF → WebP — the drift R-Q9 forbids. The readers below report the **raw stored value**
//     for each container, because they are the byte oracle the tests assert against; `gifTotalPlays`
//     converts GIF's, and `Animation.loops` is **total plays, 0 = infinite** throughout the rest of
//     the pipeline.
//   - **The conversion is not our invention.** libwebp's own `gif2webp` maps a GIF NETSCAPE count of
//     3 to a WebP `loop_count` of 4, 1 to 2, 0 to 0 and an absent block to 1. ImageMagick's
//     `animationIterations` reports the same numbers for the same files (absent 1, 0 → 0, 1 → 2,
//     3 → 4, 10 → 11), and returns an animated WebP's count unchanged. Two independent
//     implementations, one answer; `tests/e2e/animation.spec.ts` asserts ours equals ImageMagick's.
//   - **ImageMagick cannot report a WebP frame delay that is not a whole centisecond.** It exposes
//     `animationDelay` in `animationTicksPerSecond` units and reports 100 ticks for WebP, while the
//     container stores milliseconds directly in a 24-bit `ANMF` field. Measured on stored durations
//     of `[45, 33, 7, 101, 999, 1]` ms, ImageMagick returns `[50, 30, 10, 100, 1000, 0]`. So the
//     delays are read here too, for every container, and `animation.ts` asks ImageMagick for pixels
//     and nothing else.
//   - **ImageMagick's WebP coder reports neither `ICCP` nor `EXIF` for an animated file**, through
//     `readCollection` *or* `read`, although it reports both for a still WebP (orientation 6, a
//     6,668-byte profile). So an animated WebP's profile and orientation are lifted out of the RIFF
//     container here, or they are lost silently.
//   - **APNG `fcTL` delays are rationals with whatever denominator the writer chose.** ffmpeg wrote
//     `1/25`, `3/25`, `1/5` and `2/25` into the committed fixture; UPNG writes `/1000`. A reader
//     that assumes 1000 divides by 1000 where it should divide by 25, so it reads those delays
//     **40x** too small, and a `/5` delay **200x** too small. `delay_den == 0` means 1/100 by the
//     specification, which is a third case again.
//   - **`UPNG` hardcodes `acTL.num_plays` to 0**, so a finite loop count has to be patched into the
//     encoded bytes afterwards. That needs a CRC32, which `png-plan.ts` deliberately does not have
//     — it moves chunks whole precisely to avoid one — so `setApngLoopCount` brings its own.

import { classifySourceOrientation } from './frame'
import type { SourceOrientation } from './frame'

/**
 * Raised when bytes handed to one of these readers are not the container it reads, or are damaged.
 *
 * Deliberately not a `RangeError`: `pipeline/worker.ts` reports any `RangeError` as the machine
 * running out of memory, and a truncated GIF is not that (T23 met exactly this bug). Every read
 * below is bounded so a length field cannot produce one by accident either.
 */
export class AnimationFormatError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'AnimationFormatError'
  }
}

export interface FrameTiming {
  /**
   * Milliseconds. The canonical unit throughout the animated paths, confirmed by UPNG writing
   * `delay_den = 1000`, and the unit `ANMF` already uses.
   */
  delayMs: number
}

/**
 * Whether the container carried a loop record at all. Three states, never a nullable number:
 * "the file says loop forever" (`present`, 0), "the file says loop three times" (`present`, 3) and
 * "the file says nothing" are different facts, and a reader that collapses the last two into a
 * default is the silent misreading this whole module exists to prevent.
 *
 * Only GIF can be `absent`: the NETSCAPE2.0 application extension is optional, and a GIF without
 * one plays through once. An animated WebP always carries `ANIM` and an APNG always carries `acTL`,
 * so for those two "absent" means "not animated" and is an error rather than a default.
 */
export type LoopSignal = { kind: 'absent' } | { kind: 'present'; loops: number }

export interface AnimationInfo {
  width: number
  height: number
  frameCount: number
  /**
   * **The raw value the container stores**, with the meaning that container gives it — *additional
   * repeats* for GIF, *total plays* for WebP and APNG. 0 is infinite in all three.
   *
   * This is deliberately **not** the number the pipeline runs on. These readers are the byte oracle
   * the tests assert against, so they report what is in the file and interpret nothing;
   * `gifTotalPlays` is the one place GIF's convention is converted, and `Animation.loops` is total
   * plays everywhere downstream.
   *
   * Where `loopSignal` is `absent` this is the format's own meaning for a missing record, which for
   * GIF is 1 — played once, which is already a total-plays figure. See `GIF_LOOPS_WHEN_ABSENT`.
   */
  loops: number
  loopSignal: LoopSignal
  frames: FrameTiming[]
}

/**
 * What a GIF with no NETSCAPE2.0 block means: **one total play.**
 *
 * Not zero. Zero is "loop forever" in all three containers, and defaulting a missing record to it
 * would turn every non-looping GIF into an endless one.
 *
 * Note the unit. This is already a *total plays* figure, not an additional-repeats one, which is why
 * `gifTotalPlays` returns it unchanged rather than adding one to it: a blanket `+1` over the absent
 * case would turn "play once" into "play twice".
 */
export const GIF_LOOPS_WHEN_ABSENT = 1

/**
 * A GIF's loop record as **total plays**, which is the unit `Animation.loops` carries and the unit
 * WebP and APNG already store.
 *
 * | NETSCAPE2.0 block | Stored | Total plays |
 * | --- | --- | --- |
 * | absent | — | 1 |
 * | present | 0 | 0, meaning infinite |
 * | present | N > 0 | N + 1 |
 *
 * The `N + 1` is the whole point: the block counts repeats *after* the first play, so a GIF that
 * says 3 is seen four times. Written back into a WebP or an APNG unchanged it would be seen three,
 * which is a change to the image nobody asked for. libwebp's `gif2webp` performs exactly this
 * conversion, and ImageMagick's `animationIterations` reports exactly these numbers.
 *
 * WebP and APNG need no equivalent: their stored value is already total plays.
 */
export function gifTotalPlays(signal: LoopSignal): number {
  if (signal.kind === 'absent') {
    return GIF_LOOPS_WHEN_ABSENT
  }

  return signal.loops === 0 ? 0 : signal.loops + 1
}

/**
 * The largest delay an APNG `fcTL` can express with `delay_den = 1000`, which is what UPNG writes.
 *
 * GIF's own delay field is centiseconds in a `uint16`, so a GIF frame may legally ask for up to
 * 655,350 ms — ten times what an APNG written this way can hold. The writer (T29 Pass B) has to
 * decide what to do about it; this constant is where the number lives so that decision is made
 * against the real limit rather than a remembered one.
 */
export const APNG_MAX_DELAY_MS = 65535

// ---------------------------------------------------------------------------------------------
// Bounded reads. Every one of these is used instead of a `DataView` accessor so that a malformed
// length produces an `AnimationFormatError` naming the offset rather than a `RangeError`.
// ---------------------------------------------------------------------------------------------

function byteAt(bytes: Uint8Array, offset: number, what: string): number {
  const value = bytes[offset]

  if (value === undefined) {
    throw new AnimationFormatError(`${what}: read past the end of the file at ${offset}`)
  }

  return value
}

function uint16LE(bytes: Uint8Array, offset: number, what: string): number {
  return byteAt(bytes, offset, what) | (byteAt(bytes, offset + 1, what) << 8)
}

function uint24LE(bytes: Uint8Array, offset: number, what: string): number {
  return (
    byteAt(bytes, offset, what) |
    (byteAt(bytes, offset + 1, what) << 8) |
    (byteAt(bytes, offset + 2, what) << 16)
  )
}

function uint32LE(bytes: Uint8Array, offset: number, what: string): number {
  return (
    (byteAt(bytes, offset, what) |
      (byteAt(bytes, offset + 1, what) << 8) |
      (byteAt(bytes, offset + 2, what) << 16) |
      (byteAt(bytes, offset + 3, what) << 24)) >>>
    0
  )
}

function uint16BE(bytes: Uint8Array, offset: number, what: string): number {
  return (byteAt(bytes, offset, what) << 8) | byteAt(bytes, offset + 1, what)
}

function uint32BE(bytes: Uint8Array, offset: number, what: string): number {
  return (
    ((byteAt(bytes, offset, what) << 24) |
      (byteAt(bytes, offset + 1, what) << 16) |
      (byteAt(bytes, offset + 2, what) << 8) |
      byteAt(bytes, offset + 3, what)) >>>
    0
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''

  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0)
  }

  return text
}

// ---------------------------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------------------------

const GIF_EXTENSION = 0x21
const GIF_IMAGE_DESCRIPTOR = 0x2c
const GIF_TRAILER = 0x3b
const GIF_GRAPHIC_CONTROL = 0xf9
const GIF_APPLICATION = 0xff

/** A colour table is 3 bytes per entry, 2^(size + 1) entries, where `size` is the low three bits. */
function colourTableBytes(packed: number): number {
  return 3 * (1 << ((packed & 0x07) + 1))
}

/** Walks a sub-block chain, returning the blocks and the offset one past its terminator. */
function readSubBlocks(bytes: Uint8Array, start: number): { blocks: Uint8Array[]; end: number } {
  const blocks: Uint8Array[] = []
  let offset = start

  for (;;) {
    const size = byteAt(bytes, offset, 'GIF sub-block')
    offset += 1

    if (size === 0) {
      return { blocks, end: offset }
    }

    if (offset + size > bytes.length) {
      throw new AnimationFormatError(`GIF sub-block at ${offset} runs past the end of the file`)
    }

    blocks.push(bytes.subarray(offset, offset + size))
    offset += size
  }
}

/**
 * Reads a GIF's frame count, per-frame delays and loop count.
 *
 * Delays come from the Graphic Control Extension that precedes each image descriptor, in
 * centiseconds; a frame with no GCE has no delay and reads as 0, which is what the format means.
 * The loop count comes from the NETSCAPE2.0 application extension, whose absence is a distinct
 * state — see `LoopSignal`.
 *
 * The image data itself is skipped, not decoded: this reader must not need an LZW implementation,
 * because then it would share a failure mode with something.
 */
export function readGifAnimation(bytes: Uint8Array): AnimationInfo {
  const signature = ascii(bytes, 0, 6)

  if (bytes.length < 13 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    throw new AnimationFormatError('not a GIF: signature missing')
  }

  const width = uint16LE(bytes, 6, 'GIF logical screen')
  const height = uint16LE(bytes, 8, 'GIF logical screen')
  const screenPacked = byteAt(bytes, 10, 'GIF logical screen')

  let offset = 13

  if (screenPacked & 0x80) {
    offset += colourTableBytes(screenPacked)
  }

  const frames: FrameTiming[] = []
  let loopSignal: LoopSignal = { kind: 'absent' }
  // The GCE applies to the *next* graphic-rendering block, so it is held and then consumed.
  let pendingDelayMs: number | null = null

  for (;;) {
    const marker = byteAt(bytes, offset, 'GIF block')
    offset += 1

    if (marker === GIF_TRAILER) {
      break
    }

    if (marker === GIF_EXTENSION) {
      const label = byteAt(bytes, offset, 'GIF extension')
      const { blocks, end } = readSubBlocks(bytes, offset + 1)
      offset = end

      const first = blocks[0]

      if (label === GIF_GRAPHIC_CONTROL && first !== undefined && first.length >= 4) {
        pendingDelayMs = uint16LE(first, 1, 'GIF graphic control') * 10
      }

      if (label === GIF_APPLICATION && first !== undefined && first.length >= 11) {
        const identifier = ascii(first, 0, 11)
        const payload = blocks[1]

        // The sub-block is [1, loopLow, loopHigh]; the leading 1 is the block's own index.
        if (identifier === 'NETSCAPE2.0' && payload !== undefined && payload.length >= 3) {
          loopSignal = { kind: 'present', loops: uint16LE(payload, 1, 'GIF loop count') }
        }
      }

      continue
    }

    if (marker === GIF_IMAGE_DESCRIPTOR) {
      frames.push({ delayMs: pendingDelayMs ?? 0 })
      pendingDelayMs = null

      const packed = byteAt(bytes, offset + 8, 'GIF image descriptor')
      offset += 9

      if (packed & 0x80) {
        offset += colourTableBytes(packed)
      }

      // The LZW minimum code size, then the compressed data as a sub-block chain.
      offset = readSubBlocks(bytes, offset + 1).end
      continue
    }

    throw new AnimationFormatError(`GIF block marker ${marker} at ${offset - 1} is not known`)
  }

  if (frames.length === 0) {
    throw new AnimationFormatError('GIF carries no image descriptors')
  }

  return {
    width,
    height,
    frameCount: frames.length,
    loops: loopSignal.kind === 'present' ? loopSignal.loops : GIF_LOOPS_WHEN_ABSENT,
    loopSignal,
    frames,
  }
}

// ---------------------------------------------------------------------------------------------
// WebP (RIFF)
// ---------------------------------------------------------------------------------------------

/** `VP8X`'s first byte: bit 1 is the animation flag. Bits 5, 4, 3 and 2 are ICC, alpha, EXIF, XMP. */
const VP8X_ANIMATION_FLAG = 0x02

interface RiffChunk {
  fourcc: string
  payload: number
  length: number
}

/**
 * Walks a WebP's RIFF chunks. Chunk payloads are padded to an even length, and the pad byte is not
 * counted in the size field — a walker that forgets it desynchronises on the first odd-sized chunk
 * and reads garbage fourccs from then on.
 */
function readRiffChunks(bytes: Uint8Array): RiffChunk[] {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new AnimationFormatError('not a WebP: RIFF/WEBP header missing')
  }

  // The RIFF size covers everything after the size field itself, so the file may legitimately be
  // longer (trailing bytes) but never shorter.
  const riffEnd = Math.min(bytes.length, 8 + uint32LE(bytes, 4, 'RIFF size'))
  const chunks: RiffChunk[] = []
  let offset = 12

  while (offset + 8 <= riffEnd) {
    const fourcc = ascii(bytes, offset, 4)
    const length = uint32LE(bytes, offset + 4, 'RIFF chunk size')

    if (offset + 8 + length > riffEnd) {
      throw new AnimationFormatError(
        `WebP chunk ${fourcc} at ${offset} claims ${length} bytes, past the end of the file`,
      )
    }

    chunks.push({ fourcc, payload: offset + 8, length })
    offset += 8 + length + (length % 2)
  }

  return chunks
}

/**
 * Reads an animated WebP's canvas size, frame count, per-frame durations and loop count.
 *
 * `ANMF` durations are already milliseconds, so nothing is converted. A still WebP — no `ANIM`
 * chunk — is an error rather than a one-frame animation: `domain/classify.ts` is what decides
 * whether a file is animated, and a reader that quietly answered "one frame, loops once" would let
 * a still file through the animated path.
 */
export function readWebpAnimation(bytes: Uint8Array): AnimationInfo {
  const chunks = readRiffChunks(bytes)
  const vp8x = chunks.find((chunk) => chunk.fourcc === 'VP8X')

  if (vp8x === undefined || vp8x.length < 10) {
    throw new AnimationFormatError('WebP carries no VP8X chunk, so it is not animated')
  }

  const flags = byteAt(bytes, vp8x.payload, 'WebP VP8X')

  if ((flags & VP8X_ANIMATION_FLAG) === 0) {
    throw new AnimationFormatError('WebP VP8X does not set the animation flag')
  }

  // Canvas dimensions are stored minus one, in three little-endian bytes each.
  const width = uint24LE(bytes, vp8x.payload + 4, 'WebP VP8X') + 1
  const height = uint24LE(bytes, vp8x.payload + 7, 'WebP VP8X') + 1

  const anim = chunks.find((chunk) => chunk.fourcc === 'ANIM')

  if (anim === undefined || anim.length < 6) {
    throw new AnimationFormatError('WebP carries no ANIM chunk')
  }

  // 4 bytes of background colour, then the loop count.
  const loops = uint16LE(bytes, anim.payload + 4, 'WebP ANIM')

  const frames: FrameTiming[] = chunks
    .filter((chunk) => chunk.fourcc === 'ANMF')
    .map((chunk) => {
      if (chunk.length < 16) {
        throw new AnimationFormatError('WebP ANMF chunk is too short to carry a duration')
      }

      // x, y, width-1, height-1 are three bytes each; the duration follows, also three bytes.
      return { delayMs: uint24LE(bytes, chunk.payload + 12, 'WebP ANMF') }
    })

  if (frames.length === 0) {
    throw new AnimationFormatError('WebP carries no ANMF frames')
  }

  return {
    width,
    height,
    frameCount: frames.length,
    loops,
    loopSignal: { kind: 'present', loops },
    frames,
  }
}

/**
 * The ICC profile out of a WebP's `ICCP` chunk, copied. `null` when the file carries none.
 *
 * This exists because ImageMagick's WebP coder reports no profile at all for an animated file —
 * measured, T29 — so without it every profiled animated WebP would decode as untagged sRGB, which
 * is the silent colour shift §7.7 is written to prevent.
 */
export function readWebpIccProfile(bytes: Uint8Array): Uint8Array | null {
  const iccp = readRiffChunks(bytes).find((chunk) => chunk.fourcc === 'ICCP')

  return iccp === undefined ? null : bytes.slice(iccp.payload, iccp.payload + iccp.length)
}

/**
 * The EXIF orientation of a WebP, as the same three-state answer `decode.ts` produces.
 *
 * `absent` covers three different files — no `EXIF` chunk, an `EXIF` chunk with no IFD0 orientation
 * entry, and an entry whose value is outside 1-8 — because for the pixels they all mean the same
 * thing, and none of them is "the tag says upright". A tag that *says* 1 comes back as
 * `present` with value 1, which is a different state again and is reported as one.
 *
 * WebP's `EXIF` chunk holds the raw TIFF stream. It does **not** carry JPEG's "Exif\0\0" prefix,
 * which is a difference a reader written from the JPEG case gets wrong by six bytes.
 */
export function readWebpOrientation(bytes: Uint8Array): SourceOrientation {
  const exif = readRiffChunks(bytes).find((chunk) => chunk.fourcc === 'EXIF')

  if (exif === undefined) {
    return { kind: 'absent' }
  }

  return readTiffOrientation(bytes.subarray(exif.payload, exif.payload + exif.length))
}

/** Tag 0x0112, Orientation, in IFD0. Nothing else in the TIFF stream is looked at. */
const TIFF_ORIENTATION_TAG = 0x0112
/** Stop condition for a file that is malformed or hostile rather than merely unusual. */
const TIFF_MAX_ENTRIES = 512

function readTiffOrientation(tiff: Uint8Array): SourceOrientation {
  if (tiff.length < 8) {
    return { kind: 'absent' }
  }

  const byteOrder = ascii(tiff, 0, 2)

  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    return { kind: 'absent' }
  }

  const little = byteOrder === 'II'
  const u16 = (offset: number): number =>
    little ? uint16LE(tiff, offset, 'TIFF') : uint16BE(tiff, offset, 'TIFF')
  const u32 = (offset: number): number =>
    little ? uint32LE(tiff, offset, 'TIFF') : uint32BE(tiff, offset, 'TIFF')

  try {
    if (u16(2) !== 42) {
      return { kind: 'absent' }
    }

    const ifd0 = u32(4)

    if (ifd0 + 2 > tiff.length) {
      return { kind: 'absent' }
    }

    const count = Math.min(u16(ifd0), TIFF_MAX_ENTRIES)

    for (let index = 0; index < count; index += 1) {
      const entry = ifd0 + 2 + index * 12

      if (entry + 12 > tiff.length) {
        return { kind: 'absent' }
      }

      if (u16(entry) === TIFF_ORIENTATION_TAG) {
        // Type 3 (SHORT), count 1: the value sits in the first two bytes of the value field, which
        // is four bytes wide whichever end of it the value occupies.
        return classifySourceOrientation(u16(entry + 8))
      }
    }
  } catch {
    // A truncated or nonsensical TIFF says nothing about orientation. It is not a reason to fail
    // the whole decode, and it is emphatically not evidence that the image is upright.
    return { kind: 'absent' }
  }

  return { kind: 'absent' }
}

// ---------------------------------------------------------------------------------------------
// APNG
// ---------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

interface PngChunkSpan {
  type: string
  /** Offset of the chunk's length field. */
  at: number
  length: number
}

/**
 * Walks a PNG's chunks.
 *
 * `png-plan.ts` has a walk of its own and this is deliberately not it: that one is the still PNG
 * path's, its `KEPT_CHUNKS` whitelist has no `acTL`, `fcTL` or `fdAT` in it (T27's note warns that
 * an APNG put through `rewritePngChunks` comes out a still image), and the two modules must be able
 * to change independently. The duplication is eleven lines and buys that independence.
 */
function readPngChunkSpans(png: Uint8Array): PngChunkSpan[] {
  if (png.length < 8 || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) {
    throw new AnimationFormatError('not a PNG: signature missing')
  }

  const chunks: PngChunkSpan[] = []
  let at = 8

  while (at + 8 <= png.length) {
    const length = uint32BE(png, at, 'PNG chunk')

    if (length > png.length - at - 12) {
      throw new AnimationFormatError(`PNG chunk at ${at} claims ${length} bytes, past the end`)
    }

    const type = ascii(png, at + 4, 4)
    chunks.push({ type, at, length })
    at += 12 + length

    if (type === 'IEND') {
      return chunks
    }
  }

  throw new AnimationFormatError('PNG ended without an IEND chunk')
}

/**
 * Converts an `fcTL` delay to milliseconds.
 *
 * `delay_den == 0` means 1/100 of a second by the APNG specification — a third state beside "a
 * denominator of 1000" and "some other denominator", and the one a reader is most likely to divide
 * by and get infinity.
 *
 * **The conversion rounds and can lose time.** A denominator that does not divide 1000 — ffmpeg
 * writes 25 and 5, both of which do; a 3 would not — produces a fractional millisecond, and
 * milliseconds are the pipeline's canonical unit because that is what UPNG and `ANMF` both use.
 * `Math.round` is the least-distorting choice: nearest, so the error is at most half a millisecond
 * per frame and does not accumulate in one direction the way a floor would.
 */
function apngDelayMs(delayNum: number, delayDen: number): number {
  return Math.round((delayNum * 1000) / (delayDen === 0 ? 100 : delayDen))
}

/**
 * Reads an APNG's frame count, per-frame delays and loop count.
 *
 * `acTL.num_frames` is what the file claims; the `fcTL` chunks are what it contains. Both are
 * reported — `frameCount` is the number of `fcTL` chunks, because that is the number of frames a
 * decoder will produce — and a disagreement between them is an error rather than a silent
 * preference for one, since either could be the damaged half.
 */
export function readApngAnimation(bytes: Uint8Array): AnimationInfo {
  const chunks = readPngChunkSpans(bytes)
  const header = chunks[0]

  if (header === undefined || header.type !== 'IHDR' || header.length !== 13) {
    throw new AnimationFormatError('PNG does not start with a 13-byte IHDR')
  }

  const width = uint32BE(bytes, header.at + 8, 'PNG IHDR')
  const height = uint32BE(bytes, header.at + 12, 'PNG IHDR')

  const actl = chunks.find((chunk) => chunk.type === 'acTL')

  if (actl === undefined || actl.length !== 8) {
    throw new AnimationFormatError('PNG carries no acTL chunk, so it is not an APNG')
  }

  const declaredFrames = uint32BE(bytes, actl.at + 8, 'PNG acTL')
  const loops = uint32BE(bytes, actl.at + 12, 'PNG acTL')

  const frames: FrameTiming[] = chunks
    .filter((chunk) => chunk.type === 'fcTL')
    .map((chunk) => {
      if (chunk.length !== 26) {
        throw new AnimationFormatError(`PNG fcTL at ${chunk.at} is ${chunk.length} bytes, not 26`)
      }

      return {
        delayMs: apngDelayMs(
          uint16BE(bytes, chunk.at + 8 + 20, 'PNG fcTL'),
          uint16BE(bytes, chunk.at + 8 + 22, 'PNG fcTL'),
        ),
      }
    })

  if (frames.length === 0) {
    throw new AnimationFormatError('APNG carries no fcTL chunks')
  }

  if (frames.length !== declaredFrames) {
    throw new AnimationFormatError(
      `APNG acTL declares ${declaredFrames} frames but the file carries ${frames.length} fcTL chunks`,
    )
  }

  return {
    width,
    height,
    frameCount: frames.length,
    loops,
    loopSignal: { kind: 'present', loops },
    frames,
  }
}

// ---------------------------------------------------------------------------------------------
// CRC32 and the acTL patch
// ---------------------------------------------------------------------------------------------

/**
 * The PNG CRC-32 table: the reflected polynomial `0xEDB88320`, which is the standard CRC-32 every
 * PNG chunk carries. Built once, lazily, so importing this module costs nothing.
 */
let crcTable: Int32Array | null = null

function crcTableOnce(): Int32Array {
  if (crcTable === null) {
    const table = new Int32Array(256)

    for (let n = 0; n < 256; n += 1) {
      let c = n

      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }

      table[n] = c
    }

    crcTable = table
  }

  return crcTable
}

/**
 * The CRC-32 of a byte range, as an unsigned 32-bit number.
 *
 * `png-plan.ts` has no CRC32 and should not gain one: it moves chunks whole precisely so that no
 * CRC is ever recomputed and none can be wrong (T27). This one exists for the single case where a
 * chunk's *contents* must change — UPNG hardcodes `acTL.num_plays` to 0, so a finite loop count can
 * only be written by editing the encoded bytes.
 */
export function crc32(bytes: Uint8Array): number {
  const table = crcTable ?? crcTableOnce()
  let c = 0xffffffff

  for (let index = 0; index < bytes.length; index += 1) {
    c = table[(c ^ (bytes[index] as number)) & 0xff]! ^ (c >>> 8)
  }

  return (c ^ 0xffffffff) >>> 0
}

/** `acTL.num_plays` is a `uint32`, and 0 means infinite. */
const MAX_LOOP_COUNT = 0xffffffff

/**
 * Rewrites an APNG's `acTL.num_plays` and recomputes that chunk's CRC.
 *
 * UPNG writes 0 — infinite — whatever it is asked for, so this is the only way a finite loop count
 * reaches an APNG this pipeline produces. Nothing else in the file is touched: the result is a copy
 * with exactly four bytes and one CRC different, so every other chunk keeps the CRC its writer
 * computed.
 *
 * The result owns its buffer, so `pipeline/worker.ts` may transfer it.
 */
export function setApngLoopCount(png: Uint8Array, loops: number): Uint8Array {
  if (!Number.isInteger(loops) || loops < 0 || loops > MAX_LOOP_COUNT) {
    throw new AnimationFormatError(
      `APNG loop count must be a whole number from 0 to ${MAX_LOOP_COUNT}`,
    )
  }

  const actl = readPngChunkSpans(png).find((chunk) => chunk.type === 'acTL')

  if (actl === undefined || actl.length !== 8) {
    throw new AnimationFormatError('cannot set a loop count: the PNG carries no 8-byte acTL chunk')
  }

  const out = png.slice()
  // The data field starts after the 4-byte length and the 4-byte type; `num_plays` is its second
  // uint32, after `num_frames`.
  const data = actl.at + 8

  out[data + 4] = (loops >>> 24) & 0xff
  out[data + 5] = (loops >>> 16) & 0xff
  out[data + 6] = (loops >>> 8) & 0xff
  out[data + 7] = loops & 0xff

  // The CRC covers the chunk type and its data, never the length field.
  const crc = crc32(out.subarray(actl.at + 4, data + 8))

  out[data + 8] = (crc >>> 24) & 0xff
  out[data + 9] = (crc >>> 16) & 0xff
  out[data + 10] = (crc >>> 8) & 0xff
  out[data + 11] = crc & 0xff

  return out
}

// ---------------------------------------------------------------------------------------------
// The writer's byte surgery.
//
// Three things the encoders cannot express and this module patches into their output afterwards.
// Each one exists because of a measurement, and each is named here so the encoder modules stay
// short and the reasons stay in one place.
// ---------------------------------------------------------------------------------------------

/**
 * The shortest frame delay ImageMagick's WebP writer will emit, in milliseconds.
 *
 * Measured by sweeping a two-frame animation with `animationTicksPerSecond` at 1000: 0, 1, 5 and 9
 * ms all come out as **100 ms**, while 10, 11, 15, 20, 25 and 30 come out exactly. It is the
 * familiar browser-compatibility clamp — a very short delay is treated as "unset" and replaced with
 * a tenth of a second — applied at write time, where it silently changes the animation.
 *
 * libwebp itself has no such limit: `img2webp -d 1` writes a 1 ms duration, and
 * `tests/fixtures/animated/anim-odd-delays.webp` contains one. So the fix is to write through
 * ImageMagick and then put the real durations back with `setWebpFrameDurations`.
 */
export const WEBP_MIN_DELAY_MS = 10

/**
 * Rewrites every `ANMF` frame duration in an animated WebP.
 *
 * RIFF carries no checksums, and the duration is a fixed-width 24-bit little-endian field at a fixed
 * offset inside each `ANMF` payload, so this is four bytes per frame changed and nothing else
 * touched — the same shape as `setApngLoopCount`, without the CRC.
 *
 * The result owns its buffer, so `pipeline/worker.ts` may transfer it.
 */
export function setWebpFrameDurations(webp: Uint8Array, delaysMs: number[]): Uint8Array {
  const frames = readRiffChunks(webp).filter((chunk) => chunk.fourcc === 'ANMF')

  if (frames.length !== delaysMs.length) {
    throw new AnimationFormatError(
      `WebP holds ${frames.length} frames but ${delaysMs.length} delays were given`,
    )
  }

  const out = webp.slice()

  frames.forEach((chunk, index) => {
    const delay = delaysMs[index] as number

    if (!Number.isInteger(delay) || delay < 0 || delay > 0xffffff) {
      throw new AnimationFormatError(
        `WebP frame duration must be a whole number of 0 to 16777215 ms`,
      )
    }

    // x, y, width-1 and height-1 occupy the first twelve bytes; the duration is the next three.
    const at = chunk.payload + 12

    out[at] = delay & 0xff
    out[at + 1] = (delay >>> 8) & 0xff
    out[at + 2] = (delay >>> 16) & 0xff
  })

  return out
}

/**
 * An exact `delay_num` / `delay_den` for a delay in milliseconds, or `null` when the APNG format
 * cannot express it exactly.
 *
 * Both fields are `uint16`, so `ms / 1000` is reduced to its lowest terms and the result is usable
 * only if both halves fit. UPNG always writes `delay_num = ms, delay_den = 1000`, which is correct
 * and exact **until `ms` passes 65535**, where the field wraps silently — 65,536 ms would be written
 * as 0. A GIF may legally ask for up to 655,350 ms (its own field is centiseconds in a `uint16`),
 * so this is reachable from a real file rather than only from a hostile one.
 *
 * Reducing the fraction is what makes those reachable cases exact rather than approximate: 65,536 ms
 * is 8192/125 of a second, and both of those fit. Every GIF delay is a multiple of 10 ms and
 * therefore always reduces to something expressible. `null` is reserved for delays no honest
 * arithmetic can carry — a single frame lasting more than about eighteen minutes with a duration
 * that is not a round number.
 */
export function apngDelayFraction(delayMs: number): { num: number; den: number } | null {
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new AnimationFormatError(
      `frame delay must be a whole number of milliseconds, got ${delayMs}`,
    )
  }

  if (delayMs <= APNG_MAX_DELAY_MS) {
    return { num: delayMs, den: 1000 }
  }

  const divisor = greatestCommonDivisor(delayMs, 1000)
  const num = delayMs / divisor
  const den = 1000 / divisor

  return num <= 0xffff && den <= 0xffff ? { num, den } : null
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = a
  let y = b

  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }

  return x
}

/**
 * Rewrites every `fcTL` delay in an APNG and recomputes those chunks' CRCs.
 *
 * Only needed when a delay overflows UPNG's `uint16` of milliseconds; below that UPNG's own output
 * is already exact and this would rewrite it to the identical bytes. `encodeApng` checks before it
 * calls, so the common animation pays nothing.
 *
 * A delay the format cannot express exactly is an error rather than a clamp. Clamping would change
 * how long a frame is on screen without saying so, which is precisely the silent change P1 forbids,
 * and R-X46's caveat set is closed — there is no caveat for "a frame delay was shortened", so there
 * is no honest way to do it quietly.
 */
export function setApngFrameDelays(png: Uint8Array, delaysMs: number[]): Uint8Array {
  const frames = readPngChunkSpans(png).filter((chunk) => chunk.type === 'fcTL')

  if (frames.length !== delaysMs.length) {
    throw new AnimationFormatError(
      `APNG holds ${frames.length} fcTL chunks but ${delaysMs.length} delays were given`,
    )
  }

  const out = png.slice()

  frames.forEach((chunk, index) => {
    const delayMs = delaysMs[index] as number
    const fraction = apngDelayFraction(delayMs)

    if (fraction === null) {
      throw new AnimationFormatError(
        `an APNG frame cannot express a delay of ${delayMs} ms exactly (fcTL holds two uint16s)`,
      )
    }

    // The data field starts after the length and the type; delay_num is its 21st and 22nd bytes.
    const data = chunk.at + 8

    out[data + 20] = (fraction.num >>> 8) & 0xff
    out[data + 21] = fraction.num & 0xff
    out[data + 22] = (fraction.den >>> 8) & 0xff
    out[data + 23] = fraction.den & 0xff

    const crc = crc32(out.subarray(chunk.at + 4, data + chunk.length))

    out[data + chunk.length] = (crc >>> 24) & 0xff
    out[data + chunk.length + 1] = (crc >>> 16) & 0xff
    out[data + chunk.length + 2] = (crc >>> 8) & 0xff
    out[data + chunk.length + 3] = crc & 0xff
  })

  return out
}

/** Chunks an APNG this pipeline writes must never carry out (R-I17, §7.7). */
const APNG_DROPPED_CHUNKS: ReadonlySet<string> = new Set([
  // A second, disagreeing description of the colour beside an `iCCP` (T23: the two are mutually
  // exclusive in the PNG specification). UPNG writes `sRGB` unconditionally.
  'sRGB',
  'cHRM',
  'gAMA',
  // R-I17: metadata the user did not ask to publish.
  'eXIf',
  'tEXt',
  'zTXt',
  'iTXt',
  'tIME',
])

/**
 * Attaches an `iCCP` chunk to a finished APNG, dropping anything that would contradict it.
 *
 * **`png-plan.ts`'s `rewritePngChunks` cannot be used here** and T27's note says why: its whitelist
 * is `IHDR PLTE tRNS IDAT IEND`, so an APNG put through it comes out a still image with its `acTL`,
 * `fcTL` and `fdAT` chunks gone. This keeps everything except the short drop list above, which is
 * the opposite default and the right one for a container whose chunk vocabulary is still growing.
 *
 * Chunks are moved **whole** — length, type, data and CRC together — so no CRC is recomputed and
 * none can be wrong. `chunk` is `null` for an untagged animation, which then only has its
 * contradicting chunks removed.
 *
 * **This runs after apng-optimizer, not before** (D3, confirmed in T29): the optimiser strips a
 * valid `iCCP` from the APNG it is given, so a profile attached first is simply lost.
 */
export function attachApngIccp(png: Uint8Array, chunk: Uint8Array | null): Uint8Array {
  const chunks = readPngChunkSpans(png)
  const first = chunks[0]

  if (first === undefined || first.type !== 'IHDR') {
    throw new AnimationFormatError('APNG does not start with IHDR')
  }

  const pieces: Uint8Array[] = [png.subarray(0, 8)]

  for (const span of chunks) {
    if (APNG_DROPPED_CHUNKS.has(span.type) || span.type === 'iCCP') {
      continue
    }

    pieces.push(png.subarray(span.at, span.at + 12 + span.length))

    // The PNG specification puts `iCCP` before `PLTE` and before the first `IDAT`.
    if (span.type === 'IHDR' && chunk !== null) {
      pieces.push(chunk)
    }
  }

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0

  for (const piece of pieces) {
    merged.set(piece, offset)
    offset += piece.length
  }

  return merged
}

/**
 * §7.3's missing row, measured in T29 rather than guessed: apng-optimizer's deflate method.
 *
 * `1` is the library default (7zip). It is kept, and the measurement is close enough that the choice
 * deserves its numbers. On an 8-frame 200x200 photographic APNG and on a 16-frame 400x400 flat one:
 *
 *   | deflateMethod | photographic | flat 16-frame |
 *   | 0 (zlib)      | 44,820 B in    175 ms | 10,459 B in    195 ms |
 *   | 1 (7zip)      | 42,411 B in    821 ms | 11,038 B in  1,962 ms |
 *   | 2 (zopfli)    | 41,088 B in 11,696 ms |  9,927 B in 49,162 ms |
 *
 * **Method 2 is out on time alone**: 14x method 1 on the small subject and 25x on the larger one,
 * for 3.1% and 10.1% of size — and 49 seconds for one 16-frame animation is not a trade this
 * application can make, least of all twice per image (R-Q14 runs two candidates). §7.3's "no codec
 * runs at maximum effort" decides it without needing the size argument.
 *
 * **Method 0 against method 1 is genuinely close and points both ways**: method 1 is 5.4% smaller on
 * the photograph and 5.5% *larger* on the flat animation, while being 4x to 10x slower on both. Two
 * subjects cannot settle that, so the library default stays — but if the two-candidate structure
 * proves too slow in a real batch, method 0 is the lever to pull and it costs single-digit percent.
 */
export const APNG_DEFLATE_METHOD = 1

/**
 * §7.3's missing row, part two: apng-optimizer's deflate iteration count. The library default is 15.
 *
 * Measured on the same photographic APNG: 1 iteration gives 42,660 B in 343 ms, 3 gives 42,417 in
 * 580, **5 gives 42,412 in 619**, 10 gives 42,401 in 719, 15 gives 42,411 in 813 and 30 gives
 * 42,401 in 1,105. Everything from 3 upward is within 16 bytes of everything else — 0.04% — and 15
 * is not even the smallest of them. The flat 16-frame subject agrees: 1 gives 11,084 B, and 5 and 15
 * give the identical 11,038.
 *
 * So 5: past the knee, a quarter of the default's time on the larger subject, and not maximum
 * effort. This is the same shape of decision §7.3 records for oxipng level 2.
 */
export const APNG_DEFLATE_ITERATIONS = 5

export interface ApngOptimizerOptions {
  deflateMethod: number
  iter: number
  disabledQuant?: boolean
  minQuality?: number
  maxQuality?: number
}

/**
 * What apng-optimizer is asked for (§7.3). **The quantizer is always off.**
 *
 * There is no quantized branch for animated PNG and no quality parameter, because the one this
 * library exposes does not work. libimagequant's own API refuses to produce anything when it cannot
 * reach its `minimum`, and that refusal is exactly what makes R-Q11's floor a guarantee by
 * construction on the still path (T27, D8). apng-optimizer wraps the same library but exposes no
 * refusal: measured on an 8-frame photographic APNG, `minQuality` of 50, 70, 90, 99 and 100 all
 * returned the *same* 101,349-byte file with no palette at all, and `minQuality: 10` returned a
 * 256-colour file of 236,609 bytes against the lossless 42,411. Nothing threw, and nothing reported
 * that the request had not been met.
 *
 * A quantized candidate would therefore be quantized to an unknown quality at every slider position,
 * with no floor and no way to detect its absence — the precise outcome R-Q11 exists to prevent.
 * `encodeApng` writes losslessly instead. Decided with the user in T29; see that note, and §7.6.
 *
 * R-Q11 and R-Q12 are unaffected on the **still** PNG path, where the abort is real.
 */
export function apngOptimizerOptions(): ApngOptimizerOptions {
  return {
    deflateMethod: APNG_DEFLATE_METHOD,
    iter: APNG_DEFLATE_ITERATIONS,
    disabledQuant: true,
  }
}
