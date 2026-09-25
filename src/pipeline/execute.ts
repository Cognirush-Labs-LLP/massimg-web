// Where a Job becomes bytes — the seam between T21's protocol and the stages that do the work.
//
// Technical Design §4.2: "A job declares its stages and the worker executes them in order." For a
// still JPEG, WebP or AVIF output that order is decode (with orientation, T23), edit (T24), resize
// (T25), encode (T26). Still PNG shares the first three and then takes §4.2's own row — quantize,
// optimise, compare against lossless (T27) — which is `stages/png.ts`.
//
// An **animated** source takes §4.2's other two rows (T29): `decode-frames`, `edit-frames`,
// `resize-frames`, then animated WebP through ImageMagick or APNG through UPNG and apng-optimizer.
// The shape is the same as the still chain and deliberately so — the per-frame stages are the still
// stages mapped over an `Animation`, which is what keeps the two from growing separate copies of the
// resize and edit arithmetic.
//
// **GIF takes one row for both** (T28): `stages/gif.ts` writes the file through ImageMagick and
// compresses it with gifsicle (R-Q8), and a still image reaches it as an animation of one frame, so
// the still and animated GIF paths are the same code rather than two that drift.
//
// One row of §4.2's table is still unbuilt: size targeting (T30) fails as `unimplemented`, which
// tells the caller something true — the job reached a worker that has no path for it — rather than a
// fabricated `encode-failed`.
//
// The codec load stays first, ahead of every check (T22): §5.2's "a worker that needs a module it
// has not loaded loads it and then proceeds" is keyed off the job's resolved settings, and
// `tests/e2e/codecs.spec.ts` observes that load for formats that are not implemented yet.
//
// Each stage consumes the frame it is given, and no reference to an earlier frame is kept here
// (T24's memory note): a 50 MP decode is 200 MB, and a caller still holding it doubles the peak.

import { ensureCodecsForJob } from './codecs/loader'
import type { JobResult } from './protocol'
import { applyEditFrames, applyResizeFrames, decodeAnimation } from './stages/animation'
import { encodeAnimatedWebp, encodeApng } from './stages/animation-encode'
import { DecodeError, decodeFrame } from './stages/decode'
import { applyEdit } from './stages/edit'
import { UnsupportedColourError, encodeFrame } from './stages/encode'
import { unsupportedColour } from './stages/encode-plan'
import type { ColourFormat } from './stages/encode-plan'
import { singleFrameAnimation } from './stages/frame'
import { encodeGif } from './stages/gif'
import { encodePng } from './stages/png'
import { applyResize } from './stages/resize'
import type { Caveat, EncodableFormat, Job } from '@/domain/types'

export class JobExecutionError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'JobExecutionError'
  }
}

async function decodeSource(source: Uint8Array) {
  try {
    return await decodeFrame(source)
  } catch (error) {
    // An allocation failure is still out-of-memory; anything else ImageMagick raises while reading
    // the source (a corrupt or truncated file) is a decode failure, not an encode one.
    if (error instanceof RangeError || error instanceof DecodeError) {
      throw error
    }

    throw new DecodeError(error instanceof Error ? error.message : String(error))
  }
}

export async function executeJob(job: Job): Promise<JobResult> {
  const { settings } = job

  await ensureCodecsForJob(settings)

  if (settings.quality.kind === 'size') {
    throw new JobExecutionError('size targeting is not implemented yet (T30)')
  }

  if (settings.isAnimated) {
    return await executeAnimated(job, settings.format)
  }

  const frame = await decodeSource(job.source)

  // Checked here rather than at the encoder: the colour is known as soon as the frame exists, and a
  // job that cannot be encoded should not pay for an edit and a resize first.
  const unsupported = unsupportedColour(frame.colour, settings.format)

  if (unsupported !== null) {
    throw new UnsupportedColourError(unsupported)
  }

  const edited = applyEdit(frame, job.edit, settings.alpha)
  const resized = await applyResize(edited.frame, settings.dimension)

  // `protocol.ts`: a preview returns bytes and size only; a run adds the report's caveat list.
  const report = (stage: Caveat[]): Caveat[] =>
    job.intent === 'run' ? [...edited.caveats, ...stage] : []

  if (settings.format === 'png') {
    const encoded = await encodePng(resized, settings.quality)

    return { bytes: encoded.bytes, format: 'png', caveats: report(encoded.caveats) }
  }

  // A still GIF is an animation of one frame (R-Q8 and §4.2 give GIF one row, not two) — see
  // `singleFrameAnimation`.
  if (settings.format === 'gif') {
    const encoded = await encodeGif(singleFrameAnimation(resized), settings.quality)

    return { bytes: encoded.bytes, format: 'gif', caveats: report(encoded.caveats) }
  }

  const encoded = await encodeFrame(resized, settings.format, settings.quality)

  return { bytes: encoded.bytes, format: settings.format, caveats: report([]) }
}

/**
 * Which container the colour has to fit into, for a format that is about to be written animated.
 *
 * WebP is the fallback rather than a `never` check because `resolveFormat` has already substituted
 * it for the formats that cannot animate, so anything not named here is already WebP.
 */
function animatedColourFormat(format: EncodableFormat): ColourFormat {
  return format === 'png' || format === 'gif' ? format : 'webp'
}

/**
 * §4.2's `decode-frames` / `edit-frames` / `resize-frames` chain, then an animated encoder.
 *
 * `edit` is passed through rather than dropped, so that `applyEditFrames` can refuse it: R-C6 and
 * R-C16 remove the Edit action for an animated image, and an edit reaching here is an upstream bug
 * that should say so rather than be silently discarded.
 *
 * WebP, PNG and GIF arrive. JPEG and AVIF cannot animate and `resolveFormat` has already substituted
 * WebP for them (R-F6), carrying its own `animation-substituted` caveat.
 */
async function executeAnimated(job: Job, format: EncodableFormat): Promise<JobResult> {
  const { settings } = job

  if (settings.quality.kind !== 'quality') {
    throw new JobExecutionError('size targeting is not implemented yet (T30)')
  }

  const animation = await decodeAnimation(job.source).catch((error: unknown) => {
    // An allocation failure is still out-of-memory; `decodeAnimation` already reports a damaged
    // container as a `DecodeError`, so anything else here is the decode failing for a reason it did
    // not anticipate.
    if (error instanceof RangeError || error instanceof DecodeError) {
      throw error
    }

    throw new DecodeError(error instanceof Error ? error.message : String(error))
  })

  const first = animation.frames[0]

  if (first === undefined) {
    throw new DecodeError('decoded animation has no frames')
  }

  // Checked as soon as the colour is known, before the edit and resize that would be thrown away.
  const unsupported = unsupportedColour(first.colour, animatedColourFormat(format))

  if (unsupported !== null) {
    throw new UnsupportedColourError(unsupported)
  }

  const edited = applyEditFrames(animation, job.edit, settings.alpha)
  const resized = await applyResizeFrames(edited.animation, settings.dimension)

  // `protocol.ts`: a preview returns bytes and size only; a run adds the report's caveat list.
  const report = (stage: Caveat[]): Caveat[] =>
    job.intent === 'run' ? [...edited.caveats, ...stage] : []

  if (format === 'png') {
    // `settings.quality` deliberately does not reach this encoder: animated PNG is always written
    // losslessly, because apng-optimizer's quality parameter is a request it neither honours nor
    // reports on, so a floor cannot be guaranteed the way R-Q11 guarantees one for still PNG. See
    // `encodeApng`. The still path below still reads quality in full.
    const encoded = await encodeApng(resized)

    return { bytes: encoded.bytes, format: 'png', caveats: report(encoded.caveats) }
  }

  if (format === 'gif') {
    const encoded = await encodeGif(resized, settings.quality)

    return { bytes: encoded.bytes, format: 'gif', caveats: report(encoded.caveats) }
  }

  if (format !== 'webp') {
    throw new JobExecutionError(`animated ${format} output is not a path this build has`)
  }

  const encoded = await encodeAnimatedWebp(resized, settings.quality)

  return { bytes: encoded.bytes, format: 'webp', caveats: report(encoded.caveats) }
}
