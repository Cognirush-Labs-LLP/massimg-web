import { describe, expect, it } from 'vitest'
import type { FailureReason, SizeTargetSkipReason } from '@/domain/types'
import { describeFailureReason, describeSkipReason } from './processingText'

describe('describeFailureReason', () => {
  it.each<[FailureReason['kind'], string]>([
    [
      'decode-failed',
      'Could not be read. The file may be damaged, or not the kind of image its name suggests.',
    ],
    ['encode-failed', 'Could not be compressed at these settings.'],
    [
      'out-of-memory',
      'Too large for this browser to compress. Try a smaller image — the desktop application has no such limit.',
    ],
  ])('describes %s', (kind, expected) => {
    expect(describeFailureReason({ kind } as FailureReason)).toBe(expected)
  })
})

describe('describeSkipReason', () => {
  it('states target, achieved size, dimensions and format', () => {
    const reason: SizeTargetSkipReason = {
      kind: 'size-target-unreachable',
      targetBytes: 1_000_000,
      achievedBytes: 1_500_000,
      format: 'png',
      width: 800,
      height: 600,
    }

    expect(describeSkipReason(reason)).toBe(
      "Couldn't reach 1.00 MB as 800×600 PNG. Smallest possible: 1.50 MB.",
    )
  })
})
