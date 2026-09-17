// Where a Job becomes bytes — the seam between T21's protocol and the stages that do the work.
//
// Technical Design §4.2: "A job declares its stages and the worker executes them in order." For a
// still JPEG, WebP or AVIF output that order is decode (with orientation, T23), edit (T24), resize
// (T25), encode (T26). Still PNG shares the first three and then takes §4.2's own row — quantize,
// optimise, compare against lossless (T27) — which is `stages/png.ts`. The remaining rows of §4.2's
// table are not built yet: GIF (T28), animated output (T29) and size targeting (T30) still fail as
// `unimplemented`, which tells the caller something true — the job reached a worker that has no path
// for it — rather than a fabricated `encode-failed`.
//
// The codec load stays first, ahead of every check (T22): §5.2's "a worker that needs a module it
// has not loaded loads it and then proceeds" is keyed off the job's resolved settings, and
// `tests/e2e/codecs.spec.ts` observes that load for formats that are not implemented yet.
//
// Each stage consumes the frame it is given, and no reference to an earlier frame is kept here
// (T24's memory note): a 50 MP decode is 200 MB, and a caller still holding it doubles the peak.

import { ensureCodecsForJob } from './codecs/loader'
import type { JobResult } from './protocol'
import { DecodeError, decodeFrame } from './stages/decode'
import { applyEdit } from './stages/edit'
import { UnsupportedColourError, encodeFrame } from './stages/encode'
import { unsupportedColour } from './stages/encode-plan'
import { encodePng } from './stages/png'
import { applyResize } from './stages/resize'
import type { Caveat, Job } from '@/domain/types'

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

  if (settings.isAnimated) {
    throw new JobExecutionError(`animated ${settings.format} output is not implemented yet (T29)`)
  }

  if (settings.format === 'gif') {
    throw new JobExecutionError('gif output is not implemented yet (T28)')
  }

  if (settings.quality.kind === 'size') {
    throw new JobExecutionError('size targeting is not implemented yet (T30)')
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

  const encoded = await encodeFrame(resized, settings.format, settings.quality)

  return { bytes: encoded.bytes, format: settings.format, caveats: report([]) }
}
