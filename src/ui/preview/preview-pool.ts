// Preview's own worker pool (T36), lazily created once and never destroyed.
//
// **Never destroyed**, because destroying it throws away every loaded codec, and ImageMagick alone is
// 14.8 MB to re-initialise (A1, Technical Design §5.2). R-X29 names that re-init as the expensive
// escape hatch, not the normal path, and leaving Preview is the most ordinary thing a user does. What
// gets released on leaving Preview is the *rendered data* — the object URLs and the bytes behind them
// (R-B1, R-B4) — which `usePreviewEncode` does. Same lazy-module-singleton shape, and the same
// reasoning, as `ui/gallery/thumbnail-service.ts`.
//
// Leaving Preview also calls `cancel()`, which empties queued work but deliberately lets one active
// codec call per busy worker finish. Re-entering calls `resume()` before submitting its entry encode.
// This bounds rapid navigation without paying the codec reload cost of terminating the pool.
//
// **Its own pool, not a shared one**, and this is structural rather than a convention. `pool.ts`'s
// `supersede()` keys on `imageId` alone and is blind to `intent` (T21's handover note flags it): a
// `preview` job submitted while a `run` job for the same image is in flight would silently supersede
// the run's job, and that image would drop out of the batch with no failure recorded anywhere. Two
// separate `WorkerPool` instances cannot supersede each other whatever the timing, which is a
// stronger guarantee than relying on Preview being unmounted while Processing is mounted — true
// today, but a property of the current component tree rather than of the pool.
//
// **T38 must not call `getPreviewPool()`.** The Processing view needs a pool of its own, for exactly
// the reason above.

import { createWorkerPool, type WorkerPool } from '@/pipeline/pool'

let pool: WorkerPool | null = null

export function getPreviewPool(): WorkerPool {
  if (!pool) {
    pool = createWorkerPool()
  }

  return pool
}
