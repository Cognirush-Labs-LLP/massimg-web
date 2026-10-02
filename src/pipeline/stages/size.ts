// The size-target stage (Technical Design §7.5; Functional Design R-Q2, R-Q3, R-Q4). The impure half
// of the pair: `size-plan.ts` decides where to probe and what to keep, and this module is what turns
// a probe into bytes.
//
// It exists so that the search has exactly one way to encode — the same stage the quality path uses,
// reached through `qualityForSlider`. A probe at slider 40 produces the file the user would have got
// by leaving the slider at 40, so everything those stages do stays true under a size target:
//
//   - R-Q6's lossy/lossless comparison and its content gate, for still and animated WebP.
//   - R-Q11's floor, R-Q12's lossless point and R-Q14's comparison, for still PNG.
//   - R-Q15's lossless animated PNG, which is why `sizeSearchBand` gives it a one-position band.
//   - R-Q8's gifsicle pass, its retries, and the ImageMagick fallback.
//
// It also means the per-iteration cost is the *whole* stage, not one codec call: a PNG probe is a
// lossless encode plus a quantized one, and a still GIF probe is an ImageMagick write plus up to
// four gifsicle runs. `verification/t30-size/` measures what that comes to per format, and §7.5
// carries the figures.
//
// Imports `codecs/loader.ts` transitively, so nothing here runs under Vitest (T22). The decisions are
// next door; what is proven here is proven in `tests/e2e/size.spec.ts` and `tests/e2e/pool.spec.ts`.

import { QUALITY_SLIDER_MIN, qualityForSlider } from '@/domain/job'
import type { EncodableFormat } from '@/domain/types'
import { encodeAnimatedWebp, encodeApng } from './animation-encode'
import { encodeFrame } from './encode'
import type { StillFormat } from './encode-plan'
import { singleFrameAnimation } from './frame'
import type { Animation, Frame } from './frame'
import { encodeGif } from './gif'
import { encodePng } from './png'
import { runSizeSearch, sizeSearchBand } from './size-plan'
import type { SizeCandidate, SizeSearchResult } from './size-plan'

/**
 * The three formats that can carry an animation (R-F6). `executeJob` has already substituted WebP
 * for the two that cannot, so nothing else reaches the animated search.
 */
export type AnimatedFormat = Extract<EncodableFormat, 'png' | 'webp' | 'gif'>

/** One ordinary still encode at a slider position, shared by target and dimension recovery. */
export async function encodeStillAtSlider(
  frame: Frame,
  format: EncodableFormat,
  slider: number,
): Promise<SizeCandidate> {
  if (format === 'png') {
    return await encodePng(frame, qualityForSlider(slider, format))
  }

  if (format === 'gif') {
    return await encodeGif(singleFrameAnimation(frame), qualityForSlider(slider, format))
  }

  const still: StillFormat = format
  const encoded = await encodeFrame(frame, still, qualityForSlider(slider, still))

  return { bytes: encoded.bytes, caveats: [] }
}

/**
 * Searches the slider for the best-quality still image that fits `targetBytes` (R-Q3).
 *
 * The frame is not modified or retained; each probe re-encodes it from the same pixels.
 */
export async function encodeStillToSize(
  frame: Frame,
  format: EncodableFormat,
  targetBytes: number,
  minimumSlider = QUALITY_SLIDER_MIN,
): Promise<SizeSearchResult> {
  const baseBand = sizeSearchBand(format, false)
  const band = { ...baseBand, low: Math.max(baseBand.low, minimumSlider) }

  return await runSizeSearch({ targetBytes, band }, async (slider) =>
    encodeStillAtSlider(frame, format, slider),
  )
}

/**
 * Searches the slider for the best-quality animation that fits `targetBytes` (R-Q3).
 *
 * Every probe re-encodes **every frame**, which is what makes an animated search the expensive one:
 * the per-iteration cost is the whole animation, not one image. R-Q10 forbids the cheaper lever —
 * frames are never dropped to hit a target — so the only axis is quality.
 *
 * Animated PNG has no such axis at all (R-Q15), and `sizeSearchBand` gives it a single position, so
 * this runs one encode and then either fits or records R-Q3's caveat.
 */
export async function encodeAnimatedToSize(
  animation: Animation,
  format: AnimatedFormat,
  targetBytes: number,
): Promise<SizeSearchResult> {
  const band = sizeSearchBand(format, true)

  if (format === 'png') {
    return await runSizeSearch({ targetBytes, band }, async () => encodeApng(animation))
  }

  if (format === 'gif') {
    return await runSizeSearch({ targetBytes, band }, async (slider) =>
      encodeGif(animation, qualityForSlider(slider, format)),
    )
  }

  return await runSizeSearch({ targetBytes, band }, async (slider) =>
    encodeAnimatedWebp(animation, qualityForSlider(slider, format)),
  )
}
