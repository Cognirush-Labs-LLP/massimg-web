// The pure half of the GIF path (Technical Design §4.2's `GIF` row, §7.3, §7.4; Functional Design
// R-Q8). What `gif.ts` asks ImageMagick and gifsicle for, decided without touching either.
//
// Split from `gif.ts` for the same reason `encode-plan.ts` is split from `encode.ts`: anything that
// imports `codecs/loader.ts` cannot run under Vitest (T22), and the arithmetic below is exactly the
// part worth unit-testing.
//
// Two conversions live here, and both are conversions this pipeline has to make because GIF cannot
// hold what the rest of the pipeline carries:
//
//   1. **Delays.** `Animation.delaysMs` is milliseconds. GIF's Graphic Control Extension stores
//      centiseconds, so a 33 ms frame has no exact representation and something has to decide what
//      it becomes. `gifDelayCentiseconds` is that decision, in one place, so the encoder asserts
//      against a number this module produced rather than against whatever ImageMagick rounded to.
//   2. **Quality.** §7.4's "`--lossy` derived from quality" does not say what the derivation is.
//      `gifLossyLevel` is it, and the constants it interpolates between are measured — see them.

import type { QualitySettings } from './encode-plan'

/**
 * Raised for a GIF timing or quality value out of range.
 *
 * Deliberately not a `RangeError`: `pipeline/worker.ts` reports any `RangeError` as the machine
 * running out of memory (T23), and an out-of-range frame delay is an upstream bug, not an
 * allocation failure.
 */
export class GifPlanError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'GifPlanError'
  }
}

/**
 * `-O2`, not `-O3` (§7.3: "`-O3` tries every option per frame").
 *
 * Measured in T28 across ten subjects (`verification/t28-gif/results.json`, `summary.optimizeLevels`).
 * `-O1` to `-O2` is the step that matters and is sometimes enormous — 60,613 bytes to 29,441 on the
 * generated scene, 818,272 to 356,857 on the larger one. **`-O3` is smaller on two of the ten**, by
 * 2.8% and 3.7%, and byte-identical on the other eight. Where it wins on the larger subject it costs
 * 1.9x the time (122 ms against 234); on the smaller one the two are 32 ms and 31, which is inside
 * the noise of a measurement that size. Where it wins nothing it still costs — 89 ms against 177 on
 * the photographic animation.
 *
 * So the design's row holds, but not for the reason it gave: the gain is real and small rather than
 * absent, and what rules `-O3` out is paying for it on the eight subjects where there is none.
 */
export const GIF_OPTIMIZE_LEVEL = 2

/**
 * ImageMagick's `animationTicksPerSecond` for everything this path writes: 100, so `animationDelay`
 * is in centiseconds, which is the unit the file itself stores.
 *
 * Deliberately *not* 1000 — the unit the animated WebP writer uses. Setting 1000 and handing over
 * milliseconds produced a file of the same length with the same delays in it (measured), because
 * the writer converts to centiseconds on the way out either way. The difference is only in who
 * rounds: at 1000 it is ImageMagick, silently, by a rule nothing here has tested; at 100 it is
 * `gifDelayCentiseconds`, which is tested and which the encoder then checks the written file
 * against.
 */
export const GIF_TICKS_PER_SECOND = 100

/**
 * How many times `gif.ts` will ask gifsicle for the same file before giving up on it.
 *
 * **gifsicle-wasm-browser loses races, and on WebKit it loses a lot of them.** Its wrapper resolves
 * the run when the WASM module calls its `output` callback, and rejects — with `undefined`, from
 * `n || t()` — when the module's own promise settles first. Nothing orders those two, so which wins
 * is a matter of timing. Measured in T28 on `anim-16f-400.webp` at slider 95, 250 attempts per
 * engine: **Chromium 0 failures, Firefox 0, WebKit 44 — 17.6%**, and in a second run of 80 attempts
 * WebKit failed 18 times, 22.5%. Nine other subjects failed zero times on any engine, so it is a
 * race this particular input happens to make likely rather than a fault in the file.
 *
 * A retry is the right mitigation because the failures are nearly independent: of the 44, an
 * immediate second attempt fixed 36, which is close to the 82% an independent 17.6% predicts.
 *
 * **Verified after the fix**, same subject and slider, 80 runs per engine: **no job failed on any
 * engine.** Chromium and Firefox needed one attempt every time. WebKit needed a second or later
 * attempt 14 times in 80 — a mean of 1.24 attempts, against the 1.29 independence predicts — and
 * exhausted all four **once**, where `gif.ts` fell back to ImageMagick's own GIF rather than failing
 * the job. That 1-in-80 is higher than the 0.4% independence would give, so the attempts are
 * somewhat correlated and raising this number has less effect than the arithmetic suggests; it is
 * still the lever if an unoptimised GIF once per eighty proves too often.
 */
export const GIFSICLE_ATTEMPTS = 4

/** The `--lossy` level at the top of the lossy band, slider 95. */
export const GIF_LOSSY_AT_SLIDER_95 = 20
/** The `--lossy` level at the bottom of the slider, 10. gifsicle's own maximum. */
export const GIF_LOSSY_AT_SLIDER_10 = 200
/** The lowest slider value the panel offers, and the low end of the interpolation. */
const SLIDER_MIN = 10
/** The highest slider value that still takes a lossy pass; above this is R-Q5's lossless band. */
const SLIDER_LOSSY_MAX = 95

/**
 * Milliseconds to the centiseconds a Graphic Control Extension stores.
 *
 * **A non-zero delay never becomes zero.** Nearest-integer rounding alone would turn a 1 ms frame
 * into 0, and 0 is not "no delay" in GIF — it means the file declines to specify one, and viewers
 * substitute a default that is typically 100 ms. A frame asking for 1 ms would then play a hundred
 * times too slowly. Clamping to a single centisecond instead makes it ten times too slow, which is
 * both closer to the request and closer to what every other viewer does with a 1 ms GIF frame.
 *
 * A delay that is *already* zero stays zero, because that is the source saying the same thing the
 * container says, and a GIF read and written unchanged should come back unchanged.
 */
export function gifDelayCentiseconds(delayMs: number): number {
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new GifPlanError(`frame delay must be a whole number of milliseconds, got ${delayMs}`)
  }

  if (delayMs === 0) {
    return 0
  }

  return Math.max(1, Math.round(delayMs / 10))
}

/** `gifDelayCentiseconds` over a whole animation, and the delays the written file should hold. */
export function gifFrameDelays(delaysMs: readonly number[]): {
  centiseconds: number[]
  milliseconds: number[]
} {
  const centiseconds = delaysMs.map((delay) => gifDelayCentiseconds(delay))

  return { centiseconds, milliseconds: centiseconds.map((value) => value * 10) }
}

/**
 * §7.4's "`--lossy` derived from quality", as the derivation. `null` means no lossy pass at all.
 *
 * Above slider 95 there is none, which is R-Q5 and §7.1's "palette preserved, no lossy pass" for
 * GIF. Below it the level runs from 20 to gifsicle's own maximum of 200.
 *
 * **The bottom is 20 because below it the option costs bytes rather than saving them.** gifsicle
 * accepts levels from 1, and the measured curve says not to use them: on every detailed subject in
 * `verification/t28-gif/results.json`, `--lossy` between 1 and 10 produced a file *larger* than
 * `-O2` alone — 678,115 bytes against 624,462 on the photographic animation, 32,676 against 29,441
 * on the scene, 18,548 against 15,533 on the scene fixture. A tiny level perturbs the palette enough
 * to defeat the inter-frame optimisation without merging enough colours to pay for it. 20 is the
 * first level that pays, on four of the five detailed subjects; on the fifth it costs 1.9%.
 *
 * **The scale is geometric, not linear, because size falls logarithmically with the level.** On the
 * larger scene: 328,211 bytes at 20, 260,252 at 40, 197,629 at 100 and 165,540 at 200. A linear map
 * would put a third of the whole size range into the first fifth of the slider's travel and leave
 * the rest of the slider doing almost nothing. Multiplying instead spreads it: slider 95, 80, 60, 40
 * and 10 become levels 20, 30, 52, 89 and 200, and the measured points those fall between — 328,211
 * at 20, 282,223 at 30, 260,252 at 40, 228,710 at 60, 212,139 at 80 and 165,540 at 200 — step
 * evenly across the slider's travel, as a control should.
 *
 * **The top is the library's maximum and that is a deliberate choice about what slider 10 means.**
 * The size curve does *not* flatten out at the top — 150 to 200 is still 15% of the file on the
 * photographic animation and 8% on the real photograph — while the mean channel error climbs only
 * slowly: 7.69 at 150 to 8.22 at 200 on the animation, and 3.53 at 100 to 4.08 at 200 on the
 * photograph. Slider 10 asks for the smallest file the format can give, as it does for JPEG, so it
 * gets it. The error at every level is in the results file so that this can be overruled by someone
 * who would rather it stopped short.
 *
 * `gif.ts` keeps whichever candidate is actually smaller, which is what stops a wrong reading here
 * from ever reaching the user as a file larger than ImageMagick's own.
 */
export function gifLossyLevel(quality: QualitySettings): number | null {
  if (quality.lossless) {
    return null
  }

  const slider = Math.min(SLIDER_LOSSY_MAX, Math.max(SLIDER_MIN, quality.value))
  const position = (SLIDER_LOSSY_MAX - slider) / (SLIDER_LOSSY_MAX - SLIDER_MIN)

  return Math.round(
    GIF_LOSSY_AT_SLIDER_95 * (GIF_LOSSY_AT_SLIDER_10 / GIF_LOSSY_AT_SLIDER_95) ** position,
  )
}

/** The name the command below reads its input under, and the one the encoder must supply it as. */
export const GIFSICLE_INPUT_NAME = 'in.gif'
/**
 * Where gifsicle writes. `/out` is one of the three directories its wrapper mounts, and everything
 * in it is handed back — so the command's last line has to name a path inside it or the run returns
 * nothing at all.
 */
export const GIFSICLE_OUTPUT_PATH = '/out/out.gif'

/**
 * The gifsicle command line, as the single-element array its wrapper takes.
 *
 * Nothing else is passed. In particular there is no `--loopcount` and no `-d`: the loop count and
 * the delays are already in the file ImageMagick wrote, gifsicle preserves both (measured, and
 * asserted again on every encode), and a second opinion about them here would be a second place for
 * them to be wrong.
 */
export function gifsicleCommand(lossy: number | null): string[] {
  const options = [`-O${GIF_OPTIMIZE_LEVEL}`]

  if (lossy !== null) {
    options.push(`--lossy=${lossy}`)
  }

  return [`${options.join(' ')} ${GIFSICLE_INPUT_NAME} -o ${GIFSICLE_OUTPUT_PATH}`]
}
