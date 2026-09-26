// The still encode stage (Technical Design §4.2's last stage for JPEG, WebP and AVIF; §7.3, §7.4,
// §7.6; Functional Design R-Q5, R-Q6, R-Q7, R-I12, R-I14, R-I35). One resized `Frame` in, the
// output file's bytes out.
//
// What to ask ImageMagick for is decided in `encode-plan.ts`, which is unit-tested. This module only
// carries those decisions out, and is proven in `tests/e2e/encode.spec.ts` on all three engines,
// because it imports `codecs/loader.ts` (T22's Vitest constraint).
//
// Properties this module is responsible for:
//
//   1. **Effort is pinned, never the library default** (§7.3): AVIF speed 9, WebP method 4.
//   2. **WebP below 96 keeps the smaller of lossy and lossless** (R-Q6), and skips the lossless
//      attempt when the content gate says the frame is photographic (§7.6, D2).
//   3. **Every attempt starts from a fresh read of the frame.** A quality or define set for one
//      attempt cannot leak into the next — and WebP lossless depends on the quality being *unset*.
//   4. **Colour is carried, never converted** (R-I15): the profile verbatim, CICP into AVIF, nothing
//      for an untagged frame. A CICP signal JPEG or WebP cannot carry is refused, and `executeJob`
//      refuses it before decoding rather than after a decode, edit and resize that cannot be used.
//   5. **No metadata can reach the output** (R-I10, R-I17). The image is built from raw pixels, so
//      there is no EXIF, XMP, IPTC or orientation tag to copy; the only profile is the one set here.
//   6. **The bytes are owned.** `write` hands its callback a view onto the codec heap; it is copied,
//      and the copy is asserted, because `pipeline/worker.ts` transfers the result.
//
// An AVIF larger than its input is returned as it is (R-Q7). Whether the original is written instead
// is R-X24's decision, not this stage's.

import { ensureImageMagick } from '@/pipeline/codecs/loader'
import {
  LOSSLESS_GATE_MAX_COLORS,
  colourPlan,
  countUniqueColors,
  encoderAttempt,
  isOpaque,
  pickSmaller,
  plannedModes,
  shouldTryLossless,
} from './encode-plan'
import type {
  ColourPlan,
  EncodeMode,
  EncoderDefine,
  QualitySettings,
  StillFormat,
} from './encode-plan'
import { ownsWholeBuffer } from './frame'
import type { Frame } from './frame'

/** Raised when ImageMagick produced no usable output. The worker maps this to `encode-failed`. */
export class EncodeError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'EncodeError'
  }
}

/**
 * The frame's colour cannot be carried by the chosen format, and converting it is not built yet.
 * The worker reports this as `unimplemented`, not as an encode failure: nothing went wrong, the
 * pipeline simply has no path for it.
 */
export class UnsupportedColourError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'UnsupportedColourError'
  }
}

export interface EncodeResult {
  bytes: Uint8Array
  /** Which attempt produced `bytes`. */
  mode: EncodeMode
  /** Every attempt actually encoded, in order. The gate's decision is visible here. */
  attempts: EncodeMode[]
  /** Distinct RGBA values, capped at the gate limit + 1; `null` when the gate did not run. */
  uniqueColors: number | null
}

type Magick = Awaited<ReturnType<typeof ensureImageMagick>>

function encodeOnce(
  magick: Magick,
  frame: Frame,
  format: StillFormat,
  quality: QualitySettings,
  mode: EncodeMode,
  colour: Exclude<ColourPlan, { kind: 'unsupported' }>,
  opaque: boolean,
): Uint8Array {
  const { AlphaAction, ImageMagick, ImageProfile, MagickFormat, MagickReadSettings } = magick
  const attempt = encoderAttempt(format, quality, mode)
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: frame.width,
    height: frame.height,
    depth: 8,
  })

  const bytes = ImageMagick.read(frame.pixels, settings, (image) => {
    // A raw RGBA read always has an alpha channel. AVIF writes it as a plane even when every pixel
    // is opaque, which costs bytes and says nothing.
    if (opaque) {
      image.alpha(AlphaAction.Off)
    }

    if (attempt.quality !== null) {
      image.quality = attempt.quality
    }

    const defines: EncoderDefine[] = [...attempt.defines]

    if (colour.kind === 'profile') {
      image.setProfile(new ImageProfile('icc', colour.profile))
    }

    if (colour.kind === 'defines') {
      defines.push(...colour.defines)
    }

    for (const define of defines) {
      image.settings.setDefine(MagickFormat[define.format], define.name, define.value)
    }

    // Indexed by key: `MagickFormat`'s values differ from its keys, and an undefined format still
    // writes bytes, in the wrong format, without an error (T23).
    return image.write(MagickFormat[attempt.format], (data) => data.slice())
  })

  if (bytes.byteLength === 0) {
    throw new EncodeError(`${format} ${mode} encode produced no bytes`)
  }

  if (!ownsWholeBuffer(bytes)) {
    throw new EncodeError('encoded bytes are a view onto codec memory, not an owned buffer')
  }

  return bytes
}

/**
 * Encodes one still frame to JPEG, WebP or AVIF.
 *
 * `quality` is `ResolvedSettings.quality` when the job names one, and one probe of the size search
 * when it names a target instead (T30, `stages/size.ts`). Pass the frame the resize stage returned;
 * this stage does not modify or retain it.
 */
export async function encodeFrame(
  frame: Frame,
  format: StillFormat,
  quality: QualitySettings,
): Promise<EncodeResult> {
  const plan = colourPlan(frame.colour, format)

  // `executeJob` refuses this before decoding; the stage checks too, since it is callable on its own.
  if (plan.kind === 'unsupported') {
    throw new UnsupportedColourError(plan.detail)
  }

  const modes = plannedModes(format, quality)
  const magick = await ensureImageMagick()
  const opaque = isOpaque(frame.pixels)
  const [firstMode, secondMode] = modes

  if (firstMode === undefined) {
    throw new EncodeError(`no encode attempt planned for ${format}`)
  }

  const first = encodeOnce(magick, frame, format, quality, firstMode, plan, opaque)

  if (secondMode === undefined) {
    return { bytes: first, mode: firstMode, attempts: [firstMode], uniqueColors: null }
  }

  // R-Q6's gate (§7.6): a photograph skips the lossless attempt it would lose.
  const uniqueColors = countUniqueColors(frame.pixels, LOSSLESS_GATE_MAX_COLORS)

  if (!shouldTryLossless(uniqueColors)) {
    return { bytes: first, mode: firstMode, attempts: [firstMode], uniqueColors }
  }

  const second = encodeOnce(magick, frame, format, quality, secondMode, plan, opaque)
  const kept =
    pickSmaller(first.byteLength, second.byteLength) === 'lossless'
      ? { bytes: second, mode: 'lossless' as const }
      : { bytes: first, mode: 'lossy' as const }

  return { ...kept, attempts: [firstMode, secondMode], uniqueColors }
}
