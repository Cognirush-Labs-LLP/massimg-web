import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from './batch'
import { useRunStore } from './run'

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useRunStore initial state', () => {
  it('starts at zero with no failures, caveats, or finished/downloaded flags', () => {
    const run = useRunStore()

    expect(run.progress).toEqual({ pending: 0, succeeded: 0, failed: 0, skipped: 0 })
    expect(run.inputBytes).toBe(0)
    expect(run.outputBytes).toBe(0)
    expect(run.failures).toEqual([])
    expect(run.caveats).toEqual([])
    expect(run.finished).toBe(false)
    expect(run.downloaded).toBe(false)
  })
})

describe('useRunStore.startRun', () => {
  it('resets a previously populated store', () => {
    const run = useRunStore()
    run.startRun(1)
    run.recordResult(idA, { kind: 'failed', reason: { kind: 'decode-failed' } })
    run.finishRun()
    run.markDownloaded()

    run.startRun(5)

    expect(run.progress).toEqual({ pending: 5, succeeded: 0, failed: 0, skipped: 0 })
    expect(run.failures).toEqual([])
    expect(run.finished).toBe(false)
    expect(run.downloaded).toBe(false)
  })

  it('clears prior failed and skipped image status only when a new run starts', () => {
    const batch = useBatchStore()
    batch.addImages([
      {
        ...imageRecordFixture,
        id: idA,
        status: 'skipped',
        failure: null,
        skipReason: {
          kind: 'size-target-unreachable',
          targetBytes: 100,
          achievedBytes: 150,
          format: 'png',
          width: 100,
          height: 100,
        },
      },
    ])

    expect(batch.images[0]?.status).toBe('skipped')
    useRunStore().startRun(1)
    expect(batch.images[0]).toMatchObject({ status: 'ready', failure: null, skipReason: null })
  })
})

describe('useRunStore.recordResult', () => {
  it('accumulates bytes and decrements pending on success', () => {
    const run = useRunStore()
    run.startRun(2)

    run.recordResult(idA, {
      kind: 'succeeded',
      inputBytes: 1000,
      outputBytes: 400,
      caveats: [],
    })

    expect(run.progress).toEqual({ pending: 1, succeeded: 1, failed: 0, skipped: 0 })
    expect(run.inputBytes).toBe(1000)
    expect(run.outputBytes).toBe(400)
  })

  it('records a caveat entry only when caveats are present', () => {
    const run = useRunStore()
    run.startRun(1)

    run.recordResult(idA, {
      kind: 'succeeded',
      inputBytes: 1000,
      outputBytes: 400,
      caveats: [{ kind: 'png-quantized' }],
    })

    expect(run.caveats).toEqual([{ imageId: idA, caveats: [{ kind: 'png-quantized' }] }])
  })

  it('records a failure entry and decrements pending on failure', () => {
    const run = useRunStore()
    run.startRun(1)

    run.recordResult(idB, { kind: 'failed', reason: { kind: 'encode-failed' } })

    expect(run.progress).toEqual({ pending: 0, succeeded: 0, failed: 1, skipped: 0 })
    expect(run.failures).toEqual([{ imageId: idB, reason: { kind: 'encode-failed' } }])
  })

  it('records an unreachable size target as skipped without adding output totals', () => {
    const run = useRunStore()
    run.startRun(1)
    const reason = {
      kind: 'size-target-unreachable' as const,
      targetBytes: 1_000,
      achievedBytes: 1_200,
      format: 'png' as const,
      width: 800,
      height: 600,
    }

    run.recordResult(idA, { kind: 'skipped', reason })

    expect(run.progress).toEqual({ pending: 0, succeeded: 0, failed: 0, skipped: 1 })
    expect(run.skipped).toEqual([{ imageId: idA, reason }])
    expect(run.inputBytes).toBe(0)
    expect(run.outputBytes).toBe(0)
  })
})

describe('useRunStore.finishRun / markDownloaded', () => {
  it('set exactly their own flag', () => {
    const run = useRunStore()

    run.finishRun()
    expect(run.finished).toBe(true)
    expect(run.downloaded).toBe(false)

    run.markDownloaded()
    expect(run.downloaded).toBe(true)
  })
})
