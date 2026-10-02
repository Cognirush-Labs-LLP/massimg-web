// The size-target search (Technical Design §7.5; Functional Design R-Q2, R-Q3, R-Q4). A binary
// search over the quality slider, capped at eight encodes.
//
// This module is pure in the sense the repository cares about: it imports no codec, so it runs under
// Vitest (T22's constraint). `runSizeSearch` is asynchronous, but the encoder is a parameter — the
// loop decides *where to probe next* and *which candidate to keep*, and knows nothing about what
// produces the bytes. Its sibling `size.ts` is what binds it to the real encoders, and is the half
// that cannot be unit-tested.
//
// **The search walks the slider, not an encoder parameter.** Every probe goes through
// `qualityForSlider` and then through the same stage the quality path uses, so a size-targeted
// output is a file the user could have produced by hand by moving the slider — R-Q6's lossless
// comparison, R-Q11's floor, R-Q14's pick and R-Q15's lossless animation all still apply, without
// this module knowing any of them exist. The alternative, searching each codec's own quality
// parameter, would have meant a second set of format rules that could drift from §7.4's.
//
// **Both ends are probed before the interior, and that is what makes an unresponsive axis cheap.**
// T28 measured `--lossy` to be completely inert on flat animations — every level from 1 to 200
// returns byte-identical output — and §7.4 records the same shape for PNG's `minimum`, where most of
// the axis produces one of two outcomes rather than a size curve. Probing the bottom first answers
// "unreachable" in one encode (R-Q3); probing the top second answers "the best quality already fits"
// in two, and *also* catches the inert axis for free: if the axis does nothing, the top produces the
// same bytes as the bottom, so it fits whenever the bottom did and the search stops there. Nothing
// here needs to detect inertness as a special case, which is why nothing here does.
//
// Cost, measured in `verification/t30-size/` and recorded in §7.5 and D1: a still PNG search costs
// one to three encodes and an animated PNG exactly one, while JPEG, WebP and AVIF — whose axes are
// smooth curves with something to find — spend the full eight on an interior target.

import type { Caveat, EncodableFormat } from '@/domain/types'
import { QUALITY_SLIDER_MAX, QUALITY_SLIDER_MIN } from '@/domain/job'

/**
 * §7.5's cap. Eight encodes, whether or not the search has converged; what it has found by then is
 * kept.
 *
 * Six of the eight are interior steps, which do not quite resolve the 89 positions between the two
 * ends. Checked exhaustively against a monotone axis, for every one of the 91 possible answers
 * (`size-plan.spec.ts`): the search lands on the best fitting position or **one below it**, never
 * further. One slider position is well under a percent of file size on every format measured, and
 * the cap is what stops a slow format from spending half a minute on one image.
 */
export const SIZE_SEARCH_MAX_ITERATIONS = 8

/** The inclusive range of slider positions a search may probe. */
export interface SizeBand {
  low: number
  high: number
}

/** One completed probe: where it was taken, and how large the file was. */
export interface SizeProbe {
  slider: number
  bytes: number
}

/**
 * Raised for a size target that is not a positive, finite number of bytes.
 *
 * Deliberately not a `RangeError`: `pipeline/worker.ts` reads every `RangeError` as the machine
 * having run out of memory (T23), and a nonsensical target is an upstream bug, not an allocation
 * failure. As an ordinary `Error` it lands as `encode-failed`, which is at least true — no file was
 * produced.
 */
export class SizeTargetError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'SizeTargetError'
  }
}

/**
 * The slider positions worth probing for this output.
 *
 * Almost always the whole slider, 10 to 100, because the search's answer has to be a file the
 * quality path could also have produced. The exception is **animated PNG, which has no quality axis
 * at all** (R-Q15): it is written losslessly at every slider position, so every probe would return
 * the identical file. A single-position band makes that one encode rather than two, and states the
 * reason in one place.
 */
export function sizeSearchBand(format: EncodableFormat, isAnimated: boolean): SizeBand {
  if (format === 'png' && isAnimated) {
    return { low: QUALITY_SLIDER_MAX, high: QUALITY_SLIDER_MAX }
  }

  return { low: QUALITY_SLIDER_MIN, high: QUALITY_SLIDER_MAX }
}

function assertTarget(targetBytes: number): void {
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    throw new SizeTargetError(`size target must be a positive number of bytes, got ${targetBytes}`)
  }
}

/** The highest slider whose probe came in at or under the target, or `null` if none did. */
function highestFitting(targetBytes: number, probes: readonly SizeProbe[]): SizeProbe | null {
  return probes.reduce<SizeProbe | null>(
    (best, probe) =>
      probe.bytes <= targetBytes && (best === null || probe.slider > best.slider) ? probe : best,
    null,
  )
}

/** The lowest slider whose probe came in over the target, or `null` if none did. */
function lowestMissing(targetBytes: number, probes: readonly SizeProbe[]): SizeProbe | null {
  return probes.reduce<SizeProbe | null>(
    (worst, probe) =>
      probe.bytes > targetBytes && (worst === null || probe.slider < worst.slider) ? probe : worst,
    null,
  )
}

/**
 * Where to encode next, or `null` when the search is over.
 *
 * The order is the whole design (see the module header): the bottom of the band, then the top, then
 * a binary search of the interior. Each of the first two can end the search on its own —
 * "unreachable at the lowest quality" (R-Q3) after one encode, "the highest quality already fits"
 * after two — and the second also ends it for an axis that does nothing, without a test for that.
 *
 * Nothing assumes the axis is monotone. If a probe fits *above* one that missed — which the measured
 * GIF and PNG axes both allow — the interval collapses and the search stops rather than bisecting a
 * range whose ends contradict each other. `sizeSearchOutcome` then reads the answer off the probes
 * themselves, so a non-monotone axis costs precision, never correctness.
 */
export function nextSizeProbe(
  targetBytes: number,
  band: SizeBand,
  probes: readonly SizeProbe[],
  maxIterations: number = SIZE_SEARCH_MAX_ITERATIONS,
): number | null {
  assertTarget(targetBytes)

  if (band.low > band.high) {
    throw new SizeTargetError(`size search band is empty: ${band.low} to ${band.high}`)
  }

  if (probes.length >= maxIterations) {
    return null
  }

  const first = probes[0]

  if (first === undefined) {
    return band.low
  }

  // R-Q3: the smallest file this format can make is already too big. Nothing above it can fit, so
  // there is nothing left to learn — the result is kept and the caveat recorded.
  if (first.bytes > targetBytes) {
    return null
  }

  if (band.low === band.high) {
    return null
  }

  if (probes.length === 1) {
    return band.high
  }

  const fitting = highestFitting(targetBytes, probes)
  const missing = lowestMissing(targetBytes, probes)

  // Everything probed fits, including the top of the band: the best quality is affordable.
  if (fitting === null || missing === null) {
    return null
  }

  // **A plateau, not a curve.** The axis has returned a file of exactly this size at two different
  // slider positions, which on every axis measured means it returned the *same file* — §7.4's PNG
  // `minimum`, where an image that can be quantized gets identical bytes at every position it can
  // meet, and T28's `--lossy`, which is byte-identical from 1 to 200 on flat content. Bisecting
  // further would spend the rest of the budget moving the boundary between two known sizes, and
  // hand the user the bytes it is already holding.
  //
  // The risk this takes is a curve that is flat between two probes and then rises again inside the
  // interval, where stopping forfeits a better-quality file that would still have fitted. No
  // measured axis has that shape — PNG steps once, GIF is either smooth or inert, and JPEG, WebP
  // and AVIF are smooth — and an exact byte-count tie at two distant positions is what would have
  // to happen by coincidence for a smooth one to be cut short.
  if (probes.filter((probe) => probe.bytes === fitting.bytes).length > 1) {
    return null
  }

  const next = Math.floor((fitting.slider + missing.slider) / 2)

  return next > fitting.slider && next < missing.slider ? next : null
}

export type SizeSearchOutcome =
  /** A probe came in at or under the target; this is the highest quality one that did (R-Q2). */
  | { kind: 'fit'; slider: number; bytes: number }
  /** Nothing fitted. This is the smallest file the search achieved, which is kept (R-Q3). */
  | { kind: 'unreachable'; slider: number; bytes: number }

/**
 * Which probe the job keeps.
 *
 * Read off the probes rather than tracked during the walk, so that it is right whatever order they
 * were taken in and whether or not the axis behaved monotonically. A tie on bytes keeps the higher
 * slider: the same number of bytes at a higher quality setting.
 */
export function sizeSearchOutcome(
  targetBytes: number,
  probes: readonly SizeProbe[],
): SizeSearchOutcome {
  assertTarget(targetBytes)

  const fitting = highestFitting(targetBytes, probes)

  if (fitting !== null) {
    return { kind: 'fit', slider: fitting.slider, bytes: fitting.bytes }
  }

  const smallest = probes.reduce<SizeProbe | null>(
    (best, probe) =>
      best === null ||
      probe.bytes < best.bytes ||
      (probe.bytes === best.bytes && probe.slider > best.slider)
        ? probe
        : best,
    null,
  )

  if (smallest === null) {
    throw new SizeTargetError('a size search outcome was asked for before anything was encoded')
  }

  return { kind: 'unreachable', slider: smallest.slider, bytes: smallest.bytes }
}

/** What one probe produced. The caveats are the encoder's own — `png-quantized`, and so on. */
export interface SizeCandidate {
  bytes: Uint8Array
  caveats: Caveat[]
}

export type SizeSearchResult = SizeCandidate &
  (
    | { kind: 'fit'; slider: number; probes: SizeProbe[] }
    | { kind: 'unreachable'; slider: number; probes: SizeProbe[] }
  )

/**
 * Runs the search, one encode per probe, and returns the file that is kept.
 *
 * **At most one candidate is held at a time beyond the one being encoded.** A probe that does not
 * become the answer is dropped as soon as the next one is measured; on a 24-megapixel GIF each
 * candidate is about 10 MB (T28), so retaining all eight would cost 80 MB inside a worker that
 * §8.1 budgets for one decode.
 *
 * `caveats` are the kept candidate's own, plus R-Q3's when the target was not reached.
 */
export async function runSizeSearch(
  options: { targetBytes: number; band: SizeBand; maxIterations?: number },
  encodeAt: (slider: number) => Promise<SizeCandidate>,
): Promise<SizeSearchResult> {
  const { targetBytes, band, maxIterations = SIZE_SEARCH_MAX_ITERATIONS } = options
  const probes: SizeProbe[] = []
  let kept: SizeCandidate | null = null

  for (;;) {
    const slider = nextSizeProbe(targetBytes, band, probes, maxIterations)

    if (slider === null) {
      break
    }

    const candidate = await encodeAt(slider)

    probes.push({ slider, bytes: candidate.bytes.byteLength })

    // The outcome only ever moves to the newest probe or stays where it was: the first probe always
    // becomes the answer, and every later one is only taken where it could beat it. So keeping the
    // new candidate exactly when it is the answer is enough, and the rest are released here.
    if (sizeSearchOutcome(targetBytes, probes).slider === slider) {
      kept = candidate
    }
  }

  const outcome = sizeSearchOutcome(targetBytes, probes)

  if (kept === null) {
    throw new SizeTargetError('the size search kept no candidate')
  }

  return {
    kind: outcome.kind,
    bytes: kept.bytes,
    caveats: kept.caveats,
    slider: outcome.slider,
    probes,
  }
}
