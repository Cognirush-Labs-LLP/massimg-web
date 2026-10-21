// The pipeline worker pool (Technical Design §5.1, §5.3; R-X8, R-X26, R-X28, R-X29).
//
// One job in flight per worker (§8.1), a small fixed number of workers (§5.1), and the three
// cancellation mechanisms the design commits to, which are three different things and are kept
// separate here:
//
//   between jobs      (R-X26) nothing new is dispatched; what is already running finishes
//   discard on arrival (R-X28) a superseded result is thrown away when it lands, not interrupted
//   terminate/respawn  (R-X29) the only true interrupt, and the expensive one
//
// The pool never rejects a job promise. Every submitted job resolves with an outcome, including the
// ones that are cancelled, superseded or killed — a caller tracking a batch needs every promise to
// settle, or its counter never reaches the end.

import { resolveCodecLimits, resolveWorkerPoolSize, runtimeLimits } from '@/config/limits'
import { detectMobile } from '@/platform/device'
import { nextToken } from './protocol'
import type { JobFailure, JobResult, JobToken, WorkerRequest, WorkerResponse } from './protocol'
import type { ImageId, PipelineJob } from '@/domain/types'
import type { RuntimeLimits } from '@/config/limits'

interface OutcomeIdentity {
  token: JobToken
  imageId: ImageId
}

/** Why a worker was killed. Each is a distinct event, not three names for a failure. */
export type TerminationCause =
  /** `terminateJob()` — R-X29's escape hatch, invoked by whoever decides the user is waiting. */
  | 'requested'
  /** The optional `jobTimeoutMs` watchdog fired. */
  | 'timeout'
  /** The worker raised an uncaught error, or could not be constructed at all. */
  | 'worker-error'

export type JobOutcome =
  | (OutcomeIdentity & { outcome: 'completed'; result: JobResult })
  | (OutcomeIdentity & { outcome: 'failed'; reason: JobFailure })
  /** A newer job for the same image replaced this one (R-X28). */
  | (OutcomeIdentity & { outcome: 'superseded' })
  /** Cancelled before it started (R-X26). It never reached a worker. */
  | (OutcomeIdentity & { outcome: 'cancelled' })
  | (OutcomeIdentity & { outcome: 'terminated'; cause: TerminationCause })

export interface PoolStats {
  /** Configured worker count. Workers are spawned lazily, so this is a ceiling, not a headcount. */
  size: number
  queued: number
  /** Jobs currently occupying a worker. Never exceeds `size` — this is R-X8's bound. */
  active: number
  /** Jobs ever dispatched to a worker. After cancel() this must stop moving (R-X26). */
  started: number
  /** Outcomes delivered as `completed` or `failed`. */
  completed: number
  /** Results that arrived for an already-settled token and were dropped (R-X28). */
  discarded: number
  cancelled: boolean
  workersAlive: number
  /** Workers terminated and replaced (R-X29). */
  terminations: number
}

export interface WorkerPoolOptions {
  /** Overrides the §5.1 sizing. Tests use this; application code should not need it. */
  size?: number
  /** Overrides mobile detection. */
  mobile?: boolean
  limits?: RuntimeLimits
  /**
   * Builds one worker. Defaults to the real `pipeline/worker.ts`. The seam exists because the pool's
   * invariants are about timing and ordering, and until T23-T29 build the stages there is nothing
   * inside the worker that takes a controllable amount of time; the browser test injects a probe
   * worker so the queueing, tokens, cancellation and termination are exercised across a real
   * `postMessage` boundary. It is also where a heterogeneous-by-codec pool would be built if C8
   * forces the split §5.2 warns about.
   */
  workerFactory?: () => Worker
  /**
   * Overrides R-X29's duration threshold, in milliseconds, or `null` for no watchdog. The shipped
   * value lives in the runtime limits module with every other limit (§8.3), where it is currently
   * null because no re-init cost has been measured yet; this is the per-pool override.
   */
  jobTimeoutMs?: number | null
}

export interface JobHandle {
  /**
   * Available synchronously, before the job has run. It has to be: R-X29's escape hatch identifies
   * the job to kill by token, and a caller cannot wait for the outcome to learn which job to stop.
   */
  token: JobToken
  /** Settles with the outcome. Never rejects. */
  done: Promise<JobOutcome>
}

export interface WorkerPool {
  /** Ceiling on concurrent workers (§5.1). */
  readonly size: number
  /** Queues one job. Its `done` promise always settles, with an outcome; it never rejects. */
  run(job: PipelineJob): JobHandle
  /**
   * Pre-spawns one worker (if none exists yet) and asks it to pre-load ImageMagick, so the idle-time
   * preload (§12.1) pays the real cost once, in the realm that will actually use it, instead of a
   * throwaway main-thread copy. Fire-and-forget and a no-op once cancelled or destroyed. Warms at
   * most one worker — a full pool would speculatively fetch 14.8 MB per worker for jobs that may
   * never arrive.
   */
  warm(): void
  /**
   * R-X26. Nothing further is dispatched and every queued job resolves `cancelled`; jobs already in
   * a worker run to completion and deliver their results, so the wait is bounded by one image per
   * busy worker rather than by the rest of the batch.
   */
  cancel(): void
  /** Clears the cancel flag so the same pool — and its loaded codecs — can run again (R-X17). */
  resume(): void
  /**
   * R-X29. Kills the worker running `token` and lets a replacement spawn. Returns false if that
   * token is not in flight. This is the only true interrupt and costs a full codec re-init.
   */
  terminateJob(token: JobToken): boolean
  stats(): PoolStats
  /** Terminates every worker and settles every outstanding job. The pool is not reusable after this. */
  destroy(): void
}

interface Slot {
  worker: Worker | null
  entry: Entry | null
}

interface Entry {
  token: JobToken
  job: PipelineJob
  settle: (outcome: JobOutcome) => void
  /** The promise has been resolved. The job may still occupy a worker — that is the R-X28 case. */
  settled: boolean
  slot: Slot | null
  timer: ReturnType<typeof setTimeout> | null
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

export function createWorkerPool(options: WorkerPoolOptions = {}): WorkerPool {
  const limits = options.limits ?? runtimeLimits
  const mobile = options.mobile ?? detectMobile()
  const size = Math.max(
    1,
    options.size ??
      resolveWorkerPoolSize(
        {
          hardwareConcurrency:
            typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
          mobile,
        },
        limits,
      ),
  )
  const createWorker = options.workerFactory ?? defaultWorkerFactory
  const codecLimits = resolveCodecLimits(mobile, limits)
  // `??` would be wrong here: an explicit `null` means "no watchdog for this pool" and must not fall
  // through to the configured limit once that limit stops being null.
  const jobTimeoutMs =
    options.jobTimeoutMs !== undefined ? options.jobTimeoutMs : limits.jobTimeoutMs

  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, entry: null }))
  // Plain Maps, never a store: a Job carries source bytes, and binary data does not enter Pinia
  // (Technical Design §1.1).
  const live = new Map<JobToken, Entry>()
  /** §5.3's "the main thread records the latest token per image". */
  const latestByImage = new Map<ImageId, JobToken>()

  let queue: Entry[] = []
  let cancelled = false
  let destroyed = false
  let started = 0
  let completed = 0
  let discarded = 0
  let terminations = 0
  let lastIssued = 0

  /** Resolves the caller's promise once. The entry may still hold a worker afterwards. */
  function settle(entry: Entry, outcome: JobOutcome): void {
    if (entry.settled) {
      return
    }

    entry.settled = true
    if (outcome.outcome === 'completed' || outcome.outcome === 'failed') {
      completed += 1
    }
    entry.settle(outcome)
  }

  /** Drops every trace of an entry: its timer, its slot, and its claim on the image's latest token. */
  function retire(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    if (entry.slot?.entry === entry) {
      entry.slot.entry = null
    }
    entry.slot = null

    live.delete(entry.token)
    if (latestByImage.get(entry.job.imageId) === entry.token) {
      latestByImage.delete(entry.job.imageId)
    }
  }

  function discardWorker(slot: Slot): void {
    if (slot.worker) {
      slot.worker.terminate()
      slot.worker = null
      terminations += 1
    }
  }

  function onResponse(slot: Slot, response: WorkerResponse): void {
    const entry = live.get(response.token)

    // A response for a token the pool no longer knows about: the job was terminated and its worker
    // replaced. Nothing to free, nothing to deliver.
    if (!entry || entry.slot !== slot) {
      return
    }

    retire(entry)

    if (entry.settled) {
      // R-X28: the encode was not interrupted, it ran to completion and its result is thrown away
      // here, on arrival, because a newer token owns this image now.
      discarded += 1
    } else if (response.kind === 'result') {
      settle(entry, {
        token: entry.token,
        imageId: entry.job.imageId,
        outcome: 'completed',
        result: response.result,
      })
    } else if (response.kind === 'error') {
      settle(entry, {
        token: entry.token,
        imageId: entry.job.imageId,
        outcome: 'failed',
        reason: response.reason,
      })
    } else {
      // The worker's own between-jobs flag refused to start it (§5.3). It never ran, so it is
      // cancelled rather than failed.
      settle(entry, { token: entry.token, imageId: entry.job.imageId, outcome: 'cancelled' })
    }

    pump()
  }

  function onWorkerError(slot: Slot): void {
    const entry = slot.entry

    discardWorker(slot)

    if (entry) {
      retire(entry)
      settle(entry, {
        token: entry.token,
        imageId: entry.job.imageId,
        outcome: 'terminated',
        cause: 'worker-error',
      })
    }

    pump()
  }

  function ensureWorker(slot: Slot): Worker | null {
    if (slot.worker) {
      return slot.worker
    }

    let worker: Worker
    try {
      worker = createWorker()
    } catch {
      return null
    }

    const configure: WorkerRequest = { kind: 'configure', codecLimits }
    worker.postMessage(configure)

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      onResponse(slot, event.data)
    })
    worker.addEventListener('error', () => {
      onWorkerError(slot)
    })
    // A response that fails to deserialize delivers `messageerror` instead of `message`. Without
    // this the entry would stay in `live`, its slot would never free and its promise would never
    // settle — breaking the "every job settles" invariant at the top of this file, with no watchdog
    // to catch it while `jobTimeoutMs` defaults to null.
    worker.addEventListener('messageerror', () => {
      onWorkerError(slot)
    })

    slot.worker = worker
    return worker
  }

  function dispatch(entry: Entry, slot: Slot): void {
    const worker = ensureWorker(slot)

    if (!worker) {
      // A worker that cannot be constructed is, from the caller's side, a worker that died: there is
      // no main-thread fallback, because a WASM encode on the main thread could not be cancelled at
      // all and would break R-X26 outright.
      retire(entry)
      settle(entry, {
        token: entry.token,
        imageId: entry.job.imageId,
        outcome: 'terminated',
        cause: 'worker-error',
      })
      return
    }

    slot.entry = entry
    entry.slot = slot
    started += 1

    if (jobTimeoutMs !== null) {
      entry.timer = setTimeout(() => {
        terminate(entry, 'timeout')
      }, jobTimeoutMs)
    }

    // The source bytes are copied, not transferred. Transferring would detach the caller's buffer,
    // and R-X28's whole shape is "the same image is submitted again a moment later" — the second
    // submission would then find an empty buffer.
    const request: WorkerRequest = { kind: 'run', token: entry.token, job: entry.job }
    worker.postMessage(request)
  }

  function pump(): void {
    // The between-jobs flag (R-X26), checked before each dispatch rather than inside the worker: a
    // flag a worker could read mid-WASM-call needs a SharedArrayBuffer, which needs cross-origin
    // isolation, which `platform/capability.ts` already treats as not guaranteed.
    while (!cancelled && !destroyed && queue.length > 0) {
      const slot = slots.find((candidate) => candidate.entry === null)
      if (!slot) {
        return
      }

      const entry = queue.shift()
      if (!entry) {
        return
      }

      dispatch(entry, slot)
    }
  }

  function terminate(entry: Entry, cause: TerminationCause): void {
    const slot = entry.slot
    if (!slot) {
      return
    }

    discardWorker(slot)
    retire(entry)
    settle(entry, {
      token: entry.token,
      imageId: entry.job.imageId,
      outcome: 'terminated',
      cause,
    })
    pump()
  }

  /** Marks the previous live job for this image superseded (R-X28, §5.3). */
  function supersede(imageId: ImageId): void {
    const previousToken = latestByImage.get(imageId)
    if (previousToken === undefined) {
      return
    }

    const previous = live.get(previousToken)
    if (!previous || previous.settled) {
      return
    }

    settle(previous, { token: previous.token, imageId, outcome: 'superseded' })

    if (previous.slot === null) {
      // Still queued, so it need not be discarded later — it simply never starts. Debouncing (R-P3)
      // is what keeps most superseded previews in this branch rather than the next one.
      queue = queue.filter((candidate) => candidate !== previous)
      retire(previous)
    }
    // Otherwise it is in flight and is deliberately left alone: R-X28 does not interrupt it. Its
    // result is discarded when it arrives, in onResponse.
  }

  return {
    size,

    run(job) {
      const token = nextToken()
      lastIssued = token

      let entry!: Entry
      // The executor runs synchronously, so `entry` is assigned before `new Promise` returns and
      // everything below — including the dispatch — happens before the caller gets its handle.
      const done = new Promise<JobOutcome>((resolve) => {
        entry = { token, job, settle: resolve, settled: false, slot: null, timer: null }
      })

      if (cancelled || destroyed) {
        settle(entry, { token, imageId: job.imageId, outcome: 'cancelled' })
        return { token, done }
      }

      supersede(job.imageId)
      latestByImage.set(job.imageId, token)
      live.set(token, entry)
      queue.push(entry)
      pump()

      return { token, done }
    },

    warm() {
      // Idempotent regardless of pool size: once any slot has a worker — whether from a previous
      // `warm()` or because a real job already dispatched — there is nothing left to warm. Without
      // this check, calling `warm()` twice on a pool sized above 1 would spin up a *second* worker
      // and pay a second ImageMagick load, the exact duplication this method exists to avoid.
      if (cancelled || destroyed || slots.some((slot) => slot.worker !== null)) {
        return
      }

      // `size` is clamped to at least 1 above, so slot 0 always exists.
      const worker = ensureWorker(slots[0]!)
      if (!worker) {
        return
      }

      const request: WorkerRequest = { kind: 'warm' }
      worker.postMessage(request)
    },

    cancel() {
      cancelled = true

      const abandoned = queue
      queue = []
      for (const entry of abandoned) {
        retire(entry)
        settle(entry, { token: entry.token, imageId: entry.job.imageId, outcome: 'cancelled' })
      }

      // The worker's half of the flag (§5.3). Carrying the highest token issued so far means a
      // resumed pool's later jobs are unaffected, so cancelling does not cost a codec re-init.
      const message: WorkerRequest = { kind: 'cancel', through: lastIssued as JobToken }
      for (const slot of slots) {
        slot.worker?.postMessage(message)
      }
    },

    resume() {
      if (!destroyed) {
        cancelled = false
        pump()
      }
    },

    terminateJob(token) {
      const entry = live.get(token)
      if (!entry || entry.slot === null) {
        return false
      }

      terminate(entry, 'requested')
      return true
    },

    stats() {
      return {
        size,
        queued: queue.length,
        active: slots.filter((slot) => slot.entry !== null).length,
        started,
        completed,
        discarded,
        cancelled,
        workersAlive: slots.filter((slot) => slot.worker !== null).length,
        terminations,
      }
    },

    destroy() {
      destroyed = true
      cancelled = true

      // A queued entry is in both collections, so dedupe rather than relying on settle() to swallow
      // the second visit.
      const outstanding = new Set<Entry>([...queue, ...live.values()])
      queue = []

      for (const entry of outstanding) {
        const wasRunning = entry.slot !== null
        retire(entry)
        settle(
          entry,
          wasRunning
            ? {
                token: entry.token,
                imageId: entry.job.imageId,
                outcome: 'terminated',
                cause: 'requested',
              }
            : { token: entry.token, imageId: entry.job.imageId, outcome: 'cancelled' },
        )
      }

      for (const slot of slots) {
        if (slot.worker) {
          slot.worker.terminate()
          slot.worker = null
        }
        slot.entry = null
      }
    },
  }
}
