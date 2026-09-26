// The still PNG stage (Technical Design §4.2's PNG-still row — "quantize, optimise, compare against
// lossless"; §7.3, §7.4, §7.6; Functional Design R-Q11, R-Q12, R-Q13, R-Q14, R-I12, R-I14, R-I17).
// One resized `Frame` in, the PNG file's bytes out.
//
// What to ask for is decided in `png-plan.ts`, which is unit-tested. This module only carries those
// decisions out, and is proven in `tests/e2e/png.spec.ts` on all three engines, because it imports
// `codecs/loader.ts` (T22's Vitest constraint).
//
// Two candidates, not one:
//
//   lossless   ImageMagick writes the PNG → strip its metadata → oxipng level 2
//   quantized  libimagequant writes the PNG → attach the profile → oxipng level 2   (below R-Q12's point)
//
// R-Q14 keeps the smaller; a tie keeps lossless, the same rule `pickSmaller` applies to WebP.
//
// Properties this module is responsible for:
//
//   1. **The lossless branch is lossless.** ImageMagick writes the frame's own 8-bit RGBA, oxipng's
//      reductions are lossless by definition, and `optimiseAlpha` is off so even the colour under a
//      fully transparent pixel survives.
//   2. **R-Q11's floor is enforced by libimagequant, not by this code.** The mapped value is the
//      quantizer's `minimum`, and an image that cannot reach it aborts. An abort is an ordinary
//      outcome: the job keeps the lossless candidate. Anything else the quantizer raises propagates.
//   3. **The profile reaches both candidates identically.** ImageMagick writes the `iCCP` (D3);
//      libimagequant writes none, so that exact chunk is spliced into its output — bytes moved
//      whole, never re-encoded — *before* the size comparison, so R-Q14 compares two files that both
//      carry it.
//   4. **No metadata reaches the output** (R-I10, R-I17). ImageMagick's own `tIME`, `tEXt` dates and
//      duplicate `zTXt` profile are stripped by `rewritePngChunks`, which keeps a whitelist.
//   5. **The bytes are owned.** Both writers hand back copies, and both are asserted, because
//      `pipeline/worker.ts` transfers the result.

import type { Caveat } from '@/domain/types'
import { ensureImageMagick, ensureOxipng, ensureQuantizer } from '@/pipeline/codecs/loader'
import { EncodeError, UnsupportedColourError } from './encode'
import { colourPlan, isOpaque, pickSmaller } from './encode-plan'
import type { ColourPlan, QualitySettings } from './encode-plan'
import { ownsWholeBuffer } from './frame'
import type { Frame } from './frame'
import {
  findIccpChunk,
  isQuantizerAbort,
  oxipngOptions,
  pngBranches,
  pngCaveats,
  quantizerSettings,
  readPaletteSize,
  rewritePngChunks,
} from './png-plan'
import type { IccpPlan, PngBranch } from './png-plan'

export interface PngEncodeResult {
  bytes: Uint8Array
  /** Which candidate produced `bytes`. */
  branch: PngBranch
  /** Every candidate that actually produced a file, in order. */
  branches: PngBranch[]
  /** Whether libimagequant refused to meet R-Q11's floor for this image. */
  quantizeAborted: boolean
  /** The report's caveats for this output (R-X46). Empty unless the quantized candidate was kept. */
  caveats: Caveat[]
  /** Final size of each candidate, for the comparison R-Q14 asks for. `null` when it did not run. */
  sizes: { lossless: number; quantized: number | null }
  /** Palette entries in the kept file, or `null` when it is not a palette PNG. */
  paletteColors: number | null
}

type Magick = Awaited<ReturnType<typeof ensureImageMagick>>

/** Writes the frame as a PNG with ImageMagick, exactly as it stands. Metadata is stripped after. */
function writeLosslessPng(magick: Magick, frame: Frame, colour: ColourPlan, opaque: boolean) {
  const { AlphaAction, ImageMagick, ImageProfile, MagickFormat, MagickReadSettings } = magick
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: frame.width,
    height: frame.height,
    depth: 8,
  })

  return ImageMagick.read(frame.pixels, settings, (image) => {
    // A raw RGBA read always has an alpha channel. An opaque frame does not need one, and a PNG
    // that carries it pays for a channel of 255s.
    if (opaque) {
      image.alpha(AlphaAction.Off)
    }

    if (colour.kind === 'profile') {
      image.setProfile(new ImageProfile('icc', colour.profile))
    }

    // Indexed by key: `MagickFormat`'s values differ from its keys, and an undefined format still
    // writes bytes, in the wrong format, without an error (T23).
    return image.write(MagickFormat.Png, (data) => data.slice())
  })
}

/**
 * Quantizes the frame with libimagequant, which returns a finished PNG rather than pixels.
 *
 * Returns `null` when libimagequant aborted because it could not reach R-Q11's floor — the whole
 * point of setting the floor as its `minimum`. Any other failure is re-raised.
 */
function writeQuantizedPng(
  quantizer: Awaited<ReturnType<typeof ensureQuantizer>>,
  frame: Frame,
  quality: QualitySettings,
): Uint8Array | null {
  const { minimum, target, speed } = quantizerSettings(quality)
  const instance = new quantizer.Imagequant()

  try {
    instance.set_speed(speed)
    instance.set_quality(minimum, target)

    // The constructor copies the pixels into libimagequant's own heap, and `process` consumes the
    // image, so neither outlives this call.
    const image = new quantizer.ImagequantImage(frame.pixels, frame.width, frame.height, 0)

    return instance.process(image)
  } catch (error) {
    if (isQuantizerAbort(error)) {
      return null
    }

    throw error
  } finally {
    // Once only: a second `free()` panics with "null pointer passed to rust".
    instance.free()
  }
}

/**
 * Encodes one still frame to PNG.
 *
 * `quality` is `ResolvedSettings.quality` once the size target is ruled out, carrying R-Q11's mapped
 * value and R-Q12's `lossless` flag as `domain/job.ts` computed them. A size-targeted job reaches
 * here too, once per probe, through `qualityForSlider` — see `stages/size.ts` (T30).
 */
export async function encodePng(frame: Frame, quality: QualitySettings): Promise<PngEncodeResult> {
  const plan = colourPlan(frame.colour, 'png')

  // `executeJob` refuses this before decoding; the stage checks too, since it is callable on its own.
  if (plan.kind === 'unsupported') {
    throw new UnsupportedColourError(plan.detail)
  }

  if (plan.kind === 'defines') {
    // PNG has no define this build honours — it writes no `cICP` chunk whatever it is told (T27).
    throw new EncodeError('PNG output cannot carry colour as encoder defines')
  }

  const branches = pngBranches(quality)
  const [magick, oxipng] = await Promise.all([ensureImageMagick(), ensureOxipng()])
  const opaque = isOpaque(frame.pixels)
  const options = oxipngOptions()

  const optimise = async (png: Uint8Array): Promise<Uint8Array> => {
    const optimised = new Uint8Array(
      await oxipng.default(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
        options,
      ),
    )

    if (optimised.byteLength === 0) {
      throw new EncodeError('oxipng produced no bytes')
    }

    return optimised
  }

  const written = writeLosslessPng(magick, frame, plan, opaque)

  if (written.byteLength === 0) {
    throw new EncodeError('PNG lossless encode produced no bytes')
  }

  // Lifted before the rewrite drops anything, and kept whole: the chunk the quantized candidate
  // receives is byte-for-byte the one ImageMagick wrote, so D3's "the profile survives" covers both.
  const iccp = plan.kind === 'profile' ? findIccpChunk(written) : null

  if (plan.kind === 'profile' && iccp === null) {
    throw new EncodeError('ImageMagick wrote no iCCP chunk for a frame that carries a profile')
  }

  const lossless = await optimise(
    rewritePngChunks(written, plan.kind === 'profile' ? { kind: 'keep' } : { kind: 'drop' }),
  )

  const result = (
    bytes: Uint8Array,
    branch: PngBranch,
    ran: PngBranch[],
    aborted: boolean,
    quantizedSize: number | null,
  ): PngEncodeResult => {
    if (!ownsWholeBuffer(bytes)) {
      throw new EncodeError('encoded bytes are a view onto codec memory, not an owned buffer')
    }

    return {
      bytes,
      branch,
      branches: ran,
      quantizeAborted: aborted,
      caveats: pngCaveats(branch),
      sizes: { lossless: lossless.byteLength, quantized: quantizedSize },
      paletteColors: readPaletteSize(bytes),
    }
  }

  if (!branches.includes('quantized')) {
    return result(lossless, 'lossless', ['lossless'], false, null)
  }

  const quantizer = await ensureQuantizer()
  const quantizedRaw = writeQuantizedPng(quantizer, frame, quality)

  if (quantizedRaw === null) {
    // R-Q11's floor: libimagequant could not reach it, so nothing was quantized and the lossless
    // candidate stands. Not a failure — the requirement asks for exactly this.
    return result(lossless, 'lossless', ['lossless'], true, null)
  }

  const attach: IccpPlan = iccp === null ? { kind: 'drop' } : { kind: 'attach', chunk: iccp }
  const quantized = await optimise(rewritePngChunks(quantizedRaw, attach))

  // R-Q14, through the same function R-Q6 uses: the smaller is kept, and a tie keeps lossless.
  const keepLossless = pickSmaller(quantized.byteLength, lossless.byteLength) === 'lossless'

  return keepLossless
    ? result(lossless, 'lossless', ['lossless', 'quantized'], false, quantized.byteLength)
    : result(quantized, 'quantized', ['lossless', 'quantized'], false, quantized.byteLength)
}
