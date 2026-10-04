// Processing's run-orchestration composable (T38). Mirrors src/ui/preview/usePreviewEncode.ts's
// established patterns: a job built from `resolveSettings` + the stored source file, submitted to
// this stage's own worker pool, and a generation counter that drops any outcome belonging to a torn
// -down run rather than letting it reach the (possibly already-reset) store.
//
// The generation guard exists for a real reason, not by analogy alone: useBackNavigationGuard.ts's
// `handleProcessingPop()` calls `uiStore.cancelProcessing()` directly on a back-button press during
// an in-progress run, bypassing this composable's own `cancel()` entirely. Component unmount
// (Processing.vue is exclusively mounted, so every exit path tears it down) is the one hook
// guaranteed to fire regardless of which path was taken, so `onScopeDispose` is what actually
// prevents a straggling job from one run corrupting a second run's freshly-reset counters.
import { computed, onScopeDispose, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import { resolveSettings, type BatchSettings } from '@/domain/job'
import type { ImageId, ImageRecord, Job } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobResult } from '@/pipeline/protocol'
import { getSourceFile } from '@/platform/source-files'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { getProcessingPool } from './processing-pool'

export interface ProcessingRunState {
  total: ComputedRef<number>
  /** succeeded + failed + skipped. */
  processed: ComputedRef<number>
  stopping: Ref<boolean>
  start: () => void
  cancel: () => Promise<void>
}

export function useProcessingRun(): ProcessingRunState {
  const pool = getProcessingPool()
  // A previous Processing session may have left the pool's cancel flag set (Cancel, or the
  // unmount guard below); resuming here is what makes R-X17's "run again" free of a codec reload.
  pool.resume()

  const batchStore = useBatchStore()
  const settingsStore = useSettingsStore()
  const runStore = useRunStore()
  const uiStore = useUiStore()

  const stopping = ref(false)
  let outstanding: Promise<void>[] = []
  let generation = 0

  const total = computed(() => {
    const progress = runStore.progress
    return progress.pending + progress.succeeded + progress.failed + progress.skipped
  })
  const processed = computed(() => {
    const progress = runStore.progress
    return progress.succeeded + progress.failed + progress.skipped
  })

  function applyResult(imageId: ImageId, inputBytes: number, result: JobResult): void {
    if (result.kind === 'output') {
      runStore.recordResult(imageId, {
        kind: 'succeeded',
        inputBytes,
        outputBytes: result.bytes.byteLength,
        caveats: result.caveats,
      })
      return
    }

    if (result.kind === 'size-target-unreachable') {
      runStore.recordResult(imageId, { kind: 'skipped', reason: result })
      return
    }

    // 'jpeg-recovery' / 'dimension-recovery' only ever come back from the Preview-only recovery
    // job shapes (JpegRecoveryJob/DimensionRecoveryJob), never from an `intent: 'run'` Job — this
    // branch is unreachable in practice, handled rather than left to throw.
    runStore.recordResult(imageId, { kind: 'failed', reason: { kind: 'encode-failed' } })
  }

  function applyOutcome(imageId: ImageId, inputBytes: number, outcome: JobOutcome): void {
    switch (outcome.outcome) {
      case 'completed':
        applyResult(imageId, inputBytes, outcome.result)
        return
      case 'failed':
        if (outcome.reason.kind === 'out-of-memory') {
          // §10 "Out of memory": halts the whole run rather than being recorded as one more
          // per-image failure (T38's handover note; T39 builds this). `runOne`'s own
          // `generation !== expected` check already guarantees this outcome belongs to the current
          // run before `applyOutcome` is ever called, so no further guard is needed here.
          generation += 1 // drop every other still-outstanding outcome from this run
          pool.cancel()
          runStore.haltRun('out-of-memory')
          return
        }
        runStore.recordResult(imageId, {
          kind: 'failed',
          // `unimplemented` has no FailureReason slot (it is an internal pipeline gap, not a
          // product-facing distinction R-X11 asks for) — coerced to the same message as any other
          // encode failure.
          reason:
            outcome.reason.kind === 'unimplemented' ? { kind: 'encode-failed' } : outcome.reason,
        })
        return
      case 'terminated':
        // The `jobTimeoutMs` watchdog is currently inert (null in runtime limits), so only a real
        // worker crash reaches here today. R-X10: the run continues; this image is simply failed.
        runStore.recordResult(imageId, { kind: 'failed', reason: { kind: 'encode-failed' } })
        return
      case 'cancelled':
        // R-X20: a queued job Cancel never let start is discarded, not recorded as any kind of
        // outcome — it must not touch the store at all.
        return
      case 'superseded':
        // Unreachable: each image is submitted exactly once per run, and the generation guard
        // above already prevents a second run's jobs from colliding with a first run's tokens.
        return
    }
  }

  async function runOne(image: ImageRecord, expected: number): Promise<void> {
    const settings: BatchSettings = {
      quality: toRaw(settingsStore.quality),
      dimension: toRaw(settingsStore.dimension),
      format: settingsStore.format,
    }

    const resolution = resolveSettings(image, settings)

    if (resolution.kind === 'rejected') {
      if (generation === expected) {
        runStore.recordResult(image.id, { kind: 'failed', reason: { kind: 'encode-failed' } })
      }
      return
    }

    const file = getSourceFile(image.id)

    if (file === undefined) {
      if (generation === expected) {
        runStore.recordResult(image.id, { kind: 'failed', reason: { kind: 'decode-failed' } })
      }
      return
    }

    let source: Uint8Array
    try {
      source = new Uint8Array(await file.arrayBuffer())
    } catch {
      if (generation === expected) {
        runStore.recordResult(image.id, { kind: 'failed', reason: { kind: 'decode-failed' } })
      }
      return
    }

    if (generation !== expected) {
      return
    }

    // `caveats: resolution.caveats` carries resolution-time caveats (R-F6's animation substitution
    // is the one that exists today) into the report — `executeJob`'s `caveatsForRun` only merges
    // these for `intent: 'run'`, and dropping them here would silently lose them, unlike Preview's
    // own job construction, where `intent: 'preview'` makes the omission harmless.
    const job: Job = {
      imageId: image.id,
      source,
      edit: image.edit,
      settings: resolution.settings,
      intent: 'run',
      caveats: resolution.caveats,
    }

    const outcome = await pool.run(job).done

    if (generation !== expected) {
      return
    }

    applyOutcome(image.id, source.byteLength, outcome)
  }

  function start(): void {
    const expected = (generation += 1)
    stopping.value = false

    // R-X1: grid order is the batch array's own insertion order (see stores/batch.ts). `toRaw`
    // avoids handing a worker a reactive Proxy, which fails structured clone at `postMessage` time
    // (see usePreviewEncode.ts's own note on this).
    const images = batchStore.images.map((image) => toRaw(image))
    runStore.startRun(images.length)

    outstanding = images.map((image) => runOne(image, expected))

    void Promise.all(outstanding).then(() => {
      // Guarded so a Cancel racing the very last image's natural completion can't flip `finished`
      // after cancel() has already decided this run is over.
      if (generation === expected && !stopping.value) {
        runStore.finishRun()
      }
    })
  }

  async function cancel(): Promise<void> {
    stopping.value = true // R-X27: the button reads "Stopping" immediately.
    pool.cancel() // R-X26: queued jobs settle 'cancelled' now; in-flight jobs finish normally.
    await Promise.all(outstanding) // Bounded by at most one image per busy worker.
    uiStore.cancelProcessing() // R-X19/R-X20: straight to Gallery, no dialog.
  }

  onScopeDispose(() => {
    generation += 1
    pool.cancel()
  })

  return { total, processed, stopping, start, cancel }
}
