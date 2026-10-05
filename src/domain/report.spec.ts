import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  buildReport,
  describeReportSettings,
  formatCaveat,
  formatFailureReason,
  formatReportTimestamp,
  formatRejectionReason,
  serializeReport,
  type ReportSource,
} from './report'
import { caveatFixtures } from './types.fixtures'

const file = (name: string, relativePath: string | null = null) => ({ name, relativePath })

const fixtureRun = {
  run: '2026-09-13 14:22:05',
  settings: {
    quality: 70,
    format: 'Original formats',
    dimension: 'Fit within long edge, 1920 px',
  },
  successes: [
    {
      file: file('ordinary.jpg', 'holiday/day1/ordinary.jpg'),
      inputBytes: 1024,
      outputBytes: 512,
      caveats: [],
    },
    {
      file: file('banner.png', 'holiday/day1/banner.png'),
      inputBytes: 2048,
      outputBytes: 1024,
      caveats: [{ kind: 'transparency-flattened', fill: { r: 255, g: 255, b: 255, a: 1 } }],
    },
    {
      file: file('animation.gif', 'holiday/day2/animation.gif'),
      inputBytes: 4096,
      outputBytes: 2048,
      caveats: [{ kind: 'animation-substituted' }],
    },
    {
      file: file('location.jpg', 'holiday/day2/location.jpg'),
      inputBytes: 8192,
      outputBytes: 4096,
      caveats: [{ kind: 'metadata-removed', gpsDataRemoved: true }],
    },
    {
      file: file('panorama.jpg', 'holiday/day3/panorama.jpg'),
      inputBytes: 16_384,
      outputBytes: 16_384,
      caveats: [{ kind: 'original-kept', reason: 'encoded-not-smaller' }],
    },
  ],
  failures: [
    {
      file: file('DSC_4417.jpg', 'holiday/day2/DSC_4417.jpg'),
      reason: 'File could not be decoded',
    },
  ],
  skippedImages: [
    {
      file: file('logo.psd', 'holiday/logo.psd'),
      reason: 'Photoshop documents are not supported',
    },
  ],
  nonImages: [file('budget.xlsx', 'holiday/budget.xlsx')],
} satisfies ReportSource

describe('report model and YAML serialization', () => {
  it('round-trips a fixture with failures, skips, and four distinct caveats through YAML', () => {
    const report = buildReport(fixtureRun)
    const yaml = serializeReport(report)

    expect(yaml.startsWith('# Mass Image Compressor\nRun:')).toBe(true)
    expect(load(yaml)).toEqual(report)
    expect(report.Summary).toEqual({
      'Images processed': 7,
      Succeeded: 5,
      Failed: 1,
      Skipped: 1,
      'Input size': '31.74 KB',
      'Output size': '24.06 KB',
      Saved: '7.68 KB (24.2%)',
      'Exact bytes': {
        Input: 31_744,
        Output: 24_064,
        Saved: 7680,
      },
    })
  })

  it('counts ordinary successes without listing them and omits non-images entirely', () => {
    const report = buildReport(fixtureRun)
    const yaml = serializeReport(report)

    expect(report.Summary.Succeeded).toBe(5)
    expect(report.Notes).toHaveLength(4)
    expect(yaml).not.toContain('ordinary.jpg')
    expect(yaml).not.toContain('budget.xlsx')
  })

  it('uses folder-relative paths for every listed file', () => {
    const report = buildReport(fixtureRun)

    expect(report.Failed.map(({ file: path }) => path)).toEqual(['holiday/day2/DSC_4417.jpg'])
    expect(report.Skipped.map(({ file: path }) => path)).toEqual(['holiday/logo.psd'])
    expect(report.Notes.map(({ file: path }) => path)).toEqual([
      'holiday/day1/banner.png',
      'holiday/day2/animation.gif',
      'holiday/day2/location.jpg',
      'holiday/day3/panorama.jpg',
    ])
  })

  it('quotes arbitrary strings so YAML syntax and implicit types round-trip unchanged', () => {
    const source = {
      ...fixtureRun,
      run: '2026-09-13 14:22:05 # local',
      settings: { quality: 'yes', format: 'JPEG: baseline', dimension: 'null' },
      failures: [{ file: file('strange: #1.jpg'), reason: 'no: maybe # detail' }],
      skippedImages: [],
    } satisfies ReportSource
    const report = buildReport(source)

    expect(load(serializeReport(report))).toEqual(report)
  })

  it('serializes empty detail sections as YAML sequences', () => {
    const report = buildReport({
      run: '2026-09-13 14:22:05',
      settings: { quality: 70, format: 'JPEG', dimension: 'Original size' },
      successes: [],
      failures: [],
      skippedImages: [],
    })

    expect(load(serializeReport(report))).toEqual(report)
    expect(report.Summary.Saved).toBe('0.00 B (0.0%)')
  })

  it('keeps exact byte fields on summary totals only', () => {
    const source = {
      ...fixtureRun,
      successes: [
        {
          file: file('larger.jpg', 'holiday/larger.jpg'),
          inputBytes: 100,
          outputBytes: 120,
          caveats: [{ kind: 'output-larger-than-input', inputBytes: 100, outputBytes: 120 }],
        },
      ],
      skippedImages: [
        {
          file: file('target.jpg', 'holiday/target.jpg'),
          reason: {
            kind: 'size-target-unreachable',
            targetBytes: 100,
            achievedBytes: 150,
            format: 'jpeg',
            width: 400,
            height: 300,
          },
        },
      ],
    } satisfies ReportSource
    const report = buildReport(source)
    const parsed = load(serializeReport(report)) as Record<string, unknown>

    expect(JSON.stringify(parsed).match(/"Exact bytes"/g)).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toMatch(/inputBytes|outputBytes|targetBytes|achievedBytes/)
    expect(report.Notes).toEqual([
      {
        file: 'holiday/larger.jpg',
        note: 'Output larger than input; input 100.00 B, output 120.00 B',
      },
    ])
    expect(report.Skipped).toEqual([
      {
        file: 'holiday/target.jpg',
        reason:
          'Size target not reached; target 100.00 B, smallest achieved 150.00 B, 400×300 JPEG',
      },
    ])
  })
})

describe('the closed R-X46 caveat set', () => {
  it('formats all eight and only the eight caveat variants', () => {
    expect(caveatFixtures.map(formatCaveat)).toEqual([
      'Transparency flattened to white; output format has no alpha channel',
      'Animation substituted; output written as WebP because the chosen format cannot animate',
      'Metadata removed, including GPS data',
      'Original kept; re-encoding was not smaller',
      'Output larger than input; input 100.00 B, output 120.00 B',
      'PNG quantized; PNG was not written losslessly',
      'Colour converted to sRGB; output format could not carry the source colour information',
      'Auxiliary images dropped; only the primary image was processed',
    ])
  })

  it('states when removed metadata did not include GPS data', () => {
    expect(formatCaveat({ kind: 'metadata-removed', gpsDataRemoved: false })).toBe(
      'Metadata removed; GPS data was not among it',
    )
  })

  it('states why an already-small source was kept without claiming it was re-encoded', () => {
    expect(formatCaveat({ kind: 'original-kept', reason: 'already-within-size-target' })).toBe(
      'Original kept; it already met the size target',
    )
  })

  it('states a non-standard transparency fill colour', () => {
    expect(
      formatCaveat({
        kind: 'transparency-flattened',
        fill: { r: 12, g: 34, b: 56, a: 1 },
      }),
    ).toBe('Transparency flattened to rgb(12, 34, 56); output format has no alpha channel')
  })
})

describe('real-run formatters (T41)', () => {
  it('formats every FailureReason as hardcoded English', () => {
    expect(formatFailureReason({ kind: 'decode-failed' })).toBe('File could not be decoded')
    expect(formatFailureReason({ kind: 'encode-failed' })).toBe('File could not be encoded')
    expect(formatFailureReason({ kind: 'out-of-memory' })).toBe('Ran out of memory')
  })

  it('formats every RejectionReason as hardcoded English, without routing through i18n', () => {
    expect(formatRejectionReason({ kind: 'unhandled', reason: 'psd' })).toBe(
      'Photoshop documents are not supported',
    )
    expect(formatRejectionReason({ kind: 'unhandled', reason: 'ico' })).toBe(
      'Icon (ICO) files are not supported',
    )
    expect(formatRejectionReason({ kind: 'unhandled', reason: 'svg' })).toBe(
      'SVG files are not supported',
    )
    expect(formatRejectionReason({ kind: 'unhandled', reason: 'camera-raw' })).toBe(
      'Camera RAW files are not supported',
    )
    expect(formatRejectionReason({ kind: 'unhandled', reason: 'animated-avif' })).toBe(
      'Animated AVIF is not supported',
    )
    expect(formatRejectionReason({ kind: 'heic-decoder-unavailable' })).toBe(
      'This browser cannot decode HEIC',
    )
    expect(
      formatRejectionReason({ kind: 'file-too-large', actualBytes: 2000, capBytes: 1000 }),
    ).toBe('File size 2.00 KB exceeds the 1.00 KB limit for this browser')
    expect(formatRejectionReason({ kind: 'batch-count-exceeded', actual: 250, cap: 200 })).toBe(
      'Selection exceeded the 200-image batch limit',
    )
    expect(formatRejectionReason({ kind: 'folder-empty' })).toBe(
      'Folder contained no images this app can process',
    )
    expect(formatRejectionReason({ kind: 'folder-depth-exceeded', actual: 20, cap: 15 })).toBe(
      'Folder exceeded the 15-level depth limit',
    )
    expect(
      formatRejectionReason({ kind: 'folder-file-count-exceeded', actual: 500, cap: 400 }),
    ).toBe('Folder exceeded the 400-file limit')
  })

  it('describes quality settings in both modes', () => {
    expect(
      describeReportSettings({
        quality: { kind: 'quality', value: 70 },
        format: 'dont-change',
        dimension: { kind: 'original' },
      }).quality,
    ).toBe(70)
    expect(
      describeReportSettings({
        quality: { kind: 'size', targetBytes: 512_000 },
        format: 'dont-change',
        dimension: { kind: 'original' },
      }).quality,
    ).toBe('Target size 512.00 KB')
  })

  it('describes format settings', () => {
    expect(
      describeReportSettings({
        quality: { kind: 'quality', value: 70 },
        format: 'dont-change',
        dimension: { kind: 'original' },
      }).format,
    ).toBe('Original formats')
    expect(
      describeReportSettings({
        quality: { kind: 'quality', value: 70 },
        format: 'webp',
        dimension: { kind: 'original' },
      }).format,
    ).toBe('WEBP')
  })

  it('describes every dimension mode, matching the §9.3 sample wording', () => {
    const base = {
      quality: { kind: 'quality', value: 70 } as const,
      format: 'dont-change' as const,
    }
    expect(describeReportSettings({ ...base, dimension: { kind: 'original' } }).dimension).toBe(
      'Original size',
    )
    expect(
      describeReportSettings({ ...base, dimension: { kind: 'fit-long-edge', pixels: 1920 } })
        .dimension,
    ).toBe('Fit within long edge, 1920 px')
    expect(
      describeReportSettings({ ...base, dimension: { kind: 'fixed-width', pixels: 800 } })
        .dimension,
    ).toBe('Fixed width, 800 px')
    expect(
      describeReportSettings({ ...base, dimension: { kind: 'fixed-height', pixels: 600 } })
        .dimension,
    ).toBe('Fixed height, 600 px')
  })

  it('formats a run timestamp as locale-independent YYYY-MM-DD HH:MM:SS', () => {
    expect(formatReportTimestamp(new Date(2026, 8, 13, 14, 22, 5))).toBe('2026-09-13 14:22:05')
    expect(formatReportTimestamp(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00:00')
  })
})
