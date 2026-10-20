import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { runtimeLimits } from '@/config/limits'
import type { ImageId, ImageRecord, PipelineJob } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken, OutputJobResult } from '@/pipeline/protocol'
import { deleteRunArtifacts, readArchive } from '@/platform/opfs'
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

// Every other test in this file relies on the *real* platform/opfs, platform/share and
// pipeline/run-archive modules, which degrade gracefully to jsdom's in-memory fallback (no real
// OPFS, no navigator.canShare) — that is itself useful end-to-end coverage. These two functions are
// wrapped (not replaced) so the T40-specific tests below can force a quota rejection or a storage
// failure for one call while every other test keeps exercising the real fallback behaviour.
vi.mock('@/platform/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/opfs')>()
  return {
    ...actual,
    checkCombinedQuota: vi.fn(actual.checkCombinedQuota),
    writeOutputCopy: vi.fn(actual.writeOutputCopy),
    readOutputCopies: vi.fn(actual.readOutputCopies),
    deleteAllOutputCopies: vi.fn(actual.deleteAllOutputCopies),
  }
})

// Same wrap-don't-replace treatment for platform/share (T42). jsdom has no `navigator.canShare`
// at all, so the real functions always answer `false` — which is the right default for every
// pre-T42 test in this file, and useless for exercising the Share path, hence the per-test
// overrides below. The real functions' own behaviour is covered by src/platform/share.spec.ts
// and, on real engines, tests/e2e/share.spec.ts.
vi.mock('@/platform/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/share')>()
  return {
    ...actual,
    probeFileShareForRun: vi.fn(actual.probeFileShareForRun),
    canShareExactFiles: vi.fn(actual.canShareExactFiles),
  }
})

const { useProcessingRun } = await import('./useProcessingRun')
const { checkCombinedQuota, writeOutputCopy, readOutputCopies, deleteAllOutputCopies } =
  await import('@/platform/opfs')
const { probeFileShareForRun, canShareExactFiles } = await import('@/platform/share')

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
  seedRecords(ids.map((id) => image(id)))
}

/** `seed` for cases that need real names, folder paths or formats rather than `a.jpeg`-style ids. */
function seedRecords(records: ImageRecord[]): void {
  for (const record of records) {
    sourceFiles.set(record.id, new File([new Uint8Array([1, 2, 3])], record.name))
  }
  useBatchStore().addImages(records)
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
  vi.mocked(checkCombinedQuota).mockClear()
  vi.mocked(writeOutputCopy).mockClear()
  vi.mocked(readOutputCopies).mockClear()
  vi.mocked(deleteAllOutputCopies).mockClear()
  // Pinned rather than merely cleared: both answer `false` for real in jsdom (no
  // `navigator.canShare` exists), and pinning that keeps one test's `mockResolvedValue` from
  // silently making a later test's run Share-eligible.
  vi.mocked(probeFileShareForRun).mockReset().mockResolvedValue(false)
  vi.mocked(canShareExactFiles).mockReset().mockResolvedValue(false)
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

describe('useProcessingRun report writing (T41)', () => {
  // `platform/opfs`'s in-memory fallback is module-scoped state, not reset by `setActivePinia` —
  // other tests in this file also exercise the real archive write path, so each of these two
  // tests needs a clean slate to tell "no archive was ever written" apart from "a previous test's
  // archive is still sitting there."
  beforeEach(async () => {
    await deleteRunArtifacts()
  })

  it('writes a real report into the real multi-image archive, reconciling against the run store', async () => {
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
    runs[2]?.settle(completedOutput('c', 600))
    await flush()

    expect(useRunStore().finished).toBe(true)

    const blob = await readArchive()
    const text = await blob.text()

    // `client-zip` stores every entry uncompressed (T40), so the report's own YAML text and its
    // archive-relative file name both survive as literal substrings of the real archive bytes.
    expect(text).toContain('image_compression_report.txt')
    expect(text).toContain('# Mass Image Compressor')
    expect(text).toContain('Succeeded: 2')
    expect(text).toContain('Failed: 1')
    expect(text).toContain('File could not be decoded')
  })

  it('writes no report for a single-image run (R-X16)', async () => {
    seed(['a'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    expect(useRunStore().finished).toBe(true)
    await expect(readArchive()).rejects.toThrow()
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

describe('useProcessingRun quota preflight (T40, R-X40)', () => {
  it('rejects the batch before dispatching any job when the archive will not fit', async () => {
    seed(['a', 'b'])
    vi.mocked(checkCombinedQuota).mockResolvedValueOnce({
      archive: { ok: false, required: 50_000, available: 10_000 },
      combined: { ok: false, required: 50_000, available: 10_000 },
    })
    const { run: api } = setupRun()

    api.start()
    await flush()

    expect(runs).toHaveLength(0)
    expect(api.quotaRejection.value).toEqual({ requiredBytes: 50_000, availableBytes: 10_000 })
    expect(useRunStore().progress).toEqual({ pending: 0, succeeded: 0, failed: 0, skipped: 0 })
  })

  it('starts normally, with quotaRejection left null, when the archive fits', async () => {
    seed(['a', 'b'])
    const { run: api } = setupRun()

    api.start()
    await flush()

    expect(api.quotaRejection.value).toBeNull()
    expect(runs).toHaveLength(2)
  })

  it('does not preflight at all for a 1-image run', async () => {
    seed(['a'])
    const { run: api } = setupRun()

    api.start()
    await flush()

    expect(checkCombinedQuota).not.toHaveBeenCalled()
    expect(runs).toHaveLength(1)
  })
})

describe('useProcessingRun storage-failure halt (T40, §10 "Storage write failure mid-run")', () => {
  it('halts the run and cleans up when writing a successful output fails', async () => {
    seed(['a'])
    vi.mocked(writeOutputCopy).mockRejectedValueOnce(new Error('disk full'))
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    const runStore = useRunStore()
    expect(runStore.haltReason).toBe('storage-failure')
    expect(runStore.finished).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    // The write that failed is never recorded as a success.
    expect(runStore.progress.succeeded).toBe(0)
  })
})

// R-X42's cleanup. This is the *only* thing that removes a downloaded run's artifacts now:
// pipeline/run-download.ts deliberately keeps them, because handing a file to the browser is not
// a confirmation it was saved, so the user can press Download again. That makes leaving
// Processing the point where the results are genuinely finished with — and makes this test the
// one that stops the change from becoming a storage leak.
describe('useProcessingRun cleanup on leaving Processing (R-X42)', () => {
  beforeEach(async () => {
    await deleteRunArtifacts()
  })

  it('removes the run artifacts when the scope is disposed', async () => {
    seed(['a', 'b'])
    const { run: api, dispose } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    runs[1]?.settle(completedOutput('b'))
    await flush()

    // Still there while the user is on the completed screen, so Download can be pressed again.
    await expect(readArchive()).resolves.toBeInstanceOf(Blob)

    dispose()
    await flush()

    await expect(readArchive()).rejects.toThrow()
  })
})

describe('useProcessingRun Share availability (T42, R-X47/R-X48/R-X49/R-X53)', () => {
  // platform/opfs's in-memory fallback is module-scoped and survives setActivePinia (see T41's
  // handover note) — these tests read the copies back for real, so each needs a clean slate.
  beforeEach(async () => {
    await deleteRunArtifacts()
  })

  function folderImage(id: string, relativePath: string): ImageRecord {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    return image(id, { name, relativePath })
  }

  it('offers Share for a run that started with exactly one image (R-X47, R-X49)', async () => {
    seed(['a'])
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    expect(api.shareAvailable.value).toBe(true)
    // No preliminary probe and no second write: R-X51's single direct artifact is already the
    // share payload, so there was never a retention decision for the probe to gate.
    expect(probeFileShareForRun).not.toHaveBeenCalled()
    expect(vi.mocked(writeOutputCopy).mock.calls).toHaveLength(1)
    const [files] = vi.mocked(canShareExactFiles).mock.calls[0] as [File[]]
    expect(files.map((file) => file.name)).toEqual(['a.jpeg'])
  })

  it('keeps the single run’s one copy when the exact check rejects it (Download needs it)', async () => {
    seed(['a'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    expect(api.shareAvailable.value).toBe(false)
    // R-X48 removes the *share* copies and leaves Download unchanged — and for a one-success run
    // that copy is the R-X16 download, so removing it would take Download down with Share.
    expect(deleteAllOutputCopies).not.toHaveBeenCalled()
    await expect(readOutputCopies()).resolves.toHaveLength(1)
  })

  it('offers Share for an eligible 10-image run', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `i${index}`)
    seed(ids)
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    expect(runs).toHaveLength(10)
    for (const [index, pending] of runs.entries()) {
      pending.settle(completedOutput(ids[index] as string))
    }
    await flush()

    expect(api.shareAvailable.value).toBe(true)
    const [files] = vi.mocked(canShareExactFiles).mock.calls[0] as [File[]]
    expect(files).toHaveLength(10)
  })

  it('never checks at all for an 11-image run, even when only two images succeed (R-X47)', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `i${index}`)
    seed(ids)
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('i0'))
    runs[1]?.settle(completedOutput('i1'))
    for (const pending of runs.slice(2)) {
      pending.settle({
        token: 1 as JobToken,
        imageId: 'x' as ImageId,
        outcome: 'failed',
        reason: { kind: 'decode-failed' },
      })
    }
    await flush()

    expect(useRunStore().progress.succeeded).toBe(2)
    expect(api.shareAvailable.value).toBe(false)
    expect(canShareExactFiles).not.toHaveBeenCalled()
  })

  it('hands the exact payload over in grid order, with globally deduplicated names (R-X49/R-X53)', async () => {
    seedRecords([
      folderImage('a', 'x/photo.jpeg'),
      folderImage('b', 'y/photo.jpeg'),
      folderImage('c', 'y/other.jpeg'),
    ])
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    // Settled last-to-first: completion order must not reach the payload.
    runs[2]?.settle(completedOutput('c', 300))
    runs[1]?.settle(completedOutput('b', 200))
    runs[0]?.settle(completedOutput('a', 100))
    await flush()

    expect(api.shareAvailable.value).toBe(true)
    const [files] = vi.mocked(canShareExactFiles).mock.calls[0] as [File[]]
    expect(files.map((file) => file.name)).toEqual(['photo.jpeg', 'photo-1.jpeg', 'other.jpeg'])
    // Grid order means grid order of *bytes* too, not just of names.
    expect(files.map((file) => file.size)).toEqual([100, 200, 300])
  })

  it('still orders by grid position when an earlier image failed, leaving a gap', async () => {
    seedRecords([
      folderImage('a', 'x/photo.jpeg'),
      folderImage('b', 'y/photo.jpeg'),
      folderImage('c', 'y/other.jpeg'),
    ])
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[2]?.settle(completedOutput('c', 300))
    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    runs[1]?.settle(completedOutput('b', 200))
    await flush()

    expect(api.shareAvailable.value).toBe(true)
    const [files] = vi.mocked(canShareExactFiles).mock.calls[0] as [File[]]
    // The failed image's name is still reserved by resolveShareNames (names are resolved up front
    // over every accepted image, before any outcome is known), so 'b' keeps 'photo-1.jpeg'.
    expect(files.map((file) => file.name)).toEqual(['photo-1.jpeg', 'other.jpeg'])
    expect(files.map((file) => file.size)).toEqual([200, 300])
  })

  it('withholds Share without reading anything back when the byte ceiling is exceeded (R-X48)', async () => {
    seed(['a', 'b'])
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    // Overridden rather than allocating 40 MB of real output bytes in a unit test; restored
    // immediately so no other test sees it.
    const originalCeiling = runtimeLimits.maximumShareBytes
    runtimeLimits.maximumShareBytes = 150
    const { run: api } = setupRun()

    try {
      api.start()
      await flush()
      runs[0]?.settle(completedOutput('a', 100))
      runs[1]?.settle(completedOutput('b', 100))
      await flush()
    } finally {
      runtimeLimits.maximumShareBytes = originalCeiling
    }

    expect(api.shareAvailable.value).toBe(false)
    // T39-A: `canShare` says yes well past the point `share()` starts failing, so the ceiling is
    // applied first and the exact array is never even read back.
    expect(canShareExactFiles).not.toHaveBeenCalled()
    expect(readOutputCopies).not.toHaveBeenCalled()
    expect(deleteAllOutputCopies).toHaveBeenCalledOnce()
  })

  it('releases every share copy when the exact check rejects a multi-success run (R-X48)', async () => {
    seed(['a', 'b'])
    vi.mocked(probeFileShareForRun).mockResolvedValue(true)
    vi.mocked(canShareExactFiles).mockResolvedValue(false)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a', 100))
    runs[1]?.settle(completedOutput('b', 200))
    await flush()

    expect(api.shareAvailable.value).toBe(false)
    expect(canShareExactFiles).toHaveBeenCalledOnce()
    expect(deleteAllOutputCopies).toHaveBeenCalledOnce()
    await expect(readOutputCopies()).resolves.toEqual([])
    // Download is left unchanged: the archive is still there.
    await expect(readArchive()).resolves.toBeInstanceOf(Blob)
  })

  it('does not check or delete anything for a multi-image run the preliminary probe ruled out', async () => {
    seed(['a', 'b'])
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a', 100))
    runs[1]?.settle(completedOutput('b', 200))
    await flush()

    expect(api.shareAvailable.value).toBe(false)
    expect(canShareExactFiles).not.toHaveBeenCalled()
    expect(deleteAllOutputCopies).not.toHaveBeenCalled()
  })

  it('offers nothing for a zero-success run', async () => {
    seed(['a'])
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    await flush()

    expect(api.shareAvailable.value).toBe(false)
    expect(canShareExactFiles).not.toHaveBeenCalled()
  })

  it('offers nothing after a halt, even with a success already recorded', async () => {
    seed(['a', 'b'])
    vi.mocked(canShareExactFiles).mockResolvedValue(true)
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a', 100))
    await flush()
    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'b' as ImageId,
      outcome: 'failed',
      reason: { kind: 'out-of-memory' },
    })
    await flush()

    expect(useRunStore().haltReason).toBe('out-of-memory')
    expect(api.shareAvailable.value).toBe(false)
    expect(canShareExactFiles).not.toHaveBeenCalled()
  })

  it('does not offer Share if the exact check resolves after the run was superseded', async () => {
    seed(['a'])
    let release!: () => void
    vi.mocked(canShareExactFiles).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        }),
    )
    const { run: api, dispose } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    dispose() // bumps the generation, the way leaving Processing does
    release()
    await flush()

    expect(api.shareAvailable.value).toBe(false)
  })

  it('leaves the run finished and Download intact if reading the copies back throws', async () => {
    seed(['a'])
    vi.mocked(readOutputCopies).mockRejectedValueOnce(new Error('storage gone'))
    const { run: api } = setupRun()

    api.start()
    await flush()
    runs[0]?.settle(completedOutput('a'))
    await flush()

    const runStore = useRunStore()
    expect(runStore.finished).toBe(true)
    expect(runStore.haltReason).toBeNull()
    expect(api.shareAvailable.value).toBe(false)
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
