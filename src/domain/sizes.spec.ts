import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeSizeComparison, formatReportSize, formatUiSize } from './sizes'

describe('size formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [0, '0.00 B'],
    [1023, '1023.00 B'],
    [1024, '1.00 KB'],
    [12.334 * 1024 ** 2, '12.33 MB'],
    [12.336 * 1024 ** 2, '12.34 MB'],
    [2.5 * 1024 ** 3, '2.50 GB'],
    [1.25 * 1024 ** 4, '1.25 TB'],
  ])('formats %d bytes for the report as %s', (bytes, expected) => {
    expect(formatReportSize(bytes)).toBe(expected)
  })

  it('keeps report numbers dot-decimal regardless of the interface locale', () => {
    const numberFormatSpy = vi.spyOn(Intl, 'NumberFormat')
    const locales = ['en-US', 'de-DE', 'hi-IN'] as const
    const reportOutputs = locales.map(() => formatReportSize(12.334 * 1024 ** 2))

    expect(reportOutputs).toEqual(['12.33 MB', '12.33 MB', '12.33 MB'])
    expect(numberFormatSpy).not.toHaveBeenCalled()
  })

  it('formats interface numbers through Intl.NumberFormat for the requested locale', () => {
    const bytes = 12.334 * 1024 ** 2
    const uiOutputs = {
      'en-US': formatUiSize(bytes, 'en-US'),
      'de-DE': formatUiSize(bytes, 'de-DE'),
      'hi-IN': formatUiSize(bytes, 'hi-IN'),
    }

    expect(uiOutputs).toEqual({
      'en-US': '12.33 MB',
      'de-DE': '12,33 MB',
      'hi-IN': '12.33 MB',
    })
    expect(new Set(Object.values(uiOutputs)).size).toBeGreaterThan(1)
  })

  it('keeps the report and interface formatters as distinct functions', () => {
    expect(formatReportSize).not.toBe(formatUiSize)
  })
})

describe('describeSizeComparison (R-P5)', () => {
  it.each([
    [500_000, 250_000, 'reduction', 50, false],
    [500_000, 400_000, 'reduction', 20, false],
    [500_000, 600_000, 'increase', 20, false],
    [500_000, 500_000, 'unchanged', 0, false],
  ] as const)(
    'reports %d -> %d as a %s of %d%%',
    (input, output, direction, percent, belowOnePercent) => {
      expect(describeSizeComparison(input, output)).toEqual({
        direction,
        percent,
        belowOnePercent,
      })
    },
  )

  it('never reports an increase as zero, however small it is (R-P5)', () => {
    const comparison = describeSizeComparison(1_000_000, 1_000_100)

    expect(comparison.direction).toBe('increase')
    expect(comparison.belowOnePercent).toBe(true)
  })

  it('flags a reduction below one percent the same way, rather than rounding it to nothing', () => {
    const comparison = describeSizeComparison(1_000_000, 999_900)

    expect(comparison.direction).toBe('reduction')
    expect(comparison.belowOnePercent).toBe(true)
  })

  it('reports a percentage as a positive magnitude in both directions', () => {
    expect(describeSizeComparison(100, 300).percent).toBe(200)
    expect(describeSizeComparison(300, 100).percent).toBe(67)
  })

  it('reports unchanged rather than dividing by zero for an input of no bytes', () => {
    expect(describeSizeComparison(0, 1000)).toEqual({
      direction: 'unchanged',
      percent: 0,
      belowOnePercent: false,
    })
  })
})
