// The animated input stages (Technical Design §4.2's `decode-frames`, `edit-frames` and
// `resize-frames` rows; Functional Design R-F5, R-Q9, R-Q10, R-B6, R-C6, R-C16). Source bytes in,
// an upright, coalesced `Animation` out, then the same edit and resize the still path runs, per
// frame.
//
// What to ask the containers is decided in `animation-plan.ts`, which is unit-tested. This module
// only carries those decisions out, and is proven in `tests/e2e/animation.spec.ts` on all three
// engines, because it imports `codecs/loader.ts` (T22's Vitest constraint).
//
// **There are two decoders, not one, and that is measured rather than chosen.** ImageMagick's WASM
// build returns *one* frame from a six-frame APNG and raises nothing — `readCollection` is no better
// than `read` here, which is D6's silent-truncation risk arriving in the collection reader as well.
// So:
//
//   GIF, WebP   ImageMagick.readCollection -> coalesce() -> one frame's pixels at a time
//   APNG        UPNG.decode -> UPNG.toRGBA8, which composites dispose/blend itself
//
// Properties this module is responsible for:
//
//   1. **Frames are coalesced, full-canvas and upright.** See `Animation` in `frame.ts` for why
//      that is worth its memory, and C7 for what the memory turns out to be.
//   2. **Nothing but pixels comes from ImageMagick.** The frame count, the delays and the loop
//      count are all read from the container by `animation-plan.ts`. The delays have to be:
//      ImageMagick reports WebP durations in whole centiseconds, so `[45, 33, 7, 101, 999, 1]` ms
//      comes back as `[50, 30, 10, 100, 1000, 0]` and the rounding cannot be undone. The loop count
//      has to be too, and then converted: GIF stores repeats-after-the-first, WebP and APNG store
//      total plays, and `Animation.loops` is total plays throughout.
//   3. **Colour and orientation are read where the decoder can actually see them.** ImageMagick's
//      WebP coder reports neither `ICCP` nor `EXIF` for an *animated* file, though it reports both
//      for a still one (measured, T29) — so those are lifted out of the RIFF container. An APNG's
//      are read with `MagickImageCollection.ping`, which surfaces `eXIf` and the whole `iCCP`
//      without decoding a pixel.
//   4. **Editing is refused, not ignored** (R-C6, R-C16). The Edit action is not offered for an
//      animated source, so a non-null edit arriving here is a bug upstream and says so.
//   5. **Caveats are per animation, not per frame.** Six frames flattened against the same
//      background is one thing that happened to the image, and the report says it once.
//   6. **The frames own their buffers**, asserted after every stage, because `pipeline/worker.ts`
//      transfers results and a view onto a codec heap would detach that heap.

import { classify } from '@/domain/classify'
import type { AlphaHandling, Caveat, EditRecord, ResolvedDimension } from '@/domain/types'
import { ensureImageMagick, ensureUpng } from '@/pipeline/codecs/loader'
import {
  AnimationFormatError,
  gifTotalPlays,
  readApngAnimation,
  readGifAnimation,
  readWebpAnimation,
  readWebpIccProfile,
  readWebpOrientation,
} from './animation-plan'
import type { AnimationInfo } from './animation-plan'
import { resolveFrameColour } from './colour'
import { DecodeError } from './decode'
import { applyEdit } from './edit'
import { assertUniformAnimation, classifySourceOrientation, ownsWholeBuffer } from './frame'
import type { Animation, Frame, FrameColour, SourceOrientation } from './frame'
import { applyResize } from './resize'

/**
 * Raised when an animated source cannot be decoded.
 *
 * Extends `DecodeError` so `pipeline/worker.ts` reports it as `decode-failed` — the file is what
 * went wrong, not the encoder — without that mapping having to learn a second error class.
 */
export class AnimationDecodeError extends DecodeError {
  constructor(detail: string) {
    super(detail)
    this.name = 'AnimationDecodeError'
  }
}

/**
 * Raised when a stage is asked for something the pipeline should never have asked for.
 *
 * Deliberately **not** an `AnimationDecodeError`. `pipeline/worker.ts` maps `DecodeError` to
 * `decode-failed`, which the report shows the user as a corrupt or undecodable file (§10) — and
 * telling someone their animation is broken when the fault is ours is the kind of wrong message
 * P1 exists to prevent. This falls into the worker's generic bucket instead, which says the job
 * failed without blaming the file.
 */
export class AnimationStageError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'AnimationStageError'
  }
}

/**
 * Runs a container reader, turning a parse failure into a decode failure.
 *
 * `animation-plan.ts` raises `AnimationFormatError` for a truncated or malformed container, which is
 * exactly "the file is not what it claims" — a decode failure. Without this it would reach
 * `worker.ts` as an unrecognised error and be reported as an *encode* failure, blaming a stage that
 * never ran.
 */
function readContainer<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof AnimationFormatError) {
      throw new AnimationDecodeError(error.message)
    }

    throw error
  }
}

export interface EditFramesResult {
  animation: Animation
  /** At most one `transparency-flattened`, however many frames were flattened. */
  caveats: Caveat[]
}

type Magick = Awaited<ReturnType<typeof ensureImageMagick>>

/** What the source container said about itself, before any pixel is touched. */
interface SourceMetadata {
  colour: FrameColour
  orientation: SourceOrientation
}

/**
 * Reads an APNG's colour and orientation with `ping`, which parses the chunks and allocates no
 * pixels.
 *
 * ImageMagick's *still* PNG reader understands `eXIf` and `iCCP` perfectly well — it is only the
 * frames it cannot see — so this is the one place the animated PNG path can borrow it. Measured on
 * a hand-built APNG carrying both: `ping` returned orientation 6 and the full 6,668-byte profile,
 * description intact.
 */
function pingPngMetadata(magick: Magick, source: Uint8Array): SourceMetadata {
  const { MagickImageCollection } = magick

  return MagickImageCollection.use((collection) => {
    collection.ping(source)

    const image = collection[0]

    if (image === undefined) {
      return { colour: { kind: 'untagged' } as FrameColour, orientation: { kind: 'absent' } }
    }

    const profile = image.getColorProfile()

    return {
      // Copied, not referenced, for the reason `decode.ts` spells out: `getColorProfile()` hands
      // back a live window onto ImageMagick's heap, which goes stale the moment the image is
      // disposed and whose `.buffer` is the whole heap rather than the profile.
      colour: resolveFrameColour(
        profile
          ? { profile: new Uint8Array(profile.data), description: profile.description }
          : null,
        source,
      ),
      orientation: classifySourceOrientation(image.orientation),
    }
  })
}

/**
 * Applies an EXIF orientation to already-decoded RGBA frames, or returns them untouched.
 *
 * A **no-op unless the source carried a tag asking for a transform**: absent and
 * present-and-upright both mean the pixels are already right, and the common case must not pay for
 * an extra ImageMagick round trip per frame. When there is a transform to do it is ImageMagick's
 * `autoOrient()` that does it, one frame at a time — the implementation D4 measured correct for all
 * eight values, including the four mirrored ones that a quarter-turn helper cannot express.
 *
 * Orienting happens **after** coalescing, and that order is forced: coalescing composites frames in
 * the container's stored canvas geometry, so a frame rotated first would be pasted at the wrong
 * offset and the animation would come apart.
 */
function orientFrames(
  magick: Magick,
  frames: { width: number; height: number; pixels: Uint8Array }[],
  orientation: SourceOrientation,
): { width: number; height: number; pixels: Uint8Array }[] {
  if (orientation.kind === 'absent' || orientation.value === 1) {
    return frames
  }

  const { ImageMagick, MagickFormat, MagickReadSettings } = magick
  const value = orientation.value

  return frames.map((frame) => {
    const settings = new MagickReadSettings({
      format: MagickFormat.Rgba,
      width: frame.width,
      height: frame.height,
      depth: 8,
    })

    return ImageMagick.read(frame.pixels, settings, (image) => {
      image.orientation = value
      image.autoOrient()

      const pixels = image.getPixels((collection) =>
        collection.toByteArray(0, 0, image.width, image.height, 'RGBA'),
      )

      if (pixels === null) {
        throw new AnimationDecodeError('ImageMagick returned no pixels while orienting a frame')
      }

      return { width: image.width, height: image.height, pixels }
    })
  })
}

/** Asserts the two things `decode.ts` asserts of a still frame, for one frame of an animation. */
function assertFramePixels(pixels: Uint8Array, width: number, height: number, index: number): void {
  if (!ownsWholeBuffer(pixels)) {
    throw new AnimationDecodeError(
      `frame ${index} is a view onto codec memory, not an owned buffer`,
    )
  }

  if (pixels.byteLength !== width * height * 4) {
    throw new AnimationDecodeError(
      `frame ${index} decoded ${pixels.byteLength} bytes for a ${width}x${height} RGBA frame`,
    )
  }
}

/**
 * GIF and WebP, through ImageMagick's collection reader. **Pixels only.**
 *
 * Every number — the frame count, the delays, the loop count — comes from the container reader in
 * `animation-plan.ts` rather than from ImageMagick, and the delays are the reason that rule had to
 * become absolute.
 *
 * **ImageMagick cannot report a WebP delay that is not a whole centisecond.** It exposes
 * `animationDelay` in `animationTicksPerSecond` units and reports 100 ticks for WebP, where the
 * container stores milliseconds directly in a 24-bit `ANMF` field — so the value has already been
 * rounded by the time it can be read, and the rounding is not recoverable. Measured on a WebP whose
 * stored durations are `[45, 33, 7, 101, 999, 1]` ms: ImageMagick returns `[50, 30, 10, 100, 1000,
 * 0]`. Every 30 fps animation would play about 10% fast and a 1 ms frame would become a 0 ms one.
 * R-Q9 says delays are preserved through every animated path, so they are read from the bytes.
 *
 * GIF is centisecond-native and ImageMagick's answer is exact there, but it is read from the
 * container too: one source of truth is worth more than a second code path that happens to agree.
 *
 * Each frame's pixels are lifted and its `MagickImage` disposed immediately. **That does not lower
 * the peak, and the comment says so because the next person to read it will want to quote it as a
 * mitigation.** Measured in T29 at 64 frames of 400x400, the same loop with and without the dispose:
 * ImageMagick's heap growth is **byte-identical at 55,771,136 either way on all three engines**,
 * which is the evidence — the RSS figures (+90.2 against +90.9 MB on Chromium, +104.3 against
 * +104.1 on Firefox, +115.1 against +110.8 on WebKit) cannot resolve a difference of that size in
 * either direction at one run per cell. The reason is structural: `coalesce()` materialises every
 * frame inside ImageMagick *before* the first pixel is extracted, so the peak has been paid before
 * there is anything to dispose. R-B6's "wherever the format allows it" is, for this decoder,
 * nowhere; C7 is refuted and carries the numbers. The dispose stays because it costs nothing and
 * shortens the window in which both copies are live, not because it lowers the peak.
 */
function decodeCollection(
  magick: Magick,
  source: Uint8Array,
  info: AnimationInfo,
  loops: number,
  orientation: SourceOrientation,
  colour: FrameColour,
): Animation {
  const { ImageMagick } = magick

  return ImageMagick.readCollection(source, (collection) => {
    if (collection.length === 0) {
      throw new AnimationDecodeError('ImageMagick read no frames from the animation')
    }

    // What the container says it holds against what the decoder produced. `decodeApng` makes the
    // same check; without it here, a decoder that dropped a frame would be a silent R-Q10 violation
    // — the delays would still line up, because both lists would be short by the same one.
    if (collection.length !== info.frameCount) {
      throw new AnimationDecodeError(
        `ImageMagick read ${collection.length} frames from a container that declares ${info.frameCount}`,
      )
    }

    // Every frame becomes the full canvas as it appears on screen at that moment. Without this a
    // frame that stores only what changed would be resized and re-encoded as if it were the whole
    // picture.
    collection.coalesce()

    const decoded: { width: number; height: number; pixels: Uint8Array }[] = []

    for (const [index, image] of collection.entries()) {
      const width = image.width
      const height = image.height
      const pixels = image.getPixels((pixelCollection) =>
        pixelCollection.toByteArray(0, 0, width, height, 'RGBA'),
      )

      if (pixels === null) {
        throw new AnimationDecodeError(`ImageMagick returned no pixels for frame ${index}`)
      }

      assertFramePixels(pixels, width, height, index)
      decoded.push({ width, height, pixels })

      // See the note on this function: this does not lower the peak, because coalesce has already
      // materialised every frame. It is kept because it is free.
      image.dispose()
    }

    return toAnimation(
      orientFrames(magick, decoded, orientation),
      info.frames.map((frame) => frame.delayMs),
      loops,
      colour,
      orientation,
    )
  })
}

/**
 * APNG, through UPNG.
 *
 * `toRGBA8` returns one owned `ArrayBuffer` per frame, already composited through the file's own
 * `dispose_op` and `blend_op` — so this path arrives at the same coalesced, full-canvas frames the
 * collection path does, by a different route.
 *
 * The delays and the loop count come from `readApngAnimation`, not from UPNG's own parse, so that
 * what the tests assert and what the pipeline uses are the same numbers from the same reader.
 */
async function decodeApng(
  magick: Magick,
  source: Uint8Array,
  loops: number,
  delaysMs: number[],
  metadata: SourceMetadata,
): Promise<Animation> {
  const UPNG = await ensureUpng()
  // A fresh `ArrayBuffer`: UPNG indexes the buffer from zero and would read the wrong bytes from a
  // view that starts partway into one.
  const image = UPNG.decode(source.slice().buffer)
  const buffers = UPNG.toRGBA8(image)

  if (buffers.length !== delaysMs.length) {
    throw new AnimationDecodeError(
      `UPNG produced ${buffers.length} frames for an APNG whose fcTL chunks number ${delaysMs.length}`,
    )
  }

  const decoded = buffers.map((buffer, index) => {
    const pixels = new Uint8Array(buffer)

    assertFramePixels(pixels, image.width, image.height, index)

    return { width: image.width, height: image.height, pixels }
  })

  return toAnimation(
    orientFrames(magick, decoded, metadata.orientation),
    delaysMs,
    loops,
    metadata.colour,
    metadata.orientation,
  )
}

function toAnimation(
  frames: { width: number; height: number; pixels: Uint8Array }[],
  delaysMs: number[],
  loops: number,
  colour: FrameColour,
  sourceOrientation: SourceOrientation,
): Animation {
  const animation: Animation = {
    frames: frames.map((frame) => ({ ...frame, colour, sourceOrientation })),
    delaysMs,
    loops,
  }

  assertUniformAnimation(animation)

  return animation
}

/**
 * Decodes an animated source to coalesced, upright RGBA frames.
 *
 * `source` is the raw file, exactly as the job carries it — the loop count, the ICC profile and the
 * EXIF orientation are all read out of the container here, and a re-encoded copy is where each of
 * them gets dropped.
 *
 * A single-frame file is refused. `domain/classify.ts` is what decides whether a file is animated,
 * and a one-frame GIF belongs on the still path (R-F5 is about sources that *have* animation to
 * keep); silently animating one frame would produce a WebP that says "animation" for no reason.
 */
export async function decodeAnimation(source: Uint8Array): Promise<Animation> {
  const classification = classify(source)

  if (classification.class !== 'supported') {
    throw new AnimationDecodeError(`source is not a supported image (${classification.class})`)
  }

  if (!classification.isAnimated) {
    throw new AnimationDecodeError(
      `source is a single-frame ${classification.format}; it belongs on the still path`,
    )
  }

  const magick = await ensureImageMagick()

  switch (classification.format) {
    case 'gif': {
      const info = readContainer(() => readGifAnimation(source))

      // GIF carries no colour profile and no orientation: the format has nowhere to put either.
      // This is `untagged` by the specification rather than by an unanswered question.
      //
      // `gifTotalPlays` is the one conversion in the animated paths. GIF's NETSCAPE2.0 block counts
      // repeats *after* the first play; WebP and APNG count total plays. Passing the stored number
      // through would make a GIF seen four times into a WebP seen three.
      return decodeCollection(
        magick,
        source,
        info,
        gifTotalPlays(info.loopSignal),
        { kind: 'absent' },
        { kind: 'untagged' },
      )
    }
    case 'webp': {
      const info = readContainer(() => readWebpAnimation(source))
      const profile = readContainer(() => readWebpIccProfile(source))

      // `ANIM.loop_count` is already total plays, so it is carried as it stands.
      return decodeCollection(
        magick,
        source,
        info,
        info.loops,
        readContainer(() => readWebpOrientation(source)),
        resolveFrameColour(profile ? { profile, description: null } : null, source),
      )
    }
    case 'png': {
      const info = readContainer(() => readApngAnimation(source))

      // `acTL.num_plays` is already total plays, like WebP's count and unlike GIF's.
      return decodeApng(
        magick,
        source,
        info.loops,
        info.frames.map((frame) => frame.delayMs),
        pingPngMetadata(magick, source),
      )
    }
    default:
      throw new AnimationDecodeError(
        `${classification.format} is not an animated format this build decodes`,
      )
  }
}

/**
 * Runs the edit stage over an animation's frames — which, for an animated source, is alpha handling
 * and nothing else.
 *
 * R-C6 and R-C16 remove the Edit action for an animated image, so `edit` must be null. That is
 * asserted rather than assumed: `domain/job.ts` could hand one through, and a crop applied to frame
 * one and not frame two is a corruption nobody would trace back to here.
 *
 * Caveats are merged by `kind`. Flattening six frames against the same background is one fact about
 * the image; reporting it six times would make §6.6's report list the same line repeatedly for a
 * single file, which is a reporting bug the per-frame shape invites.
 */
export function applyEditFrames(
  animation: Animation,
  edit: EditRecord | null,
  alpha: AlphaHandling,
): EditFramesResult {
  if (edit !== null) {
    // An `AnimationStageError`, not a decode error: the file is fine, `domain/job.ts` handed this
    // stage something R-C6 and R-C16 say cannot exist.
    throw new AnimationStageError(
      'an animated source cannot carry an edit (R-C6, R-C16): editing is not offered for one',
    )
  }

  const frames: Frame[] = []
  const seen = new Set<Caveat['kind']>()
  const caveats: Caveat[] = []

  for (const frame of animation.frames) {
    const result = applyEdit(frame, null, alpha)

    frames.push(result.frame)

    for (const caveat of result.caveats) {
      if (!seen.has(caveat.kind)) {
        seen.add(caveat.kind)
        caveats.push(caveat)
      }
    }
  }

  const edited: Animation = { ...animation, frames }

  assertUniformAnimation(edited)

  return { animation: edited, caveats }
}

/**
 * Runs the resize stage over an animation's frames.
 *
 * Every frame is the full canvas and they are all the same size, so `resolveResizedSize` reaches
 * the same answer for each; the uniformity check afterwards is what proves that rather than trusting
 * it. A frame that needs no resize comes back as the same object, exactly as on the still path, so
 * an animation already at its target size costs nothing.
 */
export async function applyResizeFrames(
  animation: Animation,
  dimension: ResolvedDimension,
): Promise<Animation> {
  const frames: Frame[] = []

  for (const frame of animation.frames) {
    frames.push(await applyResize(frame, dimension))
  }

  const resized: Animation = { ...animation, frames }

  assertUniformAnimation(resized)

  return resized
}
