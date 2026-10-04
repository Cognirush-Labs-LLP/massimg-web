import { describe, expect, it } from 'vitest'
import { formatUiSize } from '@/domain/sizes'
import type { RejectionEntry } from '@/domain/rejection'
import { describeRejection } from './rejectionText'

function entry(
  reason: RejectionEntry['reason'],
  name: string | null = 'photo.jpg',
): RejectionEntry {
  return { id: 'r1', name, relativePath: null, reason }
}

describe('describeRejection', () => {
  it('names the file for each unhandled reason', () => {
    expect(describeRejection(entry({ kind: 'unhandled', reason: 'psd' }))).toContain('photo.jpg')
    expect(describeRejection(entry({ kind: 'unhandled', reason: 'ico' }))).toContain('photo.jpg')
    expect(describeRejection(entry({ kind: 'unhandled', reason: 'svg' }))).toContain('photo.jpg')
    expect(describeRejection(entry({ kind: 'unhandled', reason: 'camera-raw' }))).toContain(
      'photo.jpg',
    )
    expect(describeRejection(entry({ kind: 'unhandled', reason: 'animated-avif' }))).toContain(
      'photo.jpg',
    )
  })

  it('mentions the desktop application for hard browser/memory limits (R-I21)', () => {
    expect(describeRejection(entry({ kind: 'heic-decoder-unavailable' }))).toMatch(/desktop/i)
    expect(
      describeRejection(
        entry({ kind: 'file-too-large', actualBytes: 200_000_000, capBytes: 100_000_000 }),
      ),
    ).toMatch(/desktop/i)
  })

  it('states the actual value and the cap for file-too-large (R-I20)', () => {
    const actualBytes = 200 * 1024 * 1024
    const capBytes = 100 * 1024 * 1024
    const text = describeRejection(entry({ kind: 'file-too-large', actualBytes, capBytes }))
    expect(text).toContain(formatUiSize(actualBytes))
    expect(text).toContain(formatUiSize(capBytes))
  })

  it('states the actual and cap figures for batch-count-exceeded with no file name', () => {
    const text = describeRejection(
      entry({ kind: 'batch-count-exceeded', actual: 650, cap: 500 }, null),
    )
    expect(text).toContain('650')
    expect(text).toContain('500')
  })

  it('describes a folder with no supported images plainly, with no file name needed', () => {
    expect(describeRejection(entry({ kind: 'folder-empty' }, null))).toBeTruthy()
  })

  it('states actual and cap figures for folder depth and file-count breaches distinctly', () => {
    const depth = describeRejection(
      entry({ kind: 'folder-depth-exceeded', actual: 40, cap: 32 }, null),
    )
    const count = describeRejection(
      entry({ kind: 'folder-file-count-exceeded', actual: 3000, cap: 2000 }, null),
    )
    expect(depth).toContain('40')
    expect(depth).toContain('32')
    expect(count).toContain('3000')
    expect(count).toContain('2000')
    expect(depth).not.toBe(count)
  })
})
