import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Caveat, FailureReason, ImageId } from '@/domain/types'

export interface RunProgress {
  pending: number
  succeeded: number
  failed: number
}

export interface RunFailureEntry {
  imageId: ImageId
  reason: FailureReason
}

export interface RunCaveatEntry {
  imageId: ImageId
  caveats: Caveat[]
}

/**
 * Run progress (Technical Design §3.3): counts by state, accumulated input/output bytes,
 * failures and caveats. Exists only during and immediately after a Processing run — `startRun`
 * resets every field, so a store instance never carries a stale run into the next one.
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
  const progress = ref<RunProgress>({ pending: 0, succeeded: 0, failed: 0 })
  const inputBytes = ref(0)
  const outputBytes = ref(0)
  const failures = ref<RunFailureEntry[]>([])
  const caveats = ref<RunCaveatEntry[]>([])
  const finished = ref(false)
  const downloaded = ref(false)

  function startRun(totalPending: number): void {
    progress.value = { pending: totalPending, succeeded: 0, failed: 0 }
    inputBytes.value = 0
    outputBytes.value = 0
    failures.value = []
    caveats.value = []
    finished.value = false
    downloaded.value = false
  }

  function recordResult(
    imageId: ImageId,
    outcome:
      | { kind: 'succeeded'; inputBytes: number; outputBytes: number; caveats: Caveat[] }
      | { kind: 'failed'; reason: FailureReason },
  ): void {
    progress.value.pending -= 1

    if (outcome.kind === 'succeeded') {
      progress.value.succeeded += 1
      inputBytes.value += outcome.inputBytes
      outputBytes.value += outcome.outputBytes

      if (outcome.caveats.length > 0) {
        caveats.value.push({ imageId, caveats: outcome.caveats })
      }
    } else {
      progress.value.failed += 1
      failures.value.push({ imageId, reason: outcome.reason })
    }
  }

  function finishRun(): void {
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
    caveats,
    finished,
    downloaded,
    startRun,
    recordResult,
    finishRun,
    markDownloaded,
  }
})
