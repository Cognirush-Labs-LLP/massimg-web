import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { useRunStore } from '@/stores/run'

const opfsMocks = vi.hoisted(() => ({
  readOutputCopies: vi.fn<() => Promise<File[]>>(async () => []),
  deleteRunArtifacts: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('@/platform/opfs', () => opfsMocks)

const shareMocks = vi.hoisted(() => ({
  shareFiles: vi.fn<(files: readonly File[]) => Promise<'shared' | 'cancelled' | 'failed'>>(
    async () => 'shared',
  ),
}))

vi.mock('@/platform/share', () => shareMocks)

import { shareFinishedRun } from './run-share'

function outputCopy(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' })
}

function finishedRunWithSuccesses(count: number): void {
  const run = useRunStore()
  run.startRun(count)
  for (let index = 0; index < count; index += 1) {
    run.recordResult(`image-${index}` as ImageId, {
      kind: 'succeeded',
      inputBytes: 1000,
      outputBytes: 100,
      caveats: [],
    })
  }
  run.finishRun()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  opfsMocks.readOutputCopies.mockImplementation(async () => [])
  shareMocks.shareFiles.mockImplementation(async () => 'shared')
})

// The other half of R-V5 — that nothing reaches this function until the user presses Share —
// is asserted in src/ui/processing/Processing.spec.ts, where the button lives.
describe('shareFinishedRun — the payload (R-X49, R-V5)', () => {
  it('hands over exactly the individual output copies, in the order storage returns them', async () => {
    finishedRunWithSuccesses(3)
    const files = [outputCopy('a.jpg'), outputCopy('b.jpg'), outputCopy('c.jpg')]
    opfsMocks.readOutputCopies.mockResolvedValueOnce(files)

    await shareFinishedRun()

    expect(shareMocks.shareFiles).toHaveBeenCalledOnce()
    const [handedOver] = shareMocks.shareFiles.mock.calls[0] as [File[]]
    expect(handedOver.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  it('never reaches for the archive or the report', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('a.jpg'), outputCopy('b.jpg')])

    await shareFinishedRun()

    // The ZIP and the report live outside the output-copy set entirely (platform/opfs.ts holds
    // the archive as its own file, and the report only ever exists as a ZIP entry), so the
    // payload cannot contain either. Asserted rather than argued, since R-X49 names both.
    const [handedOver] = shareMocks.shareFiles.mock.calls[0] as [File[]]
    expect(handedOver.some((file) => file.name.endsWith('.zip'))).toBe(false)
    expect(handedOver.some((file) => file.name.includes('report'))).toBe(false)
  })
})

describe('shareFinishedRun — resolved (R-X42, R-X50, R-X54)', () => {
  it('marks the run shared and keeps every artifact for the target to read', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('a.jpg'), outputCopy('b.jpg')])

    await expect(shareFinishedRun()).resolves.toBe('shared')

    const run = useRunStore()
    expect(run.delivery).toBe('shared')
    expect(run.deliveryError).toBeNull()
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })
})

describe('shareFinishedRun — cancelled (R-X50: not an error)', () => {
  it('changes nothing at all: no error, no delivery, no cleanup', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('a.jpg'), outputCopy('b.jpg')])
    shareMocks.shareFiles.mockResolvedValueOnce('cancelled')

    await expect(shareFinishedRun()).resolves.toBe('cancelled')

    const run = useRunStore()
    expect(run.delivery).toBe('pending')
    expect(run.deliveryError).toBeNull()
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('leaves a retry able to succeed', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValue([outputCopy('a.jpg'), outputCopy('b.jpg')])
    shareMocks.shareFiles.mockResolvedValueOnce('cancelled')

    expect(await shareFinishedRun()).toBe('cancelled')
    expect(await shareFinishedRun()).toBe('shared')

    expect(useRunStore().delivery).toBe('shared')
  })
})

describe('shareFinishedRun — failed (§10 "Share handoff fails")', () => {
  it('records the retryable error, keeps the results and delivers nothing', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('a.jpg'), outputCopy('b.jpg')])
    shareMocks.shareFiles.mockResolvedValueOnce('failed')

    await expect(shareFinishedRun()).resolves.toBe('failed')

    const run = useRunStore()
    expect(run.deliveryError).toBe('share')
    expect(run.delivery).toBe('pending')
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('clears its own error once a retry succeeds', async () => {
    finishedRunWithSuccesses(2)
    opfsMocks.readOutputCopies.mockResolvedValue([outputCopy('a.jpg'), outputCopy('b.jpg')])
    shareMocks.shareFiles.mockResolvedValueOnce('failed')

    await shareFinishedRun()
    await shareFinishedRun()

    const run = useRunStore()
    expect(run.delivery).toBe('shared')
    expect(run.deliveryError).toBeNull()
  })
})
