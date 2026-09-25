// The GIF output stage (Technical Design §4.2's `GIF` row, §7.3, §7.4; Functional Design R-Q8,
// R-Q9, R-Q10, R-I12). One `Animation` in, the file's bytes out.
//
//   ImageMagick writes the GIF  ->  gifsicle optimises it  ->  keep whichever is smaller
//
// What to ask each library for is decided in `gif-plan.ts`, which is unit-tested. This module only
// carries those decisions out, and is proven in `tests/e2e/gif.spec.ts` on all three engines,
// because it imports `codecs/loader.ts` (T22's Vitest constraint).
//
// **Still images come through here too**, as a one-frame animation (`singleFrameAnimation`). GIF is
// the one format where that costs nothing: gifsicle takes a GIF and returns a GIF whether or not it
// moves, and one path means one set of assertions rather than two that drift.
//
// Properties this module is responsible for:
//
//   1. **R-Q8's reason for existing is checked, not assumed.** gifsicle is here because its output
//      is "substantially smaller", so both candidates are measured and `sizes` reports both. On the
//      ten-frame scene fixture ImageMagick alone writes 93,634 bytes and gifsicle brings it to
//      15,533 — the writer emits every frame in full, and finding what is unchanged between frames
//      is the whole of gifsicle's `-O2`.
//   2. **The frame count, the delays and the loop count survive** (R-Q9, R-Q10), checked against
//      `animation-plan.ts`'s own GIF reader after gifsicle has run — not against ImageMagick, and
//      not against gifsicle's word for it.
//   3. **The user never receives the larger file.** Under `--lossy` 20 the option can *cost* bytes
//      (measured; see `gifLossyLevel`), so the unoptimised candidate is kept when it wins. That is
//      strictly better on both axes at once: smaller *and* untouched by the lossy pass.
//   4. **Colour is carried, never converted** (R-I12, R-I15) — see `ColourFormat` for why a GIF can
//      carry a profile in this build even though R-I13 says it cannot.
//   5. **The bytes are owned**, asserted, because `pipeline/worker.ts` transfers the result.
//   6. **A flaky optimiser never costs the user their image.** gifsicle fails about one run in five
//      on WebKit for reasons that have nothing to do with the file (see `GIFSICLE_ATTEMPTS`), so it
//      is asked again, and if it never answers the job keeps ImageMagick's own GIF. A larger file is
//      a worse outcome than a smaller one and a far better outcome than no file at all.

import type { Caveat } from '@/domain/types'
import { ensureGifsicle, ensureImageMagick } from '@/pipeline/codecs/loader'
import { gifTotalPlays, readGifAnimation } from './animation-plan'
import { EncodeError, UnsupportedColourError } from './encode'
import { colourPlan } from './encode-plan'
import type { QualitySettings } from './encode-plan'
import { ownsWholeBuffer } from './frame'
import type { Animation } from './frame'
import {
  GIFSICLE_ATTEMPTS,
  GIFSICLE_INPUT_NAME,
  GIF_TICKS_PER_SECOND,
  gifFrameDelays,
  gifLossyLevel,
  gifsicleCommand,
} from './gif-plan'

/** Which of the two candidates the returned bytes are. */
export type GifBranch = 'gifsicle' | 'imagemagick'

export interface GifEncodeResult {
  bytes: Uint8Array
  /**
   * The candidate kept. `'imagemagick'` means gifsicle's output was not smaller — or, when
   * `sizes.gifsicle` is `null`, that gifsicle never produced one (rules 3 and 6 above).
   */
  branch: GifBranch
  /** The `--lossy` level asked for, or `null` above slider 95 where R-Q5 asks for no lossy pass. */
  lossy: number | null
  /**
   * Both candidates' sizes, so the reason for the choice is visible to a test and to a harness.
   * `gifsicle` is `null` when every attempt failed.
   */
  sizes: { imagemagick: number; gifsicle: number | null }
  /** How many times gifsicle was asked. More than one means it failed and was retried (rule 6). */
  gifsicleAttempts: number
  /** The report's caveats for this output (R-X46). */
  caveats: Caveat[]
}

type Magick = Awaited<ReturnType<typeof ensureImageMagick>>

/**
 * Encodes an animation — or a single frame, via `singleFrameAnimation` — as a GIF.
 *
 * The delays written are `gif-plan.ts`'s, in centiseconds, and the loop count is handed to
 * ImageMagick as **total plays**: `animationIterations` is the field's own unit there, and the
 * writer converts to NETSCAPE2.0's additional-repeats convention itself. Measured across the range
 * (T28): 0 writes a block holding 0, 2 writes one holding 1, 4 writes one holding 3, and **1 writes
 * no block at all**, which is right — a GIF that plays once is a GIF with no loop record.
 */
export async function encodeGif(
  animation: Animation,
  quality: QualitySettings,
): Promise<GifEncodeResult> {
  const first = animation.frames[0]

  if (first === undefined) {
    throw new EncodeError('cannot encode an animation with no frames')
  }

  const plan = colourPlan(first.colour, 'gif')

  // `executeJob` refuses this before decoding; the stage checks too, since it is callable alone.
  if (plan.kind === 'unsupported') {
    throw new UnsupportedColourError(plan.detail)
  }

  if (plan.kind === 'defines') {
    // Unreachable: `colourPlan` only returns defines for AVIF. Stated rather than assumed, because
    // silently writing a GIF with the colour dropped is the failure this guard exists to prevent.
    throw new EncodeError('GIF output cannot carry colour as encoder defines')
  }

  const magick = await ensureImageMagick()
  const gifsicle = await ensureGifsicle()
  const delays = gifFrameDelays(animation.delaysMs)
  const written = writeGif(magick, animation, plan, delays.centiseconds)

  if (written.byteLength === 0) {
    throw new EncodeError('GIF encode produced no bytes')
  }

  const lossy = gifLossyLevel(quality)
  const optimised = await runGifsicle(gifsicle, written, lossy)

  // Rule 3: gifsicle is here to make the file smaller, so when it has not — or when it never came
  // back at all — it has not earned the output. A tie keeps ImageMagick's, which under `--lossy` is
  // also the one that kept its pixels.
  const branch: GifBranch =
    optimised.bytes !== null && optimised.bytes.byteLength < written.byteLength
      ? 'gifsicle'
      : 'imagemagick'
  const bytes = branch === 'gifsicle' ? (optimised.bytes as Uint8Array) : written

  assertGif(bytes, animation, delays.milliseconds)

  return {
    bytes,
    branch,
    lossy,
    sizes: {
      imagemagick: written.byteLength,
      gifsicle: optimised.bytes === null ? null : optimised.bytes.byteLength,
    },
    gifsicleAttempts: optimised.attempts,
    caveats: [],
  }
}

function writeGif(
  magick: Magick,
  animation: Animation,
  plan: Extract<ReturnType<typeof colourPlan>, { kind: 'profile' } | { kind: 'none' }>,
  delaysCs: number[],
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
      // `MagickImage.create` hands back an image the collection takes ownership of; the callback
      // form of `ImageMagick.read` disposes its image on return (see `animation-encode.ts`).
      const image = MagickImage.create(frame.pixels, settings)

      image.animationTicksPerSecond = GIF_TICKS_PER_SECOND
      image.animationDelay = delaysCs[index] as number

      if (plan.kind === 'profile') {
        image.setProfile(new ImageProfile('icc', plan.profile))
      }

      collection.push(image)
    }

    // Read from the first image only, and in total plays — see this function's caller.
    const leading = collection[0]

    if (leading !== undefined) {
      leading.animationIterations = animation.loops
    }

    // Indexed by key: `MagickFormat`'s values differ from its keys, and an undefined format still
    // writes bytes, in the wrong format, without an error (T23).
    return collection.write(MagickFormat.Gif, (data) => data.slice())
  })
}

/**
 * gifsicle, asked up to `GIFSICLE_ATTEMPTS` times, returning `null` when it never came back.
 *
 * **The retry is not defensive programming; it is a measured 22.5% failure rate on WebKit.** The
 * wrapper's resolve and its reject race each other, and `GIFSICLE_ATTEMPTS` carries the figures.
 * Nothing about the input changes between attempts — the same bytes and the same command go in each
 * time — because a retry that changed something would be a different measurement.
 *
 * Every way the wrapper has of not returning a GIF counts as a failed attempt, and none of them is a
 * thrown `Error`: it *resolves* `null` when its internal Worker raises `onerror`, *rejects with a
 * string* when gifsicle writes to stderr under `isStrict`, *rejects with `undefined`* when its own
 * promise settles before the output arrives, and resolves an empty array when the command wrote
 * nothing into `/out`. A caller that only caught `Error` would read the first as success.
 */
async function runGifsicle(
  gifsicle: Awaited<ReturnType<typeof ensureGifsicle>>,
  source: Uint8Array,
  lossy: number | null,
): Promise<{ bytes: Uint8Array | null; attempts: number }> {
  for (let attempt = 1; attempt <= GIFSICLE_ATTEMPTS; attempt += 1) {
    const bytes = await attemptGifsicle(gifsicle, source, lossy)

    if (bytes !== null) {
      return { bytes, attempts: attempt }
    }
  }

  return { bytes: null, attempts: GIFSICLE_ATTEMPTS }
}

/** One pass. `null` for every shape of failure — see `runGifsicle` for what those are. */
async function attemptGifsicle(
  gifsicle: Awaited<ReturnType<typeof ensureGifsicle>>,
  source: Uint8Array,
  lossy: number | null,
): Promise<Uint8Array | null> {
  const command = gifsicleCommand(lossy)
  const files = await gifsicle
    .run({
      // The buffer itself, not a copy of it. The wrapper posts its input to its Worker with no
      // transfer list, so the bytes are cloned rather than detached and `source` is still usable
      // here afterwards as the candidate to compare against — which matters, because on a large
      // still this is megabytes. The guard is for the case that is not true: a `Uint8Array` that is
      // a window onto something larger would hand gifsicle the wrong bytes entirely.
      input: [
        {
          // The cast is for `ArrayBufferLike`, which `Uint8Array.buffer` is typed as and which
          // admits `SharedArrayBuffer` — the same cast `animation-encode.ts` makes for UPNG.
          file: (ownsWholeBuffer(source) ? source.buffer : source.slice().buffer) as ArrayBuffer,
          name: GIFSICLE_INPUT_NAME,
        },
      ],
      command,
    })
    .catch(() => null)

  const output = files?.[0]

  return output === undefined ? null : new Uint8Array(await output.arrayBuffer())
}

/** Everything R-Q9 and R-Q10 promise, read back out of the file that is about to be returned. */
function assertGif(bytes: Uint8Array, animation: Animation, delaysMs: number[]): void {
  if (!ownsWholeBuffer(bytes)) {
    throw new EncodeError('encoded bytes are a view onto codec memory, not an owned buffer')
  }

  const written = readGifAnimation(bytes)

  if (written.frameCount !== animation.frames.length) {
    throw new EncodeError(
      `wrote ${written.frameCount} frames for an animation of ${animation.frames.length} (R-Q10)`,
    )
  }

  const delays = written.frames.map((frame) => frame.delayMs)

  // Against `gif-plan.ts`'s centiseconds, not against `animation.delaysMs`: GIF cannot hold a delay
  // that is not a whole centisecond, and the conversion is this pipeline's, made where it can be
  // tested. Asserting the millisecond original here would demand of the container something the
  // container has never been able to do.
  if (delays.some((delay, index) => delay !== delaysMs[index])) {
    throw new EncodeError(`wrote delays [${delays.join(', ')}] for [${delaysMs.join(', ')}] (R-Q9)`)
  }

  // The reader reports what the block stores; `gifTotalPlays` is the one place that becomes plays.
  const plays = gifTotalPlays(written.loopSignal)

  if (plays !== animation.loops) {
    throw new EncodeError(`wrote ${plays} total plays for ${animation.loops} (R-Q9)`)
  }
}
