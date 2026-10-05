import { load } from 'js-yaml'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ImageId, ImageRecord } from '@/domain/types'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useSettingsStore } from '@/stores/settings'
import { buildRunReportEntry, REPORT_ARCHIVE_PATH } from './run-report'

function image(id: string, name: string, relativePath: string): ImageRecord {
  return {
    id: id as ImageId,
    name,
    relativePath,
    sizeBytes: 0,
    width: 0,
    height: 0,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    skipReason: null,
  }
}

function decode(entry: { path: string; bytes: Uint8Array }): string {
  return new TextDecoder().decode(entry.bytes)
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('buildRunReportEntry', () => {
  it('reconciles totals and merges rejections ahead of size-target skips into Skipped', () => {
    const batchStore = useBatchStore()
    const runStore = useRunStore()
    const settingsStore = useSettingsStore()

    batchStore.addImages([
      image('ordinary', 'ordinary.jpg', 'holiday/ordinary.jpg'),
      image('caveated', 'animation.gif', 'holiday/animation.gif'),
      image('failed', 'broken.jpg', 'holiday/broken.jpg'),
      image('skipped', 'huge.jpg', 'holiday/huge.jpg'),
    ])
    batchStore.setRejections([
      {
        id: 'r1',
        name: 'logo.psd',
        relativePath: 'holiday/logo.psd',
        reason: { kind: 'unhandled', reason: 'psd' },
      },
      { id: 'r2', name: null, relativePath: null, reason: { kind: 'folder-empty' } },
    ])

    settingsStore.quality = { kind: 'quality', value: 70 }
    settingsStore.dimension = { kind: 'fit-long-edge', pixels: 1920 }
    settingsStore.format = 'dont-change'

    runStore.startRun(4)
    runStore.recordResult('ordinary' as ImageId, {
      kind: 'succeeded',
      inputBytes: 1024,
      outputBytes: 512,
      caveats: [],
    })
    runStore.recordResult('caveated' as ImageId, {
      kind: 'succeeded',
      inputBytes: 2048,
      outputBytes: 1024,
      caveats: [{ kind: 'animation-substituted' }],
    })
    runStore.recordResult('failed' as ImageId, {
      kind: 'failed',
      reason: { kind: 'decode-failed' },
    })
    runStore.recordResult('skipped' as ImageId, {
      kind: 'skipped',
      reason: {
        kind: 'size-target-unreachable',
        targetBytes: 100,
        achievedBytes: 150,
        format: 'jpeg',
        width: 400,
        height: 300,
      },
    })

    const entry = buildRunReportEntry()
    expect(entry.path).toBe(REPORT_ARCHIVE_PATH)

    const yaml = decode(entry)
    expect(yaml.startsWith('# Mass Image Compressor\nRun:')).toBe(true)

    const report = load(yaml) as Record<string, unknown>
    expect(report.Run).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(report.Summary).toEqual({
      'Images processed': 5,
      Succeeded: 2,
      Failed: 1,
      Skipped: 2,
      'Input size': '3.07 KB',
      'Output size': '1.54 KB',
      Saved: '1.54 KB (50.0%)',
      'Exact bytes': { Input: 3072, Output: 1536, Saved: 1536 },
    })
    expect(report.Settings).toEqual({
      Quality: 70,
      Format: 'Original formats',
      Dimension: 'Fit within long edge, 1920 px',
    })
    expect(report.Failed).toEqual([
      { file: 'holiday/broken.jpg', reason: 'File could not be decoded' },
    ])
    expect(report.Skipped).toEqual([
      { file: 'holiday/logo.psd', reason: 'Photoshop documents are not supported' },
      {
        file: 'holiday/huge.jpg',
        reason:
          'Size target not reached; target 100.00 B, smallest achieved 150.00 B, 400×300 JPEG',
      },
    ])
    expect(report.Notes).toEqual([
      {
        file: 'holiday/animation.gif',
        note: 'Animation substituted; output written as WebP because the chosen format cannot animate',
      },
    ])
  })

  it('excludes batch-/folder-wide rejections, which have no single file', () => {
    const batchStore = useBatchStore()
    const runStore = useRunStore()

    batchStore.setRejections([
      { id: 'r1', name: null, relativePath: null, reason: { kind: 'folder-empty' } },
      {
        id: 'r2',
        name: null,
        relativePath: null,
        reason: { kind: 'batch-count-exceeded', actual: 250, cap: 200 },
      },
    ])
    runStore.startRun(0)

    const report = load(decode(buildRunReportEntry())) as Record<string, unknown>
    expect(report.Skipped).toEqual([])
  })
})
