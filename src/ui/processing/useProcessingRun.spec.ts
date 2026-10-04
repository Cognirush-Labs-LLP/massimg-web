import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import type { ImageId, ImageRecord, PipelineJob } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken, OutputJobResult } from '@/pipeline/protocol'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useUiStore } from '@/stores/ui'

interface PendingRun {
  job: PipelineJob
  settle: (outcome: JobOutcome) => void
}

let runs: PendingRun[] = []
const cancel = vi.fn()
const resume = vi.fn()
const run = vi.fn((job: PipelineJob) => {
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve
  })

  runs.push({ job, settle })

  return { token: runs.length as JobToken, done }
})

vi.mock('./processing-pool', () => ({ getProcessingPool: () => ({ run, cancel, resume }) }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

const { useProcessingRun } = await import('./useProcessingRun')

function image(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: id as ImageId,
    name: `${id}.jpeg`,
    relativePath: null,
    sizeBytes: 1000,
    width: 800,
    height: 600,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    skipReason: null,
    ...overrides,
  }
}

function seed(ids: string[]): void {
  for (const id of ids) {
    sourceFiles.set(id as ImageId, new File([new Uint8Array([1, 2, 3])], `${id}.jpeg`))
  }
  useBatchStore().addImages(ids.map((id) => image(id)))
}

function completedOutput(imageId: string, bytes = 500): JobOutcome {
  const result: OutputJobResult = {
    kind: 'output',
    bytes: new Uint8Array(bytes),
    format: 'jpeg',
    selection: { kind: 'encoded' },
    caveats: [],
  }
  return { token: 1 as JobToken, imageId: imageId as ImageId, outcome: 'completed', result }
}

function setupRun(): { run: ReturnType<typeof useProcessingRun>; dispose: () => void } {
  const scope = effectScope()
  let api!: ReturnType<typeof useProcessingRun>
  scope.run(() => {
    api = useProcessingRun()
  })
  return { run: api, dispose: () => scope.stop() }
}

const flush = flushPromises

beforeEach(() => {
  setActivePinia(createPinia())
  runs = []
  cancel.mockClear()
  resume.mockClear()
  run.mockClear()
  sourceFiles.clear()
})

describe('useProcessingRun.start', () => {
  it('runs every image and reports correct final counts (Done-when: mixed failures complete correctly)', async () => {
    seed(['a', 'b', 'c'])
    const { run: api } = setupRun()

    api.start()
    await flush()

    expect(runs).toHaveLength(3)
    runs[0]?.settle(completedOutput('a', 400))
    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'b' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    runs[2]?.settle({
      token: 3 as JobToken,
      imageId: 'c' as ImageId,
      outcome: 'completed',
      result: {
        kind: 'size-target-unreachable',
        targetBytes: 100,
        achievedBytes: 200,
        format: 'jpeg',
        width: 800,
        height: 600,
      },
    })
    await flush()

    const runStore = useRunStore()
    expect(runStore.progress).toEqual({ pending: 0, succeeded: 1, failed: 1, skipped: 1 })
    expect(runStore.finished).toBe(true)
  })

  it('a failure does not stop remaining jobs from being submitted (R-X10)', async () => {
    seed(['a', 'b'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    expect(runs).toHaveLength(2)

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'encode-failed' },
    })
    await flush()
    runs[1]?.settle(completedOutput('b'))
    await flush()

    expect(useRunStore().progress).toEqual({ pending: 0, succeeded: 1, failed: 1, skipped: 0 })
  })

  it('coerces an "unimplemented" pipeline failure onto encode-failed', async () => {
    seed(['a'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'unimplemented', detail: 'cicp' },
    })
    await flush()

    expect(useRunStore().failures).toEqual([{ imageId: 'a', reason: { kind: 'encode-failed' } }])
  })

  it('does not record anything for a queued job Cancel settled as cancelled (R-X20)', async () => {
    seed(['a'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle({ token: 1 as JobToken, imageId: 'a' as ImageId, outcome: 'cancelled' })
    await flush()

    const runStore = useRunStore()
    expect(runStore.progress).toEqual({ pending: 1, succeeded: 0, failed: 0, skipped: 0 })
    expect(runStore.failures).toEqual([])
    expect(runStore.skipped).toEqual([])
  })
})

describe('useProcessingRun out-of-memory halt (T39, §10 "Out of memory")', () => {
  it('halts the run, cancels the pool, and never records the out-of-memory reason as an ordinary failure', async () => {
    seed(['a', 'b', 'c'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    expect(runs).toHaveLength(3)

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'out-of-memory' },
    })
    await flush()

    const runStore = useRunStore()
    expect(runStore.haltReason).toBe('out-of-memory')
    expect(runStore.finished).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    // Never reaches recordResult's ordinary failed path (distinct from §10's "Corrupt or
    // undecodable file" / "Encode failure" rows, which do land in the Failed list).
    expect(runStore.failures).toEqual([])
    expect(runStore.progress.failed).toBe(0)
  })

  it('drops any other outcome that settles after the halt, succeeded or not', async () => {
    seed(['a', 'b'])
    const { run: api } = setupRun()

    api.start()
    await flush()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'out-of-memory' },
    })
    await flush()

    // An in-flight job that finishes successfully just after the halt must not be recorded —
    // "partial results discarded" (§10).
    runs[1]?.settle(completedOutput('b'))
    await flush()

    const runStore = useRunStore()
    expect(runStore.progress.succeeded).toBe(0)
    expect(runStore.haltReason).toBe('out-of-memory')
  })
})

describe('useProcessingRun.cancel', () => {
  it('flips to Gallery only after the in-flight job settles, and does not mark the run finished', async () => {
    seed(['a'])
    const { run: api } = setupRun()
    const uiStore = useUiStore()
    uiStore.enterProcessing()

    api.start()
    await flush()

    const cancelPromise = api.cancel()
    await flush()

    expect(api.stopping.value).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    // Still in flight — cancel() must not resolve, and the mode must not have changed, yet.
    expect(uiStore.stageMode).toBe('processing')

    runs[0]?.settle(completedOutput('a'))
    await cancelPromise

    expect(uiStore.stageMode).toBe('gallery')
    expect(useRunStore().finished).toBe(false)
  })

  it('keeps the recorded outcome of an image that completed before Cancel was pressed', async () => {
    seed(['a', 'b'])
    const { run: api } = setupRun()
    useUiStore().enterProcessing()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    const cancelPromise = api.cancel()
    runs[1]?.settle({ token: 2 as JobToken, imageId: 'b' as ImageId, outcome: 'cancelled' })
    await cancelPromise

    const runStore = useRunStore()
    expect(runStore.progress.succeeded).toBe(1)
    expect(runStore.progress.pending).toBe(1)
  })
})

describe('useProcessingRun unmount', () => {
  it('drops a straggling outcome that arrives after the composable scope is torn down', async () => {
    seed(['a'])
    const { run: api, dispose } = setupRun()

    api.start()
    await flush()
    dispose()
    expect(cancel).toHaveBeenCalledTimes(1)

    runs[0]?.settle(completedOutput('a'))
    await flush()

    // No store to assert against post-dispose would be safe here if a *second* run had started;
    // the direct assertion is that recordResult-driven state did not move after teardown.
    expect(useRunStore().progress).toEqual({ pending: 1, succeeded: 0, failed: 0, skipped: 0 })
  })
})
