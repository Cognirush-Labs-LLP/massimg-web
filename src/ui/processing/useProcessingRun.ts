// Processing's run-orchestration composable (T38, extended by T40 for archive/Share assembly).
// Mirrors src/ui/preview/usePreviewEncode.ts's established patterns: a job built from
// `resolveSettings` + the stored source file, submitted to this stage's own worker pool, and a
// generation counter that drops any outcome belonging to a torn-down run rather than letting it
// reach the (possibly already-reset) store.
//
// The generation guard exists for a real reason, not by analogy alone: useBackNavigationGuard.ts's
// `handleProcessingPop()` calls `uiStore.cancelProcessing()` directly on a back-button press during
// an in-progress run, bypassing this composable's own `cancel()` entirely. Component unmount
// (Processing.vue is exclusively mounted, so every exit path tears it down) is the one hook
// guaranteed to fire regardless of which path was taken, so `onScopeDispose` is what actually
// prevents a straggling job from one run corrupting a second run's freshly-reset counters — and,
// since T40, from leaving an archive stream open or an output copy un-cleaned-up behind it.
import { computed, onScopeDispose, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import { runtimeLimits } from '@/config/limits'
import { resolveOutputNames, resolveShareNames, type NamingInput } from '@/domain/naming'
import { resolveSettings, type BatchSettings, type SettingsResolution } from '@/domain/job'
import type { ImageId, ImageRecord, Job } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobResult } from '@/pipeline/protocol'
import {
  openRunArchiveSink,
  preflightRunArchive,
  type NamingEntry,
  type RunArchiveSink,
} from '@/pipeline/run-archive'
import { buildRunReportEntry } from '@/pipeline/run-report'
import { deleteAllOutputCopies, readOutputCopies } from '@/platform/opfs'
import { getSourceFile } from '@/platform/source-files'
import { canShareExactFiles, probeFileShareForRun } from '@/platform/share'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { getProcessingPool } from './processing-pool'

export interface QuotaRejection {
  requiredBytes: number
  availableBytes: number
}

export interface ProcessingRunState {
  total: ComputedRef<number>
  /** succeeded + failed + skipped. */
  processed: ComputedRef<number>
  stopping: Ref<boolean>
  /** Set instead of starting the run at all when the pre-run storage preflight (R-X40) finds the
   * predicted archive will not fit. No job is ever dispatched in this case. */
  quotaRejection: Ref<QuotaRejection | null>
  /**
   * R-X48's answer, decided once after the run completes: whether **Share** may be rendered. False
   * until then, and false for the whole run whenever any of R-X47's run-start eligibility, the
   * `maximumShareBytes` total or the exact `navigator.canShare({ files })` check says no.
   */
  shareAvailable: Ref<boolean>
  start: () => void
  cancel: () => Promise<void>
}

type ResolvedResolution = Extract<SettingsResolution, { kind: 'resolved' }>

function isResolved<T extends { resolution: SettingsResolution }>(
  entry: T,
): entry is T & { resolution: ResolvedResolution } {
  return entry.resolution.kind === 'resolved'
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
  const quotaRejection = ref<QuotaRejection | null>(null)
  const shareAvailable = ref(false)
  let outstanding: Promise<void>[] = []
  let generation = 0
  let currentSink: RunArchiveSink | null = null

  const total = computed(() => {
    const progress = runStore.progress
    return progress.pending + progress.succeeded + progress.failed + progress.skipped
  })
  const processed = computed(() => {
    const progress = runStore.progress
    return progress.succeeded + progress.failed + progress.skipped
  })

  async function applyResult(
    imageId: ImageId,
    inputBytes: number,
    result: JobResult,
    sink: RunArchiveSink | null,
  ): Promise<void> {
    if (result.kind === 'output') {
      // May throw on a mid-run storage failure — propagated to runOne's caller, which halts the
      // run (§10 "Storage write failure mid-run"). Done before recordResult: if this throws, the
      // run is about to halt entirely, so there is no value in first recording a success that is
      // the last thing this run will ever record for this image.
      if (sink) {
        await sink.submit(imageId, result.bytes, result.format)
      }
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

  async function applyOutcome(
    imageId: ImageId,
    inputBytes: number,
    outcome: JobOutcome,
    sink: RunArchiveSink | null,
  ): Promise<void> {
    switch (outcome.outcome) {
      case 'completed':
        await applyResult(imageId, inputBytes, outcome.result, sink)
        return
      case 'failed':
        if (outcome.reason.kind === 'out-of-memory') {
          // §10 "Out of memory": halts the whole run rather than being recorded as one more
          // per-image failure (T38's handover note; T39 builds this). `runOne`'s own
          // `generation !== expected` check already guarantees this outcome belongs to the current
          // run before `applyOutcome` is ever called, so no further guard is needed here.
          generation += 1 // drop every other still-outstanding outcome from this run
          pool.cancel()
          await sink?.abortAndCleanup()
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

  async function runOne(
    image: ImageRecord,
    resolution: SettingsResolution,
    expected: number,
    sink: RunArchiveSink | null,
  ): Promise<void> {
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

    try {
      await applyOutcome(image.id, source.byteLength, outcome, sink)
    } catch (error) {
      console.error('Run halted: a storage write failed.', error)
      // A sink write failed (OPFS quota exhausted or a real storage error mid-run) — halt the same
      // way out-of-memory does, but distinctly (§10 "Storage write failure mid-run", closed by
      // T40; T39's handover deferred this row to whoever built the mechanism).
      if (generation === expected) {
        generation += 1
        pool.cancel()
        await sink?.abortAndCleanup()
        runStore.haltRun('storage-failure')
      }
    }
  }

  async function runInternal(expected: number): Promise<void> {
    // R-X1: grid order is the batch array's own insertion order (see stores/batch.ts). `toRaw`
    // avoids handing a worker a reactive Proxy, which fails structured clone at `postMessage` time
    // (see usePreviewEncode.ts's own note on this).
    const images = batchStore.images.map((image) => toRaw(image))

    const settings: BatchSettings = {
      quality: toRaw(settingsStore.quality),
      dimension: toRaw(settingsStore.dimension),
      format: settingsStore.format,
      animatedAsWebp: settingsStore.animatedAsWebp,
    }

    // Resolved once, up front, in batch order — not lazily per image as before T40. Naming must
    // see every image in one call for its per-directory collision resolution to be deterministic,
    // independent of which worker happens to finish first (domain/naming.ts).
    const resolved = images.map((image) => ({
      image,
      resolution: resolveSettings(image, settings),
    }))
    const accepted = resolved.filter(isResolved)

    const namingInputs: NamingInput[] = accepted.map(({ image, resolution }) => ({
      name: image.name,
      relativePath: image.relativePath,
      sourceFormat: image.sourceFormat,
      formatSetting: settings.format,
      resolvedFormat: resolution.settings.format,
    }))
    const paths = resolveOutputNames(namingInputs)
    const pathsByImage = new Map<ImageId, string>(
      accepted.map(({ image }, index) => [image.id, paths[index] as string]),
    )
    const namingEntries: NamingEntry[] = accepted.map(({ image }, index) => ({
      imageId: image.id,
      path: paths[index] as string,
      sizeBytes: image.sizeBytes,
    }))

    const multiImage = images.length > 1
    let shareEligible = false

    if (multiImage) {
      const formats = [...new Set(accepted.map(({ resolution }) => resolution.settings.format))]
      const preliminaryProbe = formats.length > 0 ? await probeFileShareForRun(formats) : false

      if (generation !== expected) {
        return // superseded while awaiting the probe
      }

      const preflight = await preflightRunArchive(namingEntries, preliminaryProbe)

      if (generation !== expected) {
        return
      }

      if (!preflight.archive.ok) {
        quotaRejection.value = {
          requiredBytes: preflight.archive.required,
          availableBytes: preflight.archive.available,
        }
        return
      }

      shareEligible = preflight.shareEligible
    }

    if (images.length === 0) {
      return
    }

    // R-X53's flattened, globally-deduplicated Share names, built from the same accepted list in
    // the same grid order as the ZIP's own names — a second, independent collision scope over one
    // ordered candidate list (Technical Design §9.4), not a transformation of `paths`. Only built
    // when the run will actually write Share copies; the `Map`'s insertion order is also what
    // fixes each copy's grid index inside the sink (R-X49).
    let shareNamesByImage: Map<ImageId, string> | undefined
    if (shareEligible) {
      const shareNames = resolveShareNames(namingInputs)
      shareNamesByImage = new Map<ImageId, string>(
        accepted.map(({ image }, index) => [image.id, shareNames[index] as string]),
      )
    }

    const sink = openRunArchiveSink({
      pathsByImage,
      multiImage,
      shareEligible,
      shareNamesByImage,
    })
    currentSink = sink

    runStore.startRun(images.length)

    outstanding = resolved.map(({ image, resolution }) => runOne(image, resolution, expected, sink))

    void Promise.all(outstanding).then(async () => {
      if (generation !== expected) {
        return
      }

      try {
        // R-X16: a single-image run has no report at all.
        await sink.finish(multiImage ? buildRunReportEntry() : undefined)
      } catch (error) {
        if (generation === expected) {
          console.error('Run halted: finishing the archive failed.', error)
          await sink.abortAndCleanup()
          runStore.haltRun('storage-failure')
        }
        return
      }

      // Guarded so a Cancel racing the very last image's natural completion can't flip `finished`
      // after cancel() has already decided this run is over.
      if (generation === expected && !stopping.value) {
        runStore.finishRun()
        // A storage error while merely *checking* shareability is one of R-X48's "failure of any
        // of these checks": Share is not offered, Download is left exactly as it was. It must not
        // halt a run that has already completed successfully, so it is caught here rather than
        // joining the storage-failure path above.
        await decideShareAvailability(expected, multiImage, shareEligible).catch(() => {})
      }
    })
  }

  /**
   * R-X48, run once at completion. Three checks, in the order that avoids paying for a later one
   * the earlier one already settles: at least one success, the measured `maximumShareBytes` total,
   * and finally the exact `navigator.canShare({ files })` on the real completed array — which
   * T39-A proved is the only one of the three that can speak for the platform.
   *
   * `attemptCheck` is where R-X47's two eligible shapes diverge. A multi-image run had to pass the
   * run-start probe/preflight to have written any Share copies at all, so an ineligible one has
   * nothing to check. A run that *started* with exactly one image had no retention decision to
   * make — R-X51 writes its single direct artifact unconditionally and R-X49 makes that same file
   * the share payload — so there was never a preliminary probe to gate it, and R-X48's exact check
   * is the whole answer. See docs/task-notes/T42.md for the reading this rests on.
   */
  async function decideShareAvailability(
    expected: number,
    multiImage: boolean,
    shareEligible: boolean,
  ): Promise<void> {
    const attemptCheck = multiImage ? shareEligible : true
    if (!attemptCheck || runStore.progress.succeeded === 0) {
      return
    }

    // T39-A: `canShare` keeps answering `true` well past the byte total at which `share()` itself
    // starts throwing, so the measured ceiling is applied *first* and the exact array is not even
    // read back when it cannot be offered anyway.
    const totalShareBytes = runStore.successes.reduce((sum, entry) => sum + entry.outputBytes, 0)
    const files = totalShareBytes <= runtimeLimits.maximumShareBytes ? await readOutputCopies() : []

    if (generation !== expected) {
      return
    }

    const shareable = files.length > 0 && (await canShareExactFiles(files))

    if (generation !== expected) {
      return
    }

    if (shareable) {
      shareAvailable.value = true
      return
    }

    // R-X48: "removes the individual share copies and leaves Download unchanged". Only safe once
    // the archive is the Download artifact — a run reduced to exactly one success has no archive,
    // and that one copy *is* its R-X16 direct download, so deleting it here would take Download
    // down with Share.
    if (runStore.progress.succeeded > 1) {
      await deleteAllOutputCopies()
    }
  }

  function start(): void {
    const expected = (generation += 1)
    stopping.value = false
    quotaRejection.value = null
    shareAvailable.value = false
    void runInternal(expected)
  }

  async function cancel(): Promise<void> {
    stopping.value = true // R-X27: the button reads "Stopping" immediately.
    pool.cancel() // R-X26: queued jobs settle 'cancelled' now; in-flight jobs finish normally.
    await Promise.all(outstanding) // Bounded by at most one image per busy worker.
    await currentSink?.abortAndCleanup()
    uiStore.cancelProcessing() // R-X19/R-X20: straight to Gallery, no dialog.
  }

  onScopeDispose(() => {
    generation += 1
    pool.cancel()
    // Awaited asynchronously (onScopeDispose itself cannot be async): every in-flight `runOne` must
    // settle before cleanup, the same ordering `cancel()` uses, or a straggling `sink.submit()`
    // could still be mid-write when `abortAndCleanup()` deletes the directory out from under it.
    void (async () => {
      await Promise.all(outstanding)
      await currentSink?.abortAndCleanup()
    })()
  })

  return { total, processed, stopping, quotaRejection, shareAvailable, start, cancel }
}
