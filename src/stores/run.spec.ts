import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { useRunStore } from './run'

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useRunStore initial state', () => {
  it('starts at zero with no failures, caveats, or finished/downloaded flags', () => {
    const run = useRunStore()

    expect(run.progress).toEqual({ pending: 0, succeeded: 0, failed: 0 })
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

    expect(run.progress).toEqual({ pending: 5, succeeded: 0, failed: 0 })
    expect(run.failures).toEqual([])
    expect(run.finished).toBe(false)
    expect(run.downloaded).toBe(false)
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

    expect(run.progress).toEqual({ pending: 1, succeeded: 1, failed: 0 })
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

    expect(run.progress).toEqual({ pending: 0, succeeded: 0, failed: 1 })
    expect(run.failures).toEqual([{ imageId: idB, reason: { kind: 'encode-failed' } }])
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
