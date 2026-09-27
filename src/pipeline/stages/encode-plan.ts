// The pure half of the still encode stage (Technical Design §7.3, §7.4, §7.6; Functional Design
// R-Q5, R-Q6, R-Q7, R-I12, R-I14, R-I35). What `encode.ts` asks ImageMagick for, decided without
// ImageMagick.
//
// Kept apart from `encode.ts` for the reason `frame.ts` is kept apart from `decode.ts`: anything that
// imports `codecs/loader.ts` cannot run under Vitest (T22's note), and every rule below is a table.
//
// Measured facts this module encodes (T26's spike, magick-wasm 0.0.43):
//
//   - **WebP lossless is exact only with the quality left unset.** An explicit quality alongside
//     `webp:lossless` changed pixel values (maximum error 2 opaque, 175 under alpha), so the lossless
//     attempt sets no quality at all and libwebp uses its own default effort, 75 — §7.3's "library
//     default, not maximum".
//   - **This build cannot write a usable lossless AVIF.** Quality 100 selects AOM's lossless mode,
//     which it rejects ("Only --enable_chroma_deltaq=0 can be used with --lossless=1") unless the
//     file is labelled with the identity matrix — and that label comes with a limited-range flag no
//     define can change. The resulting file round-trips through ImageMagick within one unit but is
//     wrong in every browser: measured maximum error 5 on Chromium, 16 on Firefox, and black on
//     WebKit. So AVIF above 95 is encoded as highest-quality lossy at 4:4:4, which all three engines
//     decode within one unit. See docs/assumptions.md D9; this is a documented deviation from R-Q5.
//   - **The writer converts RGB to YUV with BT.601 whatever matrix it labels the file with.** Writing
//     the source's matrix coefficients therefore tells decoders to invert a conversion that never
//     happened: a BT.709-signalled source came back off by 10 in Chromium and Firefox. CICP output
//     keeps the source's primaries and transfer — the two that describe the colour — and states the
//     matrix this build actually used.
//   - **HEIF-family defines live under `heic:` even for AVIF** (T23).

import { isUnspecifiedCicp } from './frame'
import type { FrameColour } from './frame'
import type { ResolvedQuality } from '@/domain/types'

export type StillFormat = 'jpeg' | 'webp' | 'avif'

/**
 * Every format whose colour question this module answers, which is all of them.
 *
 * PNG's encoder lives in `png-plan.ts` / `png.ts` and GIF's in `gif-plan.ts` / `gif.ts`, because
 * neither is one ImageMagick write — but "can this container carry this frame's colour" is the same
 * question with the same answer table, and answering it in three places is how the three come to
 * disagree. `executeJob` calls `unsupportedColour` for every format.
 *
 * **GIF is in this list as a profile-carrying format, which contradicts R-I13** ("when the output
 * format cannot carry a profile (GIF)…"). It carries one: ImageMagick writes the profile into a GIF
 * application extension and reads it back, gifsicle preserves it, and D3 measured a Display P3
 * profile surviving that route byte-identically on all three engines. The requirement's premise is
 * wrong for this build, so following it — converting the pixels — would be the change nobody asked
 * for. Recorded for the user in docs/task-notes/T28.md; the requirement is theirs to correct.
 */
export type ColourFormat = StillFormat | 'png' | 'gif'

export type EncodeMode = 'lossy' | 'lossless'

/** A `MagickFormat` *key*. Keys and values differ (`WebP` → `"WEBP"`), and indexing by value writes
 * the wrong format without an error (T23), so the stage indexes by these. */
export type MagickFormatKey = 'Jpeg' | 'WebP' | 'Avif' | 'Heic'

export interface EncoderDefine {
  format: MagickFormatKey
  name: string
  value: string
}

export interface EncoderAttempt {
  mode: EncodeMode
  format: Exclude<MagickFormatKey, 'Heic'>
  /** `null` leaves ImageMagick's quality unset, which the WebP lossless recipe depends on. */
  quality: number | null
  defines: EncoderDefine[]
}

export type QualitySettings = Extract<ResolvedQuality, { kind: 'quality' }>

/** §7.3: AVIF encode speed, chosen on twenty real photographs (D7). Never left at the library default. */
export const AVIF_SPEED = 9

/** §7.3: WebP `method`. 4 is libwebp's default; 6 costs several times the time for single-digit gains. */
export const WEBP_METHOD = 4

/**
 * The highest AVIF quality this build can encode. 100 is AOM's lossless switch, and lossless AVIF is
 * unusable here (see the header and D9), so the slider value is capped here: 96 still encodes at 96,
 * and only 100 is pulled down to 99. Above 95 the chroma subsampling is dropped as well.
 */
export const AVIF_MAX_QUALITY = 99

/**
 * The R-Q6 content gate: a frame with more distinct RGBA values than this skips the lossless WebP
 * attempt. Set from `verification/t26-encode/` (docs/assumptions.md D2): across 311 real images no
 * lossless win had more than 2,034 colours, and no limit from 4,096 up skipped one. 65,536 keeps a
 * wide margin for screenshot-like content the corpus under-represents, at the price of about a
 * second spent on the one photograph in eight that falls below it. Erring high only costs time;
 * erring low costs the user output size.
 */
export const LOSSLESS_GATE_MAX_COLORS = 65_536

/**
 * Raised for an encoder quality, mode or format this module was asked for that is out of range or
 * unsupported.
 *
 * Deliberately not a `RangeError`: `pipeline/worker.ts` reports any `RangeError` as the machine
 * running out of memory (T23), and a bad quality value or an unsupported mode/format is an upstream
 * bug, not an allocation failure.
 */
export class EncodePlanError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'EncodePlanError'
  }
}

function assertQuality(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new EncodePlanError(`encoder quality must be a whole number from 1 to 100, got ${value}`)
  }
}

/**
 * The attempts a still encode makes, in order. The last entry is conditional for WebP below 96: it
 * runs only if the content gate lets it (R-Q6).
 */
export function plannedModes(format: StillFormat, quality: QualitySettings): EncodeMode[] {
  if (format === 'jpeg') {
    // JPEG has no lossless mode; 96-100 is "highest quality", the value as given (§7.4).
    return ['lossy']
  }

  // AVIF has no usable lossless mode in this build, so 96-100 is highest quality, as JPEG is.
  if (format === 'avif') {
    return ['lossy']
  }

  if (quality.lossless) {
    return ['lossless']
  }

  return ['lossy', 'lossless']
}

/** The quality, format and effort defines for one attempt (§7.3, §7.4). Colour defines are separate. */
export function encoderAttempt(
  format: StillFormat,
  quality: QualitySettings,
  mode: EncodeMode,
): EncoderAttempt {
  assertQuality(quality.value)

  switch (format) {
    case 'jpeg':
      if (mode === 'lossless') {
        throw new EncodePlanError('JPEG has no lossless mode')
      }

      return { mode, format: 'Jpeg', quality: quality.value, defines: [] }
    case 'webp': {
      const method: EncoderDefine = { format: 'WebP', name: 'method', value: String(WEBP_METHOD) }

      return mode === 'lossless'
        ? {
            mode,
            format: 'WebP',
            quality: null,
            defines: [{ format: 'WebP', name: 'lossless', value: 'true' }, method],
          }
        : { mode, format: 'WebP', quality: quality.value, defines: [method] }
    }
    case 'avif': {
      if (mode === 'lossless') {
        throw new EncodePlanError('AVIF has no usable lossless mode in this build (D9)')
      }

      const defines: EncoderDefine[] = [
        { format: 'Heic', name: 'speed', value: String(AVIF_SPEED) },
      ]

      // What "lossless" becomes for AVIF: the quality asked for, short of AOM's lossless switch, with
      // no chroma subsampling, so a request for a perfect image gets the best this build can give it.
      if (quality.value > 95) {
        defines.push({ format: 'Heic', name: 'chroma', value: '444' })
      }

      return {
        mode,
        format: 'Avif',
        quality: Math.min(quality.value, AVIF_MAX_QUALITY),
        defines,
      }
    }
    default: {
      const unknown: never = format
      throw new EncodePlanError(`unsupported still format: ${String(unknown)}`)
    }
  }
}

/** How the frame's colour reaches the output. */
export type ColourPlan =
  | { kind: 'none' }
  | { kind: 'profile'; profile: Uint8Array }
  | { kind: 'defines'; defines: EncoderDefine[] }
  | { kind: 'unsupported'; detail: string }

/** H.273 code points for the one CICP signal that means exactly what an untagged output means. */
const CICP_PRIMARIES_BT709 = 1
const CICP_TRANSFER_SRGB = 13

/**
 * The matrix coefficients this build's HEIF writer actually applies, whatever it is told to label
 * the file with. Measured in T26: a file labelled BT.709 decoded 10 units out in Chromium and
 * Firefox, and one labelled BT.601 decoded within 3, from identical pixels.
 */
const CICP_MATRIX_BT601 = 6

function cicpDefines(primaries: number, transfer: number): EncoderDefine[] {
  return [
    { format: 'Heic', name: 'cicp', value: `${primaries},${transfer},${CICP_MATRIX_BT601}` },
    { format: 'Heic', name: 'preserve-cicp', value: 'true' },
  ]
}

/**
 * Whether a frame's colour has nowhere to go in this format, and why. `null` means it can be written.
 *
 * Only CICP into JPEG, WebP, PNG or GIF can fail: none of those containers can express it here, and
 * converting the pixels into sRGB — R-I35's other half, with the `colour-converted` caveat — is a
 * deferred follow-up. Two signals are not a failure, because they say no more than an untagged
 * output already says: all-unspecified, and BT.709 primaries with the sRGB transfer.
 *
 * PNG's third edition does define a `cICP` chunk, so "cannot" is about this build rather than the
 * format. Verified rather than assumed (T27): ImageMagick's PNG coder's own chunk vocabulary in the
 * shipped binary lists `bKGD,caNv,cHRM,eXIf,gAMA,iCCP,iTXt,pHYs,sRGB,tEXt,zCCP,zTXt,date` and no
 * `cICP` — libpng's chunk table has one, ImageMagick's coder does not — and a PNG written with
 * `png:cicp`, `png:cICP`, `png:preserve-cICP` and the `heic:` spellings set is byte-identical to one
 * written with no define at all.
 *
 * The matrix is not consulted: it describes how the source stored YUV, which decode has undone.
 */
export function unsupportedColour(colour: FrameColour, format: ColourFormat): string | null {
  if (colour.kind !== 'cicp' || format === 'avif') {
    return null
  }

  const { primaries, transfer, matrix } = colour.cicp
  const srgbEquivalent =
    isUnspecifiedCicp(colour.cicp) ||
    (primaries === CICP_PRIMARIES_BT709 && transfer === CICP_TRANSFER_SRGB)

  return srgbEquivalent
    ? null
    : `CICP ${primaries}/${transfer}/${matrix} cannot be carried by ${format} output yet`
}

/**
 * Decides how colour is written (R-I12, R-I14, R-I35; §7.7). Pixels are never converted here (R-I15).
 *
 * - `icc` is written verbatim; JPEG, WebP, AVIF, PNG and GIF can all carry a profile — see
 *   `ColourFormat` for why GIF belongs in that list despite R-I13.
 * - `untagged` adds nothing.
 * - `cicp` is written back into AVIF, keeping the primaries and transfer that describe the colour and
 *   stating the matrix this build's writer really used (see `CICP_MATRIX_BT601`). For JPEG, WebP,
 *   PNG and GIF see `unsupportedColour` — what reaches here for those four says no more than an
 *   untagged output does, so nothing is written.
 */
export function colourPlan(colour: FrameColour, format: ColourFormat): ColourPlan {
  const unsupported = unsupportedColour(colour, format)

  if (unsupported !== null) {
    return { kind: 'unsupported', detail: unsupported }
  }

  switch (colour.kind) {
    case 'icc':
      return { kind: 'profile', profile: colour.profile }
    case 'untagged':
      return { kind: 'none' }
    case 'cicp':
      return format === 'avif'
        ? { kind: 'defines', defines: cicpDefines(colour.cicp.primaries, colour.cicp.transfer) }
        : { kind: 'none' }
    default: {
      const unknown: never = colour
      throw new EncodePlanError(`unsupported colour: ${JSON.stringify(unknown)}`)
    }
  }
}

/**
 * Counts distinct RGBA values, stopping as soon as the count passes `limit`. Returns the exact count
 * when it is at most `limit`, and `limit + 1` otherwise.
 *
 * A photograph passes any sensible limit within a small fraction of its pixels, so the gate costs a
 * partial scan exactly where it saves the most. A flat graphic is scanned in full, but is mostly runs
 * of the previous pixel, which never touch the set.
 */
export function countUniqueColors(pixels: Uint8Array, limit: number): number {
  const pixelCount = Math.floor(pixels.byteLength / 4)
  const aligned = pixels.byteOffset % 4 === 0 ? pixels : pixels.slice()
  const values = new Uint32Array(aligned.buffer, aligned.byteOffset, pixelCount)
  const seen = new Set<number>()
  let previous: number | undefined

  for (let index = 0; index < pixelCount; index += 1) {
    const value = values[index] as number

    if (value === previous) {
      continue
    }

    previous = value
    seen.add(value)

    if (seen.size > limit) {
      return limit + 1
    }
  }

  return seen.size
}

/** R-Q6's gate: whether the lossless WebP attempt is worth running for this many distinct colours. */
export function shouldTryLossless(uniqueColors: number): boolean {
  return uniqueColors <= LOSSLESS_GATE_MAX_COLORS
}

/** R-Q6: the smaller output is kept. A tie keeps lossless — the same size with no loss. */
export function pickSmaller(lossyBytes: number, losslessBytes: number): EncodeMode {
  return losslessBytes <= lossyBytes ? 'lossless' : 'lossy'
}

/** Whether every pixel is fully opaque, so the encoder can drop an alpha plane that carries nothing. */
export function isOpaque(pixels: Uint8Array): boolean {
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) {
      return false
    }
  }

  return true
}
