// The batch-wide, lazy `W×H` probe (docs/task-notes/T33-A.md). Nothing computes an image's real
// dimensions at selection time — `ingest.ts` adds every `ImageRecord` with `width: 0, height: 0`
// ("not yet known") and enqueues it here. This service works through the queue one image at a
// time, in the background, and reports each result (or failure) through a callback so the caller
// can patch the batch store — mirroring how `platform/thumbnails.ts` reports readiness via
// `onReady` rather than through the store directly.
//
// Three ways this differs from the thumbnail service (T20), on purpose:
//   - No budget. Every image eventually gets probed; there is no R-G10-style cap here.
//   - Not grid-only. It keeps running in list mode too, since list rows need `W×H` as well — its
//     lifetime is the batch's, not the grid view's.
//   - `stop()` is a pause, not a teardown: the queue is kept, only the worker is torn down. The
//     one thing that must happen "instantly", per the user, is that compression starting kills any
//     in-flight decode — but a cancelled run returning to Gallery should pick up where it left off,
//     so the caller pairs `stop()` on entering Processing with `resume()` on leaving it back to
//     Gallery. `clear()` is the real teardown, for when the batch itself is gone.

import type { PixelSize } from '@/domain/edit'
import type { ImageId } from '@/domain/types'
import type { DimensionProbeRequest, DimensionProbeResponse } from './dimension-probe-render'

export interface DimensionProbeServiceOptions {
  onResolved?: (id: ImageId, size: PixelSize) => void
  onFailed?: (id: ImageId) => void
}

type ProbeSource = File | (() => Promise<File | undefined>)

export interface DimensionProbeService {
  /** Queues one image. Ignored if already queued, in flight, or the batch has moved past it. */
  enqueue(id: ImageId, file: ProbeSource): void
  /** Drops one queued/in-flight entry without reporting a result for it (image removed). */
  cancel(id: ImageId): void
  /** Terminates the worker immediately. The queue is kept — see module doc. */
  stop(): void
  /** Un-pauses after stop(), resuming from wherever the queue was left. */
  resume(): void
  /** Terminates the worker and drops the queue entirely. The batch was cleared. */
  clear(): void
}

interface QueueEntry {
  id: ImageId
  file: ProbeSource
}

export function createDimensionProbeService(
  options: DimensionProbeServiceOptions = {},
): DimensionProbeService {
  const { onResolved, onFailed } = options

  let queue: QueueEntry[] = []
  let queuedIds = new Set<ImageId>()
  let worker: Worker | null = null
  let running = false
  let halted = false
  let active: QueueEntry | null = null
  let sourceLoading = false

  // Bumped by stop() and clear(). A response carrying a stale generation is discarded — defence
  // in depth alongside terminate() itself, matching thumbnails.ts's own pattern.
  let generation = 0

  function ensureWorker(): Worker | null {
    if (worker) {
      return worker
    }
    try {
      worker = new Worker(new URL('./dimension-probe-worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      // No terminable context: nothing is probed rather than risking un-killable background work.
      return null
    }
    worker.addEventListener('message', (event: MessageEvent<DimensionProbeResponse>) => {
      settle(event.data)
    })
    worker.addEventListener('error', () => {
      settle(null)
    })
    return worker
  }

  function settle(response: DimensionProbeResponse | null): void {
    const job = active
    active = null
    sourceLoading = false
    running = false

    const stale = job === null || response === null || response.token !== generation
    if (!stale) {
      if (response.ok) {
        onResolved?.(job.id, response.size)
      } else {
        onFailed?.(job.id)
      }
    }

    pump()
  }

  function pump(): void {
    if (running || halted) {
      return
    }

    const next = queue.shift()
    if (!next) {
      return
    }
    queuedIds.delete(next.id)

    const context = ensureWorker()
    if (!context) {
      return
    }

    running = true
    active = next
    const token = generation
    const send = (file: File | undefined): void => {
      if (token !== generation || active !== next || halted) return
      if (!file) {
        onFailed?.(next.id)
        settle(null)
        return
      }
      const request: DimensionProbeRequest = { token, id: next.id, file }
      context.postMessage(request)
      sourceLoading = false
    }
    if (typeof next.file === 'function') {
      sourceLoading = true
      void next.file().then(send, () => send(undefined))
    } else {
      send(next.file)
    }
  }

  function teardownWorker(): void {
    generation += 1
    if (worker) {
      worker.terminate()
      worker = null
    }
    // An interrupted job goes back to the front of the queue rather than being dropped, so
    // stop()-then-resume() retries it instead of leaving that image's dimensions unresolved
    // forever.
    if (active && !queuedIds.has(active.id)) {
      queue.unshift(active)
      queuedIds.add(active.id)
    }
    active = null
    sourceLoading = false
    running = false
  }

  return {
    enqueue(id, file) {
      if (queuedIds.has(id) || active?.id === id) {
        return
      }
      queuedIds.add(id)
      queue.push({ id, file })
      pump()
    },

    cancel(id) {
      if (queuedIds.delete(id)) {
        queue = queue.filter((entry) => entry.id !== id)
      }
      if (active?.id === id) {
        // The in-flight decode can't be aborted, but its result is discarded on arrival: bumping
        // the generation makes settle() treat it as stale without tearing down the worker for
        // every other queued entry.
        generation += 1
        active = null
        if (sourceLoading) {
          sourceLoading = false
          running = false
          pump()
        }
      }
    },

    stop() {
      halted = true
      teardownWorker()
    },

    resume() {
      halted = false
      pump()
    },

    clear() {
      // Order matters: teardownWorker() re-queues an interrupted job by design (see stop()), so
      // the queue is wiped after it runs, not before.
      teardownWorker()
      halted = false
      queue = []
      queuedIds = new Set()
    },
  }
}
