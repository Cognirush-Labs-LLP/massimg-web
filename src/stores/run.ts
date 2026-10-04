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

export interface RunSkippedEntry {
  imageId: ImageId
  reason: SizeTargetSkipReason
}

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
 * `finished` and `downloaded` expose enough state for T42's R-X18 leave-without-downloading
 * confirmation to be built against later — this store does not build that confirmation itself.
 */
export const useRunStore = defineStore('run', () => {
  const progress = ref<RunProgress>({ pending: 0, succeeded: 0, failed: 0, skipped: 0 })
  const inputBytes = ref(0)
  const outputBytes = ref(0)
  const failures = ref<RunFailureEntry[]>([])
  const skipped = ref<RunSkippedEntry[]>([])
  const caveats = ref<RunCaveatEntry[]>([])
  const finished = ref(false)
  const downloaded = ref(false)
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
    finished.value = false
    downloaded.value = false
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

  function markDownloaded(): void {
    downloaded.value = true
  }

  return {
    progress,
    inputBytes,
    outputBytes,
    failures,
    skipped,
    caveats,
    finished,
    downloaded,
    haltReason,
    startRun,
    recordResult,
    finishRun,
    haltRun,
    markDownloaded,
  }
})
