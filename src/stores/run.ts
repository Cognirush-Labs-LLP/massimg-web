import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Caveat, FailureReason, ImageId, SizeTargetSkipReason } from '@/domain/types'
import { useBatchStore } from './batch'

export interface RunProgress {
  pending: number
  succeeded: number
  failed: number
  skipped: number
}

export interface RunFailureEntry {
  imageId: ImageId
  reason: FailureReason
}

export interface RunCaveatEntry {
  imageId: ImageId
  caveats: Caveat[]
}

export interface RunSuccessEntry {
  imageId: ImageId
  inputBytes: number
  outputBytes: number
}

export interface RunSkippedEntry {
  imageId: ImageId
  reason: SizeTargetSkipReason
}

/** Technical Design §3.3's discriminated delivery state, replacing T32's `downloaded` boolean. */
export type RunDelivery = 'pending' | 'downloaded' | 'shared'

/**
 * A delivery attempt that failed in a way worth stating inline, with the action still retryable
 * (R-X50, §10). The three kinds are three different §10 rows with three different messages, and
 * collapsing them would leave the user guessing which of "the archive could not be read", "your
 * browser blocked the download" and "the share handoff failed" happened.
 *
 * Share *cancellation* is deliberately absent: R-X50 says it is not an error.
 */
export type RunDeliveryError = 'download-assembly' | 'download-blocked' | 'share'

/**
 * Run progress (Technical Design §3.3): counts by state, accumulated input/output bytes,
 * failures, skips and caveats. The completed result remains available after returning to Gallery;
 * `startRun` resets every field and clears prior per-image run statuses before the next run.
 *
 * Populated by worker result messages as they arrive. `recordResult`'s parameter shape is
 * intentionally minimal here — T38 (Processing view) is what wires this store to the real
 * worker protocol (`src/pipeline/protocol.ts`) and may need to adjust it once that integration
 * exists; see docs/task-notes/T32.md.
 *
 * `finished` and `delivery` are what R-X18's leave-without-delivering confirmation and R-X54's
 * delivered state are driven from — this store renders neither itself.
 */
export const useRunStore = defineStore('run', () => {
  const progress = ref<RunProgress>({ pending: 0, succeeded: 0, failed: 0, skipped: 0 })
  const inputBytes = ref(0)
  const outputBytes = ref(0)
  const failures = ref<RunFailureEntry[]>([])
  const skipped = ref<RunSkippedEntry[]>([])
  const caveats = ref<RunCaveatEntry[]>([])
  const successes = ref<RunSuccessEntry[]>([])
  /** Wall-clock run start, for the report's `Run:` timestamp (T41). Set by `startRun`. */
  const runStartedAt = ref<Date | null>(null)
  const finished = ref(false)
  /**
   * R-X50: only a completed Download or a *resolved* `navigator.share()` leaves `pending`. Share
   * cancellation and every handoff failure leave it exactly where it was, so the results and both
   * available actions survive.
   */
  const delivery = ref<RunDelivery>('pending')
  /**
   * The last delivery attempt's retryable failure, or `null`. Lives in the store rather than in
   * `Processing.vue` because `downloadFinishedRun()` has two call sites — the on-screen Download
   * button and the back guard's "Download and leave" — and a failure from either must surface
   * through the one inline message Processing renders.
   */
  const deliveryError = ref<RunDeliveryError | null>(null)
  /**
   * Set when the run was halted rather than completed normally (T39, §10 "Out of memory"; T40,
   * §10 "Storage write failure mid-run"). Distinct from an ordinary Cancel, which leaves straight
   * for Gallery with no terminal state at all (R-X19/R-X20) — a halt still sets `finished`, so
   * Processing.vue's existing completed branch renders, but swaps its actions for the halted
   * message and never offers Download, matching "partial results discarded". `progress.pending` is
   * left exactly where it was: jobs never submitted after the halt are not relabelled as failed.
   */
  const haltReason = ref<'out-of-memory' | 'storage-failure' | null>(null)

  function startRun(totalPending: number): void {
    useBatchStore().clearRunStatuses()
    progress.value = { pending: totalPending, succeeded: 0, failed: 0, skipped: 0 }
    inputBytes.value = 0
    outputBytes.value = 0
    failures.value = []
    skipped.value = []
    caveats.value = []
    successes.value = []
    runStartedAt.value = new Date()
    finished.value = false
    delivery.value = 'pending'
    deliveryError.value = null
    haltReason.value = null
  }

  function recordResult(
    imageId: ImageId,
    outcome:
      | { kind: 'succeeded'; inputBytes: number; outputBytes: number; caveats: Caveat[] }
      | { kind: 'failed'; reason: FailureReason }
      | { kind: 'skipped'; reason: SizeTargetSkipReason },
  ): void {
    progress.value.pending -= 1

    if (outcome.kind === 'succeeded') {
      progress.value.succeeded += 1
      inputBytes.value += outcome.inputBytes
      outputBytes.value += outcome.outputBytes
      successes.value.push({
        imageId,
        inputBytes: outcome.inputBytes,
        outputBytes: outcome.outputBytes,
      })

      if (outcome.caveats.length > 0) {
        caveats.value.push({ imageId, caveats: outcome.caveats })
      }
    } else if (outcome.kind === 'failed') {
      progress.value.failed += 1
      failures.value.push({ imageId, reason: outcome.reason })
      useBatchStore().markFailed(imageId, outcome.reason)
    } else {
      progress.value.skipped += 1
      skipped.value.push({ imageId, reason: outcome.reason })
      useBatchStore().markSkipped(imageId, outcome.reason)
    }
  }

  function finishRun(): void {
    finished.value = true
  }

  function haltRun(reason: 'out-of-memory' | 'storage-failure'): void {
    haltReason.value = reason
    finished.value = true
  }

  // A successful delivery clears any earlier retry message with it: the run is fulfilled, so a
  // stale "your browser blocked the download" line beside the checked state would be a lie.
  function markDownloaded(): void {
    delivery.value = 'downloaded'
    deliveryError.value = null
  }

  function markShared(): void {
    delivery.value = 'shared'
    deliveryError.value = null
  }

  function markDeliveryFailed(kind: RunDeliveryError): void {
    deliveryError.value = kind
  }

  return {
    progress,
    inputBytes,
    outputBytes,
    failures,
    skipped,
    caveats,
    successes,
    runStartedAt,
    finished,
    delivery,
    deliveryError,
    haltReason,
    startRun,
    recordResult,
    finishRun,
    haltRun,
    markDownloaded,
    markShared,
    markDeliveryFailed,
  }
})
