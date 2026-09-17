// The pure half of the still PNG path (Technical Design §4.2's PNG-still row, §7.3, §7.4, §7.6;
// Functional Design R-Q11, R-Q12, R-Q13, R-Q14, R-I12, R-I14, R-I17). What `png.ts` asks
// libimagequant and oxipng for, and the byte surgery on the PNG they produce, decided without either.
//
// Kept apart from `png.ts` for the reason `encode-plan.ts` is kept apart from `encode.ts`: anything
// that imports `codecs/loader.ts` cannot run under Vitest (T22's note), and every rule below is a
// table or a pure transform of bytes.
//
// Measured facts this module encodes (T27; see docs/task-notes/T27.md and
// `verification/t27-png/results.json`):
//
//   - **libimagequant's floor is an abort, not a clamp.** `set_quality(minimum, target)` is
//     pngquant's `--quality min-max`: if the quantized image cannot reach `minimum`, the call throws
//     `QUALITY_TOO_LOW` and produces nothing. R-Q11's mapped value is that `minimum`, so the 70 floor
//     is a guarantee by construction — an image that would band aborts and the job keeps its lossless
//     PNG instead.
//   - **`target` is 100, measured, not argued.** Asking for fewer colours does not reliably mean
//     smaller, because libimagequant dithers harder to compensate: a 1000x750 grey ramp at
//     `target: 70` came out at 46,628 bytes and SSIM 0.9365, against 2,231 bytes and 1.0000 at
//     `target: 100` — 20.9x larger *and* further from the source. Across the whole sweep the two
//     settings trade size (see `QUANTIZER_TARGET_QUALITY`) and `target: 100` wins on fidelity. The
//     slider still does work: it sets `minimum`, and therefore which images are quantized at all.
//   - **ImageMagick's PNG writer adds metadata of its own.** Every PNG it writes carries `cHRM`,
//     `tIME` and three `tEXt` chunks (`date:create`, `date:modify`, `date:timestamp`), and a profiled
//     one carries the profile a *second* time as a `zTXt` "Raw profile type icc" — 3,441 bytes
//     against the 2,381-byte `iCCP` on a test image whose pixel data was 95 bytes. `png:exclude-chunk`
//     and `image.strip()` both remove the `iCCP` along with them, so neither can be used to keep the
//     profile. `rewritePngChunks` below is what strips them, which also makes R-I17 structural for
//     PNG rather than a define's promise. (The byte figures are from a spike; `png.spec.ts` guards
//     the claim itself, by writing the same frame unstripped and asserting the chunks are there.)
//   - **libimagequant writes a bare PNG**: `IHDR`, `PLTE`, `tRNS` when it needs one, `IDAT`, `IEND`.
//     No `iCCP`, and — usefully — no `sRGB` or `gAMA` either, which are the chunks that would
//     contradict a spliced-in profile (T23: `sRGB` and `iCCP` are mutually exclusive in the PNG
//     specification).
//   - **The splice may go on either side of oxipng.** Measured byte-identical both ways, profile
//     exact both ways. It happens before, so that oxipng sees and emits the final chunk set.

import type { Caveat } from '@/domain/types'
import type { QualitySettings } from './encode-plan'

/** Which of the two PNG candidates produced a file. */
export type PngBranch = 'lossless' | 'quantized'

/**
 * §7.3: oxipng optimisation level, 2 rather than 6.
 *
 * Measured (`verification/t27-png/results.json`, `effort.oxipngLevels`) on a 1000x750 photographic
 * PNG with its metadata already stripped, 631,590 bytes in:
 *
 *   level 0  631,362 B in   120 ms
 *   level 1  590,281 B in   455 ms
 *   level 2  590,049 B in   802 ms   <- shipped
 *   level 3  590,049 B in 2,118 ms
 *   level 4  590,049 B in 2,231 ms
 *   level 6  590,049 B in 5,173 ms
 *
 * Levels 3, 4 and 6 return the identical file for up to 6.5x level 2's time. One subject, so the
 * flatness above 2 is not established in general — but nothing above 2 paid for itself here.
 */
export const OXIPNG_LEVEL = 2

/**
 * §7.3: libimagequant's `speed`. 1 is *maximum* effort here and 10 the least; the library default is
 * 4. Measured over ten generated PNGs and fourteen real files (`verification/t27-png/results.json`):
 *
 *   - **Speeds 1 to 6 differ little in either output or cost.** Of the ten generated images, one
 *     aborts at every speed and six of the remaining nine produce the *same size* at all six speeds;
 *     three differ, and never by more than 168 bytes. (Size, not content: the harness records
 *     lengths, so "identical" here is not a byte comparison.) Time across speeds 2 to 6 varies by at
 *     most 25 ms per image; speed 1 is the only outlier, up to 87 ms slower on one image.
 *   - **Speeds 8 and 10 are 1.25x to 2.26x faster and do change the output**, on seven of the nine:
 *     a grey ramp went from 2,231 bytes at SSIM 1.0000 to 2,356 at 0.9980 and a line diagram from
 *     4,216 bytes on 47 colours to 4,968 on 180, while a gradient got *smaller* (27,147 to 22,423)
 *     for 0.0005 of SSIM. Faster is not uniformly worse — it is uniformly less predictable.
 *   - **The achievable quality is what decides between 3 and the default.** The highest `minimum`
 *     the quantizer can meet was identical at speeds 1 and 3 on all 24 images, and one point lower
 *     at speed 4 on three of them — the same three real photographs on all three engines (91 against
 *     92 twice, 79 against 80 once). It is never higher at speed 4. Since that number is exactly
 *     what R-Q11's floor is compared against, a lower ceiling means a few more images abort to
 *     lossless for no reason.
 *
 * So 3: not maximum effort, which §7.3 forbids and which buys nothing here, and not the library
 * default either, which costs the same and reaches slightly less.
 */
export const QUANTIZER_SPEED = 3

/**
 * libimagequant's `target` (pngquant's `--quality` maximum): the quality at which it stops spending
 * colours. Left at 100 so it spends what the image needs.
 *
 * Measured against the alternative — `target` set to the mapped value, which is what would make the
 * slider change how hard the image is quantized rather than only whether it is. Of 40 image and
 * slider combinations, four abort under both settings and **36 are comparable: `target: mapped` is
 * smaller on 16, larger on 12, and the identical size on 8.** So on size it is ahead more often than
 * not. It loses on fidelity — mean SSIM 0.9378 against 0.9543 — and it loses worst exactly where
 * banding is visible, because asking for fewer colours makes libimagequant dither harder to
 * compensate: a grey ramp at slider 10 came out at 46,628 bytes and SSIM 0.9365 against 2,231 bytes
 * and 1.0000 (20.9x larger), and a shaded illustration at 55,336 bytes and 0.9174 against 32,123 and
 * 0.9995 — larger *and* further from the source, both times. Where it wins on size it still pays:
 * a screenshot at 27,840 bytes and SSIM 0.9910 against 37,765 at 1.0000.
 *
 * The consequence, stated plainly because it is user-visible: below slider 85 the slider changes
 * which images are quantized, not how hard. It moves `minimum`, so raising it makes more images
 * abort to lossless (14 of 24 images kept a quantized file at slider 10, 10 of 24 at slider 84).
 */
export const QUANTIZER_TARGET_QUALITY = 100

/**
 * The message libimagequant raises when it could not reach `minimum`. Compared as a substring rather
 * than an equality so a wrapper that decorates the message still matches.
 *
 * A dev server that pre-bundles `imagequant` serves two copies of its wasm-bindgen glue and this
 * message is unreadable — see the `optimizeDeps.exclude` comment in `vite.config.ts`.
 */
export const QUANTIZER_ABORT_MESSAGE = 'QUALITY_TOO_LOW'

/** The eight-byte PNG signature. */
export const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The chunks a PNG this pipeline writes is allowed to carry.
 *
 * Everything else is dropped: `cHRM`, `gAMA` and `sRGB` because a frame's colour is described by its
 * profile or by nothing at all (R-I14, R-I15) and a second, disagreeing description is how two
 * readers come to disagree; `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME` because R-I17 strips metadata
 * and because ImageMagick's are timestamps the user did not ask to publish.
 *
 * `iCCP` is handled separately by `IccpPlan`, so it is deliberately not in this set.
 */
const KEPT_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])

/** Raised when the bytes handed to a chunk walk are not a PNG this module can read. */
export class PngFormatError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'PngFormatError'
  }
}

/**
 * What happens to the output's `iCCP` chunk. Three states, never a nullable chunk: "carry whatever
 * the encoder wrote", "attach exactly this chunk" and "there is no profile" are three different
 * instructions, and collapsing the first and the third is how an untagged output quietly acquires a
 * profile — or a profiled one quietly loses it.
 */
export type IccpPlan =
  /** The encoder wrote the profile itself (ImageMagick does, D3). Keep its chunk as it stands. */
  | { kind: 'keep' }
  /** Replace or insert this exact chunk. Used for libimagequant's output, which carries none. */
  | { kind: 'attach'; chunk: Uint8Array }
  /** The frame is untagged (R-I14): no profile is added, and any the encoder invented is removed. */
  | { kind: 'drop' }

export interface PngChunk {
  type: string
  /** Offset of the chunk's length field. */
  at: number
  /** Length of the chunk's data, excluding the 12 bytes of length, type and CRC. */
  length: number
}

function isPngSignature(png: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => png[index] === byte)
}

/**
 * Walks a PNG's chunks. Every read is bounded: a length field that would run past the end of the
 * buffer is a format error rather than a `RangeError` from a `DataView`, because `pipeline/worker.ts`
 * reports any `RangeError` as the machine running out of memory (T23 met exactly this bug).
 */
export function readPngChunks(png: Uint8Array): PngChunk[] {
  if (png.length < 8 || !isPngSignature(png)) {
    throw new PngFormatError('not a PNG: signature missing')
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: PngChunk[] = []
  let at = 8

  while (at + 8 <= png.length) {
    const length = view.getUint32(at)

    if (length > png.length - at - 12) {
      throw new PngFormatError(`chunk at ${at} claims ${length} bytes, past the end of the file`)
    }

    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))

    chunks.push({ type, at, length })
    at += 12 + length

    if (type === 'IEND') {
      return chunks
    }
  }

  throw new PngFormatError('PNG ended without an IEND chunk')
}

/** The whole `iCCP` chunk, header and CRC included, copied out. `null` when the file carries none. */
export function findIccpChunk(png: Uint8Array): Uint8Array | null {
  const chunk = readPngChunks(png).find((candidate) => candidate.type === 'iCCP')

  return chunk === undefined ? null : png.slice(chunk.at, chunk.at + 12 + chunk.length)
}

/**
 * Rewrites a PNG to carry only `KEPT_CHUNKS` plus whatever `iccp` asks for.
 *
 * Chunks are moved whole — length, type, data and CRC together — and none is ever edited, so no CRC
 * is recomputed and none can be wrong. An attached `iCCP` goes immediately after `IHDR`, which is
 * where the PNG specification requires it (before `PLTE` and before the first `IDAT`).
 *
 * The result owns its buffer, so `pipeline/worker.ts` may transfer it.
 */
export function rewritePngChunks(png: Uint8Array, iccp: IccpPlan): Uint8Array {
  const chunks = readPngChunks(png)
  const first = chunks[0]

  if (first === undefined || first.type !== 'IHDR') {
    throw new PngFormatError('PNG does not start with IHDR')
  }

  const pieces: Uint8Array[] = [png.subarray(0, 8)]

  for (const chunk of chunks) {
    if (chunk.type === 'iCCP') {
      if (iccp.kind === 'keep') {
        pieces.push(png.subarray(chunk.at, chunk.at + 12 + chunk.length))
      }
      continue
    }

    if (!KEPT_CHUNKS.has(chunk.type)) {
      continue
    }

    pieces.push(png.subarray(chunk.at, chunk.at + 12 + chunk.length))

    if (chunk.type === 'IHDR' && iccp.kind === 'attach') {
      pieces.push(iccp.chunk)
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

/** The IHDR fields later stages and tests reason about. */
export interface PngHeader {
  width: number
  height: number
  bitDepth: number
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType: number
  interlace: number
}

export function readPngHeader(png: Uint8Array): PngHeader {
  const header = readPngChunks(png)[0]

  if (header === undefined || header.type !== 'IHDR' || header.length !== 13) {
    throw new PngFormatError('PNG does not start with a 13-byte IHDR')
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  return {
    width: view.getUint32(header.at + 8),
    height: view.getUint32(header.at + 12),
    bitDepth: png[header.at + 16] as number,
    colorType: png[header.at + 17] as number,
    interlace: png[header.at + 20] as number,
  }
}

/** Palette entries in the file's `PLTE`, or `null` for a PNG that has no palette. */
export function readPaletteSize(png: Uint8Array): number | null {
  const plte = readPngChunks(png).find((chunk) => chunk.type === 'PLTE')

  return plte === undefined ? null : Math.floor(plte.length / 3)
}

/**
 * Whether the file can express transparency at all — an alpha channel in the colour type, or a
 * `tRNS` chunk against a palette or a solid colour.
 *
 * This answers "does the output carry alpha", not "is the image transparent"; `Frame` deliberately
 * has no `hasAlpha` for the second question (T23, D5).
 */
export function hasAlphaChannel(png: Uint8Array): boolean {
  const chunks = readPngChunks(png)
  const { colorType } = readPngHeader(png)

  return colorType === 4 || colorType === 6 || chunks.some((chunk) => chunk.type === 'tRNS')
}

/**
 * The branches a PNG job runs, in order.
 *
 * At and above the lossless point (R-Q12: slider 85, where the mapped value reaches 95) there is one
 * candidate. Below it there are two, and R-Q14 keeps the smaller.
 */
export function pngBranches(quality: QualitySettings): PngBranch[] {
  return quality.lossless ? ['lossless'] : ['lossless', 'quantized']
}

function assertMappedQuality(value: number): void {
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    throw new RangeError(`PNG quality must be a number from 1 to 100, got ${value}`)
  }
}

export interface QuantizerSettings {
  /** R-Q11's mapped value, rounded. Below this libimagequant aborts and the job stays lossless. */
  minimum: number
  target: number
  speed: number
}

/**
 * libimagequant's settings for one quantized attempt (R-Q11, §7.3).
 *
 * **The rounding happens here and nowhere earlier.** `domain/job.ts` carries the exact mapped value
 * — slider 20 is 73.333… — because `lossless` is decided from it, and R-Q12 pins that decision to
 * slider 85 exactly (mapped 95). Rounding first would make slider 84 (94.666… → 95) lossless too,
 * one step early. `Math.round` is used rather than a floor or a ceiling: nearest is the least
 * distorting reading of "remapped linearly", and the three values R-Q11 names — 10 → 70, 85 → 95,
 * 100 → 100 — are already whole and are not moved by it.
 *
 * Rounding is necessary because the value crosses into WebAssembly, where a fraction would be
 * truncated silently rather than rejected.
 */
export function quantizerSettings(quality: QualitySettings): QuantizerSettings {
  assertMappedQuality(quality.value)

  return {
    minimum: Math.round(quality.value),
    target: QUANTIZER_TARGET_QUALITY,
    speed: QUANTIZER_SPEED,
  }
}

export interface OxipngOptions {
  level: number
  interlace: boolean
  optimiseAlpha: boolean
}

/**
 * oxipng's options (§7.3). The same on both branches, which is a decision rather than an oversight.
 *
 * `optimiseAlpha` rewrites the colour beneath fully transparent pixels so the rows compress better.
 * It is measurably worth having — **28,330 bytes to 1,488** on a 1000x750 frame whose fully
 * transparent field held noise (`results.json`, `effort.optimiseAlpha`) — and it is invisible on
 * screen. It stays off anyway:
 *
 *   - on the lossless branch because that branch exists to be lossless. R-Q12 makes PNG lossless
 *     early precisely because "PNG is a lossless format by reputation", and a branch that changes
 *     pixel values, however invisible, is not the thing that reputation promises (P1). Measured on
 *     the same frame: with the option off the decoded pixels match the source exactly, visible and
 *     hidden alike; with it on they differ by up to 255 under the transparent field.
 *   - on the quantized branch because it buys nothing there. libimagequant has already collapsed
 *     every fully transparent pixel onto one palette entry, and oxipng measured the same 1,488 bytes
 *     with the option on and off.
 *
 * `interlace` stays false: Adam7 costs bytes and this pipeline optimises for size.
 */
export function oxipngOptions(): OxipngOptions {
  return { level: OXIPNG_LEVEL, interlace: false, optimiseAlpha: false }
}

/**
 * Whether an error from the quantizer is libimagequant's "could not reach the floor" abort rather
 * than a real failure.
 *
 * R-Q11's floor is enforced by this abort, so it is an ordinary outcome: the job keeps its lossless
 * PNG. Anything else the quantizer raises is a genuine failure and is left to propagate.
 */
export function isQuantizerAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return message.includes(QUANTIZER_ABORT_MESSAGE)
}

/**
 * The report's caveats for a finished PNG (R-X46, Functional Design §6.6).
 *
 * §6.6's table records `PNG quantized` for "PNG output below a slider value of 85", and the caveat's
 * own text is "PNG was not written losslessly". Below 85 that is only true when the quantized
 * candidate is the one kept — R-Q14 may keep the lossless one, and the quantizer may have aborted
 * to it — so the caveat follows the branch that produced the bytes rather than the slider. A caveat
 * that says the output is lossy when it is lossless would be a caveat the user cannot act on
 * (§14.3).
 */
export function pngCaveats(branch: PngBranch): Caveat[] {
  return branch === 'quantized' ? [{ kind: 'png-quantized' }] : []
}
