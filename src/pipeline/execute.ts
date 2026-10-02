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
// **A size target (T30) is the same chain with the encoder run several times** (§7.5): `stages/size.ts`
// walks the quality slider, and each probe is the whole encode stage the quality path would have run,
// so R-Q6, R-Q11, R-Q14 and R-Q15 all still hold under a target. Decode, edit and resize happen once,
// before the search, because none of them depends on quality. R-Q2's shortcut is decided before any
// of that: an image already under the target that the job asks nothing else of is not decoded or
// re-encoded. PNG/APNG bytes still receive their lossless raw-byte optimisation pass.
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
import { optimisePngBytesKeepingSmaller } from './stages/png-optimise'
import { applyResize } from './stages/resize'
import { encodeAnimatedToSize, encodeStillAtSlider, encodeStillToSize } from './stages/size'
import type { AnimatedFormat } from './stages/size'
import {
  DIMENSION_RECOVERY_MIN_SLIDER,
  searchSmallerDimensions,
} from './stages/dimension-recovery-plan'
import { requestIsSatisfiedBySource } from '@/domain/job'
import { geometryEdit, trailingResizeOp } from '@/domain/edit'
import type {
  Caveat,
  DimensionRecoveryJob,
  EncodableFormat,
  Job,
  JpegRecoveryJob,
  PipelineJob,
} from '@/domain/types'

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

  // R-Q2, before anything is decoded: an image already smaller than the target is passed through
  // rather than re-encoded up to it, and the tool never increases a file's size to meet a target.
  // PNG is the one deliberate exception to byte-for-byte pass-through: its source bytes receive a
  // lossless oxipng pass, and the smaller of that result and the original is returned. This applies
  // to both a literal PNG selection and "Don't change", since both resolve to `format: 'png'` here.
  // Only when the job asks nothing else of it — R-X45's test, in `requestIsSatisfiedBySource` —
  // because returning the original when a resize or a format change was asked for returns the wrong
  // file. Both direct pass-through and lossless PNG recompression preserve whatever metadata the
  // source carried, exactly as R-X24's substitution does.
  if (
    settings.quality.kind === 'size' &&
    job.source.byteLength <= settings.quality.targetBytes &&
    requestIsSatisfiedBySource(settings, job.edit)
  ) {
    const bytes =
      settings.format === 'png' ? await optimisePngBytesKeepingSmaller(job.source) : job.source
    const originalKept = bytes === job.source

    return {
      kind: 'output',
      bytes,
      format: settings.format,
      caveats:
        job.intent === 'run'
          ? [
              ...(job.caveats ?? []),
              ...(originalKept ? ([{ kind: 'original-kept' }] as const) : []),
            ]
          : [],
    }
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

  const edited = applyEdit(frame, geometryEdit(job.edit), settings.alpha)
  const recovered = trailingResizeOp(job.edit?.ops ?? [])
  const dimension =
    recovered === null
      ? settings.dimension
      : ({ kind: 'exact', width: recovered.width, height: recovered.height } as const)
  const resized = await applyResize(edited.frame, dimension)

  // `protocol.ts`: a preview returns bytes and size only; a run adds the report's caveat list.
  // `job.caveats` first: whatever `resolveSettings` already decided (R-F6's `animation-substituted`
  // is the one today) precedes what this job's own stages find (CORE-006).
  const report = (stage: Caveat[]): Caveat[] =>
    job.intent === 'run' ? [...(job.caveats ?? []), ...edited.caveats, ...stage] : []

  // §7.5: the same encoders, run up to eight times over the slider. Ahead of the per-format branches
  // because the search covers all five still formats, including the two that have their own stage.
  if (settings.quality.kind === 'size') {
    const searched = await encodeStillToSize(resized, settings.format, settings.quality.targetBytes)

    if (searched.kind === 'unreachable') {
      return {
        kind: 'size-target-unreachable',
        targetBytes: settings.quality.targetBytes,
        achievedBytes: searched.bytes.byteLength,
        format: settings.format,
        width: resized.width,
        height: resized.height,
      }
    }

    return {
      kind: 'output',
      bytes: searched.bytes,
      format: settings.format,
      caveats: report(searched.caveats),
    }
  }

  if (settings.format === 'png') {
    const encoded = await encodePng(resized, settings.quality)

    return { kind: 'output', bytes: encoded.bytes, format: 'png', caveats: report(encoded.caveats) }
  }

  // A still GIF is an animation of one frame (R-Q8 and §4.2 give GIF one row, not two) — see
  // `singleFrameAnimation`.
  if (settings.format === 'gif') {
    const encoded = await encodeGif(singleFrameAnimation(resized), settings.quality)

    return { kind: 'output', bytes: encoded.bytes, format: 'gif', caveats: report(encoded.caveats) }
  }

  const encoded = await encodeFrame(resized, settings.format, settings.quality)

  return { kind: 'output', bytes: encoded.bytes, format: settings.format, caveats: report([]) }
}

async function executeJpegRecovery(job: JpegRecoveryJob): Promise<JobResult> {
  const result = await executeJob({
    ...job,
    kind: 'encode',
    intent: 'run',
  })

  if (result.kind !== 'output') {
    return { kind: 'jpeg-recovery', suggestion: null }
  }

  const flattened = result.caveats.find(
    (caveat): caveat is Extract<Caveat, { kind: 'transparency-flattened' }> =>
      caveat.kind === 'transparency-flattened',
  )

  return {
    kind: 'jpeg-recovery',
    suggestion: {
      outputBytes: result.bytes.byteLength,
      flattenedFill: flattened?.fill ?? null,
    },
  }
}

async function executeDimensionRecovery(job: DimensionRecoveryJob): Promise<JobResult> {
  if (job.settings.isAnimated) {
    return { kind: 'dimension-recovery', suggestion: null }
  }

  await ensureCodecsForJob(job.settings)
  const frame = await decodeSource(job.source)
  const unsupported = unsupportedColour(frame.colour, job.settings.format)

  if (unsupported !== null) {
    throw new UnsupportedColourError(unsupported)
  }

  const edited = applyEdit(frame, geometryEdit(job.edit), job.settings.alpha)
  const fit = await searchSmallerDimensions(
    {
      current: { width: job.width, height: job.height },
      targetBytes: job.targetBytes,
      achievedBytes: job.achievedBytes,
    },
    async (size) => {
      const resized = await applyResize(edited.frame, { kind: 'exact', ...size })
      const encoded = await encodeStillAtSlider(
        resized,
        job.settings.format,
        DIMENSION_RECOVERY_MIN_SLIDER,
      )

      return encoded.bytes.byteLength
    },
  )

  if (fit === null) {
    return { kind: 'dimension-recovery', suggestion: null }
  }

  const resized = await applyResize(edited.frame, {
    kind: 'exact',
    width: fit.width,
    height: fit.height,
  })
  const final = await encodeStillToSize(
    resized,
    job.settings.format,
    job.targetBytes,
    DIMENSION_RECOVERY_MIN_SLIDER,
  )

  return final.kind === 'fit'
    ? {
        kind: 'dimension-recovery',
        suggestion: {
          outputBytes: final.bytes.byteLength,
          width: fit.width,
          height: fit.height,
          probes: fit.probes.length,
        },
      }
    : { kind: 'dimension-recovery', suggestion: null }
}

/** Dispatches the ordinary encode and the two Preview-only recovery operations. */
export async function executePipelineJob(job: PipelineJob): Promise<JobResult> {
  switch (job.kind) {
    case 'jpeg-recovery':
      return await executeJpegRecovery(job)
    case 'dimension-recovery':
      return await executeDimensionRecovery(job)
    default:
      return await executeJob(job)
  }
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

  // Checked before the decode rather than after the three per-frame stages, so that a format with no
  // animated path costs nothing. JPEG and AVIF are the only two, and `resolveFormat` has already
  // substituted WebP for them (R-F6), so this is a statement about an upstream bug.
  if (format !== 'png' && format !== 'gif' && format !== 'webp') {
    throw new JobExecutionError(`animated ${format} output is not a path this build has`)
  }

  const animated: AnimatedFormat = format

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
  // `job.caveats` first: whatever `resolveSettings` already decided (R-F6's `animation-substituted`
  // is the one today) precedes what this job's own stages find (CORE-006).
  const report = (stage: Caveat[]): Caveat[] =>
    job.intent === 'run' ? [...(job.caveats ?? []), ...edited.caveats, ...stage] : []

  // §7.5, and the expensive half of it: every probe re-encodes every frame. R-Q10 forbids the other
  // lever — no frame is ever dropped to hit a target — and an animated PNG has no quality axis at
  // all (R-Q15), so its search is one encode. See `encodeAnimatedToSize`.
  if (settings.quality.kind === 'size') {
    const searched = await encodeAnimatedToSize(resized, animated, settings.quality.targetBytes)

    if (searched.kind === 'unreachable') {
      const outputFrame = resized.frames[0]!

      return {
        kind: 'size-target-unreachable',
        targetBytes: settings.quality.targetBytes,
        achievedBytes: searched.bytes.byteLength,
        format: animated,
        width: outputFrame.width,
        height: outputFrame.height,
      }
    }

    return {
      kind: 'output',
      bytes: searched.bytes,
      format: animated,
      caveats: report(searched.caveats),
    }
  }

  if (format === 'png') {
    // `settings.quality` deliberately does not reach this encoder: animated PNG is always written
    // losslessly, because apng-optimizer's quality parameter is a request it neither honours nor
    // reports on, so a floor cannot be guaranteed the way R-Q11 guarantees one for still PNG. See
    // `encodeApng`. The still path below still reads quality in full.
    const encoded = await encodeApng(resized)

    return { kind: 'output', bytes: encoded.bytes, format: 'png', caveats: report(encoded.caveats) }
  }

  if (format === 'gif') {
    const encoded = await encodeGif(resized, settings.quality)

    return { kind: 'output', bytes: encoded.bytes, format: 'gif', caveats: report(encoded.caveats) }
  }

  const encoded = await encodeAnimatedWebp(resized, settings.quality)

  return { kind: 'output', bytes: encoded.bytes, format: 'webp', caveats: report(encoded.caveats) }
}
