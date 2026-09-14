// Where a Job becomes bytes — the seam between T21's protocol and the stages that do the work.
//
// Technical Design §4.2: "A job declares its stages and the worker executes them in order." Those
// stages are T23-T29 (`pipeline/stages/`), and none of them exists yet. T21 owns the protocol and
// the pool, so this module exists to be replaced: `executeJob` keeps its signature, and the
// `unimplemented` failure below disappears the moment there is a stage chain to run.
//
// It is not a fabricated `encode-failed`. A caller that sees `unimplemented` has learned something
// true — the pipeline reached the worker and the worker had nothing to run — which is exactly what
// the T21 browser test asserts about the shipped worker.
//
// T22 (codec loading) owns the one line this module gains before that: §5.2's "a worker that needs a
// module it has not loaded loads it and then proceeds" means the codec load has to happen before any
// stage would run, not after — so it happens here, ahead of the `unimplemented` throw, keyed off the
// job's already-resolved `settings` rather than anything a stage would discover by decoding.

import { ensureCodecsForJob } from './codecs/loader'
import type { JobResult } from './protocol'
import type { Job } from '@/domain/types'

export class JobExecutionError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'JobExecutionError'
  }
}

export async function executeJob(job: Job): Promise<JobResult> {
  await ensureCodecsForJob(job.settings)

  throw new JobExecutionError(
    `no pipeline stages are implemented yet: cannot produce ${job.settings.format}`,
  )
}
