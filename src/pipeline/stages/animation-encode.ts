// The animated output stages (Technical Design §4.2's `WebP animated` and `PNG animated` rows;
// Functional Design R-F5, R-Q9, R-Q10, R-Q15, R-I12, R-I14, R-I17). One `Animation` in, the
// output file's bytes out.
//
// What to ask each library for is decided in `animation-plan.ts`, which is unit-tested. This module
// only carries those decisions out, and is proven in `tests/e2e/animation.spec.ts` on all three
// engines, because it imports `codecs/loader.ts` (T22's Vitest constraint).
//
//   WebP animated   ImageMagick writes the collection -> put the real frame durations back
//   PNG animated    UPNG assembles -> patch loop/delays -> apng-optimizer -> attach iCCP -> oxipng
//
// Properties this module is responsible for:
//
//   1. **The frame count, the delays and the loop count come out as they went in** (R-Q9, R-Q10),
//      and both encoders are checked against `animation-plan.ts`'s own readers before returning.
//      Neither library can be trusted with all three: ImageMagick's WebP writer replaces any delay
//      under 10 ms with 100 ms, and UPNG hardcodes `acTL.num_plays` to 0 whatever it is asked for.
//   2. **R-Q15 stays lossless throughout.** apng-optimizer's quantizer is disabled; oxipng only
//      refilters and recompresses APNG frames, and the pre-oxipng candidate is kept on a tie or loss.
//   3. **Colour is carried, never converted** (R-I12, R-I14, R-I15). The APNG profile is attached
//      *after* apng-optimizer, which strips one attached before it, and before oxipng, which keeps it
//      (D3, confirmed in T29 and the later APNG recompression pass).
//   4. **No metadata reaches the output** (R-I10, R-I17). Both writers build from raw pixels, and
//      `attachApngIccp` removes anything UPNG or the optimiser added that would contradict the
//      profile or republish a timestamp.
//   5. **The bytes are owned**, asserted, because `pipeline/worker.ts` transfers the result.

import type { Caveat } from '@/domain/types'
import { ensureApngOptimizer, ensureImageMagick, ensureUpng } from '@/pipeline/codecs/loader'
import {
  APNG_MAX_DELAY_MS,
  attachApngIccp,
  apngOptimizerOptions,
  readApngAnimation,
  readWebpAnimation,
  setApngFrameDelays,
  setApngLoopCount,
  setWebpFrameDurations,
} from './animation-plan'
import { EncodeError, UnsupportedColourError } from './encode'
import {
  LOSSLESS_GATE_MAX_COLORS,
  colourPlan,
  countUniqueColors,
  encoderAttempt,
  isOpaque,
  pickSmaller,
  shouldTryLossless,
} from './encode-plan'
import type { EncodeMode, QualitySettings } from './encode-plan'
import { ownsWholeBuffer } from './frame'
import type { Animation } from './frame'
import { optimisePngBytesKeepingSmaller } from './png-optimise'
import { findIccpChunk } from './png-plan'
import type { PngBranch } from './png-plan'

export interface AnimatedEncodeResult {
  bytes: Uint8Array
  /** The report's caveats for this output (R-X46). */
  caveats: Caveat[]
}

export interface AnimatedWebpEncodeResult extends AnimatedEncodeResult {
  /** Which attempt produced `bytes` (R-Q6). */
  mode: EncodeMode
  /** Every attempt actually encoded, in order. The gate's decision is visible here. */
  attempts: EncodeMode[]
  /** The gate's reading, capped at its limit + 1; `null` when the gate did not run. */
  uniqueColors: number | null
}

export interface ApngEncodeResult extends AnimatedEncodeResult {
  /**
   * Always `'lossless'`. Animated PNG has no quantized candidate — see `encodeApng` for why — and
   * the field is kept so the still and animated results read the same way at the call site.
   */
  branch: PngBranch
  /** Size of the file written. Named for symmetry with the still path's two-candidate result. */
  sizes: { lossless: number }
}

type Magick = Awaited<ReturnType<typeof ensureImageMagick>>

/**
 * ImageMagick's `animationDelay` unit for everything this module writes.
 *
 * 1000 ticks per second means the field is milliseconds, which is the unit `ANMF` stores and the
 * unit `Animation.delaysMs` carries, so nothing is rounded on the way in. At the default 100 the
 * writer quantizes every delay to a centisecond: measured on stored durations of
 * `[45, 33, 7, 101, 999, 1]` ms, the file came back `[50, 30, 10, 100, 1000, 100]`.
 */
const WEBP_TICKS_PER_SECOND = 1000

/**
 * The R-Q6 content gate's reading for a whole animation: the highest distinct-colour count among
 * the first, middle and last frames, capped by `countUniqueColors`'s early exit.
 *
 * §7.6 defines the gate over one still frame and says nothing about animations, so the shape of this
 * is a T29 choice, made with the user when they decided R-Q6 applies here.
 *
 * **Three frames rather than one**, because an animation's first frame is not reliably
 * representative — a title card or a fade-in can be far flatter than the footage behind it, and
 * gating on it alone would commit to an expensive lossless encode of *every* frame on the strength
 * of the one frame that looked cheap. **Three rather than all**, because scanning every frame is the
 * per-frame cost the gate exists to avoid. A `Set` of indices means a one- or two-frame animation
 * samples what it has rather than the same frame repeatedly.
 *
 * **The maximum decides**, which errs the way §7.6 asks: skipping a lossless attempt that would have
 * won costs the user bytes, while attempting one that loses costs only time.
 */
function animationUniqueColors(animation: Animation, limit: number): number {
  const count = animation.frames.length
  const indices = new Set<number>([0, Math.floor((count - 1) / 2), count - 1])

  let highest = 0

  for (const index of indices) {
    const frame = animation.frames[index]

    if (frame === undefined) {
      continue
    }

    highest = Math.max(highest, countUniqueColors(frame.pixels, limit))

    // Already past the gate; the remaining samples cannot bring the maximum back down.
    if (highest > limit) {
      break
    }
  }

  return highest
}

/**
 * Encodes an animation as animated WebP.
 *
 * **R-Q6 applies here, decided with the user in T29.** The requirement says "for WebP below quality
 * 96, the app also attempts a lossless encode and keeps whichever result is smaller", and although
 * §7.6 measures and describes the still case throughout — D2's single 1600x1200 frame, a gate
 * `encode-plan.ts` computes over one frame's pixels — the rule is written about WebP, not about
 * still WebP. A GIF converted to animated WebP is exactly the flat, few-colour content R-Q6 wins on,
 * so declining to run it there would forfeit the case the requirement was written for.
 *
 * What §7.6 does not define is the *gate* for an animation, since the cost is one extra encode per
 * frame rather than one. `animationUniqueColors` above is that definition and is a T29 choice.
 */
export async function encodeAnimatedWebp(
  animation: Animation,
  quality: QualitySettings,
): Promise<AnimatedWebpEncodeResult> {
  const first = animation.frames[0]

  if (first === undefined) {
    throw new EncodeError('cannot encode an animation with no frames')
  }

  const plan = colourPlan(first.colour, 'webp')

  // `executeJob` refuses this before decoding; the stage checks too, since it is callable alone.
  if (plan.kind === 'unsupported') {
    throw new UnsupportedColourError(plan.detail)
  }

  const magick = await ensureImageMagick()
  const opaque = animation.frames.every((frame) => isOpaque(frame.pixels))

  const write = (mode: EncodeMode): Uint8Array =>
    writeAnimatedWebp(magick, animation, plan, opaque, encoderAttempt('webp', quality, mode))

  // R-Q5: above 95 the lossless mode is the only one asked for, so there is nothing to compare.
  if (quality.lossless) {
    return finishAnimatedWebp(write('lossless'), animation, 'lossless', ['lossless'], null)
  }

  const lossy = write('lossy')
  const uniqueColors = animationUniqueColors(animation, LOSSLESS_GATE_MAX_COLORS)

  if (!shouldTryLossless(uniqueColors)) {
    return finishAnimatedWebp(lossy, animation, 'lossy', ['lossy'], uniqueColors)
  }

  const lossless = write('lossless')
  // R-Q6, through the same function the still path uses: the smaller is kept, a tie keeps lossless.
  const mode = pickSmaller(lossy.byteLength, lossless.byteLength)

  return finishAnimatedWebp(
    mode === 'lossless' ? lossless : lossy,
    animation,
    mode,
    ['lossy', 'lossless'],
    uniqueColors,
  )
}

/** Puts the durations back, checks R-Q9 and R-Q10 against the bytes, and shapes the result. */
function finishAnimatedWebp(
  written: Uint8Array,
  animation: Animation,
  mode: EncodeMode,
  attempts: EncodeMode[],
  uniqueColors: number | null,
): AnimatedWebpEncodeResult {
  if (written.byteLength === 0) {
    throw new EncodeError('animated WebP encode produced no bytes')
  }

  // The durations ImageMagick could not express. Anything under 10 ms comes out of its writer as
  // 100 ms, so the real values are put back into the `ANMF` chunks, which carry no checksum.
  const bytes = setWebpFrameDurations(written, animation.delaysMs)

  assertAnimatedWebp(bytes, animation)

  return { bytes, caveats: [], mode, attempts, uniqueColors }
}

function writeAnimatedWebp(
  magick: Magick,
  animation: Animation,
  plan: Exclude<ReturnType<typeof colourPlan>, { kind: 'unsupported' }>,
  opaque: boolean,
  attempt: ReturnType<typeof encoderAttempt>,
): Uint8Array {
  const { ImageProfile, MagickFormat, MagickImage, MagickImageCollection, MagickReadSettings } =
    magick

  return MagickImageCollection.use((collection) => {
    for (const [index, frame] of animation.frames.entries()) {
      const settings = new MagickReadSettings({
        format: MagickFormat.Rgba,
        width: frame.width,
        height: frame.height,
        depth: 8,
      })
      // `MagickImage.create` hands back an image the collection takes ownership of. The callback
      // form of `ImageMagick.read` disposes its image on return and the binding then refuses to
      // hand the disposed instance back, so it cannot be used to build a collection.
      const image = MagickImage.create(frame.pixels, settings)

      // A raw RGBA read always has an alpha channel; an animation that is opaque throughout does
      // not need one on any frame.
      if (opaque) {
        image.alpha(magick.AlphaAction.Off)
      }

      image.animationTicksPerSecond = WEBP_TICKS_PER_SECOND
      image.animationDelay = animation.delaysMs[index] as number

      if (attempt.quality !== null) {
        image.quality = attempt.quality
      }

      if (plan.kind === 'profile') {
        image.setProfile(new ImageProfile('icc', plan.profile))
      }

      for (const define of attempt.defines) {
        image.settings.setDefine(MagickFormat[define.format], define.name, define.value)
      }

      collection.push(image)
    }

    // `ANIM.loop_count` is total plays, which is what `Animation.loops` carries, and ImageMagick
    // writes this field through unchanged — measured at 0, 1, 2, 4, 7 and 100. It is read from the
    // first image only.
    const leading = collection[0]

    if (leading !== undefined) {
      leading.animationIterations = animation.loops
    }

    // Indexed by key: `MagickFormat`'s values differ from its keys, and an undefined format still
    // writes bytes, in the wrong format, without an error (T23).
    return collection.write(MagickFormat.WebP, (data) => data.slice())
  })
}

/** Everything R-Q9 and R-Q10 promise, read back out of the file that was just written. */
function assertAnimatedWebp(bytes: Uint8Array, animation: Animation): void {
  if (!ownsWholeBuffer(bytes)) {
    throw new EncodeError('encoded bytes are a view onto codec memory, not an owned buffer')
  }

  const written = readWebpAnimation(bytes)

  if (written.frameCount !== animation.frames.length) {
    throw new EncodeError(
      `wrote ${written.frameCount} frames for an animation of ${animation.frames.length} (R-Q10)`,
    )
  }

  const delays = written.frames.map((frame) => frame.delayMs)

  if (delays.some((delay, index) => delay !== animation.delaysMs[index])) {
    throw new EncodeError(
      `wrote delays [${delays.join(', ')}] for [${animation.delaysMs.join(', ')}] (R-Q9)`,
    )
  }

  if (written.loops !== animation.loops) {
    throw new EncodeError(`wrote loop count ${written.loops} for ${animation.loops} (R-Q9)`)
  }
}

/**
 * The `iCCP` chunk for a profile, borrowed from ImageMagick's PNG writer.
 *
 * Building one from scratch would need a deflate implementation; round-tripping the whole animation
 * through ImageMagick to get one would be absurd. So a **1x1** PNG is written with the profile
 * attached and its chunk is lifted whole — header and CRC together, never re-encoded — exactly as
 * `png.ts` lifts it from the real image on the still path. D3's "the profile survives ImageMagick's
 * PNG writer" therefore covers this too.
 */
function iccpChunkFor(magick: Magick, profile: Uint8Array): Uint8Array {
  const { ImageMagick, ImageProfile, MagickFormat, MagickReadSettings } = magick
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: 1,
    height: 1,
    depth: 8,
  })

  const carrier = ImageMagick.read(new Uint8Array([0, 0, 0, 255]), settings, (image) => {
    image.setProfile(new ImageProfile('icc', profile))
    return image.write(MagickFormat.Png, (data) => data.slice())
  })

  const chunk = findIccpChunk(carrier)

  if (chunk === null) {
    throw new EncodeError('ImageMagick wrote no iCCP chunk for a frame that carries a profile')
  }

  return chunk
}

/**
 * Encodes an animation as APNG. **Always losslessly — there is no quantized candidate here.**
 *
 * §4.2's animated-PNG row is assemble, then optimise. The still path (T27) additionally quantizes
 * and compares, and this path deliberately does not, which is a departure from §7.1's "PNG, still or
 * animated … quantization via libimagequant, rescaled per R-Q11" and is recorded as such.
 *
 * **Why.** R-Q11's floor is a guarantee on the still path only because libimagequant *aborts* when
 * it cannot reach it — the mapped value is its `minimum`, and an image that cannot meet it keeps the
 * lossless PNG. apng-optimizer wraps the same library but exposes no refusal: `minQuality` is a
 * request it neither meets nor reports on. Measured on an 8-frame 200x200 photographic APNG,
 * `minQuality` of 50, 70, 90, 99 and 100 all returned the *same* 101,349-byte file, and
 * `minQuality: 10` returned 236,609 bytes — 5.6x the lossless branch's 42,411 — with nothing raised.
 *
 * So a quantized candidate here would be quantized to an unknown quality at every slider position.
 * R-Q14's `pickSmaller` would stop the user receiving a *larger* file, but nothing would stop it
 * banding, which is the precise outcome R-Q11 exists to prevent (P1). Keeping the floor's intent by
 * removing the only path that can violate it is the honest reading, and it also halves the work:
 * `optAPNG` runs once per animation rather than twice.
 *
 * Decided with the user, T29. R-Q11 and R-Q12 still govern the **still** PNG path unchanged.
 *
 * The remaining order is forced by measurement at both ends. The loop count is patched **before**
 * the APNG-specific optimiser because `optAPNG` carries `acTL` through unchanged (measured: 3 in,
 * 3 out), the profile is attached **after** it because it strips one that is there beforehand, and
 * oxipng runs last because its APNG support preserves the finished control/profile chunk set while
 * losslessly refiltering and recompressing frame payloads.
 */
export async function encodeApng(animation: Animation): Promise<ApngEncodeResult> {
  const first = animation.frames[0]

  if (first === undefined) {
    throw new EncodeError('cannot encode an animation with no frames')
  }

  const plan = colourPlan(first.colour, 'png')

  if (plan.kind === 'unsupported') {
    throw new UnsupportedColourError(plan.detail)
  }

  if (plan.kind === 'defines') {
    // PNG has no define this build honours — it writes no `cICP` chunk whatever it is told (T27).
    throw new EncodeError('PNG output cannot carry colour as encoder defines')
  }

  const [magick, UPNG, optimizer] = await Promise.all([
    ensureImageMagick(),
    ensureUpng(),
    ensureApngOptimizer(),
  ])

  const width = first.width
  const height = first.height
  const assembled = new Uint8Array(
    UPNG.encode(
      // `assertUniformAnimation` has already established that every frame owns its whole buffer,
      // so this is the frame's own pixels and not a window onto something larger. The cast is for
      // `ArrayBufferLike`, which `Uint8Array.buffer` is typed as and which admits `SharedArrayBuffer`.
      animation.frames.map((frame) => frame.pixels.buffer as ArrayBuffer),
      width,
      height,
      // `cnum: 0` is UPNG's lossless mode. Quantization is apng-optimizer's job on the branch that
      // wants it (A6, §7.1), so the assembler never does any of its own.
      0,
      animation.delaysMs,
    ),
  )

  if (assembled.byteLength === 0) {
    throw new EncodeError('UPNG produced no bytes')
  }

  // UPNG writes `delay_num` as a uint16 with `delay_den` fixed at 1000, so a delay past 65,535 ms
  // wraps silently — 65,536 would be written as 0. A GIF may legally ask for ten times that. Only
  // rewritten when it is needed, so the ordinary animation pays nothing.
  const timed = animation.delaysMs.some((delay) => delay > APNG_MAX_DELAY_MS)
    ? setApngFrameDelays(assembled, animation.delaysMs)
    : assembled

  // UPNG hardcodes `acTL.num_plays` to 0 — every animation it writes loops for ever until this runs.
  const source = setApngLoopCount(timed, animation.loops)
  const iccp = plan.kind === 'profile' ? iccpChunkFor(magick, plan.profile) : null

  const optimised = new Uint8Array(await optimizer.optAPNG(source, apngOptimizerOptions()))

  if (optimised.byteLength === 0) {
    throw new EncodeError('apng-optimizer produced no bytes')
  }

  // After the APNG-specific optimiser, never before: it strips an `iCCP` from the file it is given.
  // Oxipng goes last. Its APNG support is intentionally limited to lossless refiltering and
  // recompression, which complements rather than replaces the structural optimiser above.
  const profiled = attachApngIccp(optimised, iccp)
  const bytes = await optimisePngBytesKeepingSmaller(profiled)

  assertApng(bytes, animation)

  return {
    bytes,
    branch: 'lossless',
    // No `png-quantized` caveat can arise here: nothing on this path quantizes. The caveat stays
    // correct for the still path, where it means what R-X46 says it means.
    caveats: [],
    sizes: { lossless: bytes.byteLength },
  }
}

/** Everything R-Q9 and R-Q10 promise, read back out of the file that was just written. */
function assertApng(bytes: Uint8Array, animation: Animation): void {
  if (!ownsWholeBuffer(bytes)) {
    throw new EncodeError('encoded bytes are a view onto codec memory, not an owned buffer')
  }

  const written = readApngAnimation(bytes)

  if (written.frameCount !== animation.frames.length) {
    throw new EncodeError(
      `wrote ${written.frameCount} frames for an animation of ${animation.frames.length} (R-Q10)`,
    )
  }

  const delays = written.frames.map((frame) => frame.delayMs)

  if (delays.some((delay, index) => delay !== animation.delaysMs[index])) {
    throw new EncodeError(
      `wrote delays [${delays.join(', ')}] for [${animation.delaysMs.join(', ')}] (R-Q9)`,
    )
  }

  if (written.loops !== animation.loops) {
    throw new EncodeError(`wrote loop count ${written.loops} for ${animation.loops} (R-Q9)`)
  }
}
