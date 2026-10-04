// Processing's own worker pool (T38), lazily created once and never destroyed — same shape and
// reasoning as src/ui/preview/preview-pool.ts.
//
// **Never destroyed**: destroying it would throw away every loaded codec, and R-X17 explicitly
// supports "Back to images, adjust settings, run again" as an ordinary flow. Leaving Processing
// (Cancel, or the completion actions) calls `cancel()`, which drains queued work but lets one
// active codec call per busy worker finish; re-entering calls `resume()` before submitting the
// next run's jobs.
//
// **Its own pool, not shared with Preview's**, for the same structural reason preview-pool.ts
// states for itself: `pool.ts`'s `supersede()` keys on `imageId` alone and is blind to `intent`. A
// `run` job submitted here while a stray `preview` job for the same image is in flight on a shared
// pool could silently supersede it, and vice versa. Two separate `WorkerPool` instances cannot
// supersede each other whatever the timing — see preview-pool.ts's own comment, and
// docs/task-notes/T36-A.md and T21's handover note, both of which call this out for T38 by name.

import { createWorkerPool, type WorkerPool } from '@/pipeline/pool'

let pool: WorkerPool | null = null

export function getProcessingPool(): WorkerPool {
  if (!pool) {
    pool = createWorkerPool()
  }

  return pool
}
