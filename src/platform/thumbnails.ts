// Batch-scoped thumbnail generation for Gallery grid mode (Technical Design §10.4, §8.1).
//
// A factory rather than a module singleton: the cache and the read budget are scoped to one batch,
// and the limit is injected rather than looked up, so changing `maximumThumbnails` needs no change
// here (R-G3, R-G10). Gallery grid owns an instance; entering list mode or leaving Gallery calls
// stop(), clearing the batch calls clear() (R-G9, R-G12).

import { runtimeLimits } from '@/config/limits'
import type { PixelSize } from '@/domain/edit'
import type { EditRecord, ImageId } from '@/domain/types'
import type {
  ThumbnailFailure,
  ThumbnailFormat,
  ThumbnailJobRequest,
  ThumbnailJobResponse,
} from './thumbnail-render'

export type { ThumbnailFailure, ThumbnailFormat }

/**
 * Long-edge bound, in device pixels, applied to both axes. The mockup's grid uses a 168 px minimum
 * tile, so this covers a tile at device pixel ratio 2. Measured over 50 mixed photographs: a full
 * 100-thumbnail batch at this bound retains 1.0-12.7 MB depending on engine, against a budget where
 * a single 12 MP decode is 48 MB (Technical Design §8.1). See C5 and docs/task-notes/T20.md.
 */
export const DEFAULT_MAX_EDGE = 384

/**
 * Encoded format and quality. Chosen by measurement, not intuition (C5): WebP is 25-30% smaller than
 * JPEG on Chromium and Firefox and preserves the alpha a JPEG thumbnail of a transparent PNG would
 * flatten. WebKit's WebP encoder appears to ignore the quality argument and produces files ~4.8x
 * larger than its own JPEG, which is recorded as a surprise — even there the retained total stays
 * small enough not to decide the format.
 */
export const DEFAULT_FORMAT: ThumbnailFormat = 'image/webp'
export const DEFAULT_QUALITY = 0.75

export interface ThumbnailSource {
  id: ImageId
  /** The source file. Reading it is what the budget counts. */
  blob: Blob
  /** From ImageRecord.width/height — lets both axes be bounded without a probe decode. */
  source: PixelSize
  edit: EditRecord | null
}

export interface ThumbnailStats {
  /** Charged when a read starts. Never refunded on failure or cancellation, never replenished. */
  readsStarted: number
  /** Live cache entries. Bounded from above by readsStarted, so never exceeds the budget. */
  retained: number
  budget: number
  /** A job is in flight. */
  running: boolean
  /** A generation context exists. False after stop() until work resumes. */
  workerAlive: boolean
}

/**
 * ImageMagick's thumbnail operation (Technical Design §10.4), for supported inputs the browser
 * cannot decode natively.
 *
 * T20 left this as an unwired seam because no codec loader existed; T22 built the loader and handed
 * the body to T23 as decode logic. It is now wired — but **in the generation worker**, not here:
 * the fallback is a synchronous WASM decode with no abort, so running it on the main thread would
 * break R-G12's "generation stops" exactly as an un-abortable `createImageBitmap` would. See
 * `thumbnail-worker.ts`.
 *
 * This option therefore exists only to *replace* that default with a caller's own decoder, or to
 * switch it off with `null`. A decoder passed here runs on the main thread and cannot be
 * terminated, so its caller owns that consequence; omitting the option gets the worker's
 * cancellable ImageMagick path.
 */
export type FallbackDecoder = (request: {
  blob: Blob
  source: PixelSize
  edit: EditRecord | null
  maxEdge: number
  format: ThumbnailFormat
  quality: number
}) => Promise<Blob>

export interface ThumbnailServiceOptions {
  maximumThumbnails?: number
  maxEdge?: number
  format?: ThumbnailFormat
  quality?: number
  /** Omit for the ImageMagick fallback; pass `null` to disable it. */
  fallbackDecoder?: FallbackDecoder | null
  onReady?: (id: ImageId) => void
}

export interface ThumbnailService {
  /**
   * The visible and near-visible window, in priority order. Replaces the pending queue rather than
   * appending to it, which is what keeps a fast scroll from queueing work for every tile it passes
   * (R-G10). Already-cached ids are ignored.
   */
  setVisible(sources: readonly ThumbnailSource[]): void
  /** The object URL for a generated thumbnail, or null — a null means "render a placeholder". */
  urlFor(id: ImageId): string | null
  /** Releases one entry: image removed, or its edit changed. Does not refund budget. */
  invalidate(id: ImageId): void
  /** Releases every entry and stops generation. The batch was cleared. */
  clear(): void
  /** Stops generation and drops the queue, keeping the cache so returning to Gallery rereads nothing. */
  stop(): void
  stats(): ThumbnailStats
  /** Resolves when the queue is drained and no job is in flight. */
  whenIdle(): Promise<void>
}

interface CacheEntry {
  blob: Blob
  url: string
}

export function createThumbnailService(options: ThumbnailServiceOptions = {}): ThumbnailService {
  const budget = options.maximumThumbnails ?? runtimeLimits.maximumThumbnails
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE
  const format = options.format ?? DEFAULT_FORMAT
  const quality = options.quality ?? DEFAULT_QUALITY
  // `??` would be wrong for the second of these: it cannot tell an explicit `null` ("no fallback")
  // from an omitted option ("the default"), and those are different requests. Omitting the option
  // leaves `customFallback` null and lets the worker do the work; passing `null` switches the
  // fallback off in both places.
  const customFallback = options.fallbackDecoder ?? null
  const allowWorkerFallback = options.fallbackDecoder === undefined
  const onReady = options.onReady

  // Plain Map, never a reactive store: binary data must not enter Pinia (Technical Design §1.1).
  const cache = new Map<ImageId, CacheEntry>()
  let queue: ThumbnailSource[] = []
  let readsStarted = 0
  let running = false
  let worker: Worker | null = null

  // Bumped by stop() and clear(). A response carrying a stale generation is discarded, so a
  // completion that raced cancellation can never enter the cache (R-G12).
  let generation = 0
  let active: ThumbnailSource | null = null
  let activeDropped = false
  let idleWaiters: (() => void)[] = []

  function releaseWaiters(): void {
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) {
      resolve()
    }
  }

  function ensureWorker(): Worker | null {
    if (worker) {
      return worker
    }

    try {
      worker = new Worker(new URL('./thumbnail-worker.ts', import.meta.url), { type: 'module' })
    } catch {
      // No terminable context means R-G12's "no work continues in the background" cannot be
      // honoured, so nothing is generated at all and every tile stays a placeholder. Deliberately
      // not a main-thread fallback.
      return null
    }

    worker.addEventListener('message', (event: MessageEvent<ThumbnailJobResponse>) => {
      void settle(event.data)
    })
    worker.addEventListener('error', () => {
      void settle(null)
    })

    return worker
  }

  function store(id: ImageId, blob: Blob): void {
    cache.set(id, { blob, url: URL.createObjectURL(blob) })
    onReady?.(id)
  }

  async function settle(response: ThumbnailJobResponse | null): Promise<void> {
    const job = active
    const stale =
      job === null || activeDropped || response === null || response.token !== generation

    if (!stale && response.ok) {
      store(job.id, response.blob)
    } else if (!stale && !response.ok && response.reason === 'unsupported' && customFallback) {
      // Only a caller-supplied decoder reaches here. The default ImageMagick fallback has already
      // run inside the worker by this point, and arrives as an ordinary `ok: true` response above.
      const decoded = await customFallback({
        blob: job.blob,
        source: job.source,
        edit: job.edit,
        maxEdge,
        format,
        quality,
      }).catch(() => null)
      // The decoder is async, so re-check: the batch may have been cleared while it ran.
      if (decoded && active === job && !activeDropped && generation === response.token) {
        store(job.id, decoded)
      }
    }

    active = null
    activeDropped = false
    running = false
    pump()
  }

  function pump(): void {
    if (running) {
      return
    }

    while (queue.length > 0) {
      const next = queue.shift()
      if (!next || cache.has(next.id)) {
        continue
      }

      if (readsStarted >= budget) {
        // The budget is spent. Uncached tiles stay placeholders; nothing is evicted to make room,
        // because that would reread sources as the user scrolls (R-G10).
        queue = []
        break
      }

      const context = ensureWorker()
      if (!context) {
        queue = []
        break
      }

      readsStarted += 1
      running = true
      active = next
      activeDropped = false

      const request: ThumbnailJobRequest = {
        token: generation,
        id: next.id,
        blob: next.blob,
        source: next.source,
        ops: next.edit?.ops ?? [],
        maxEdge,
        format,
        quality,
        allowFallback: allowWorkerFallback,
      }
      context.postMessage(request)
      return
    }

    releaseWaiters()
  }

  function release(id: ImageId): void {
    const entry = cache.get(id)
    if (entry) {
      URL.revokeObjectURL(entry.url)
      cache.delete(id)
    }
  }

  function halt(): void {
    generation += 1
    queue = []
    if (worker) {
      worker.terminate()
      worker = null
    }
    active = null
    activeDropped = false
    running = false
    releaseWaiters()
  }

  return {
    setVisible(sources) {
      queue = sources.filter((source) => !cache.has(source.id))
      pump()
    },

    urlFor(id) {
      return cache.get(id)?.url ?? null
    },

    invalidate(id) {
      release(id)
      queue = queue.filter((source) => source.id !== id)
      if (active?.id === id) {
        // Its completion must not repopulate what was just invalidated. Budget is already spent.
        activeDropped = true
      }
    },

    clear() {
      for (const id of [...cache.keys()]) {
        release(id)
      }
      halt()
    },

    stop() {
      halt()
    },

    stats() {
      return {
        readsStarted,
        retained: cache.size,
        budget,
        running,
        workerAlive: worker !== null,
      }
    },

    whenIdle() {
      if (!running && queue.length === 0) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
      })
    },
  }
}
