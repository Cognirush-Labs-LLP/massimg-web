import { expect, test } from '@playwright/test'
import {
  buildPng,
  downloadResult,
  pressCompress,
  readFixture,
  readZip,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: a mixed-format batch (T51). Three different source formats go in; one ZIP comes out,
// holding each image under its own name and extension (format left alone, R-X21), plus the report
// that a multi-image run always carries (R-X16).

test('a mixed JPEG, PNG and AVIF batch compresses into one ZIP with a report', async ({ page }) => {
  test.slow()
  const dir = scratchDir('mixed')
  const files = [
    writeAt(dir, 'portrait.jpg', readFixture('decode', 'orientation-1.jpg')),
    writeAt(dir, 'diagram.png', buildPng(320, 240, 3)),
    writeAt(dir, 'scene.avif', readFixture('decode', 'untagged.avif')),
  ]

  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('primary-action-meta')).toContainText('3 images')

  await pressCompress(page)
  await waitForRunFinished(page)
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('3 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('0 failed')
  await expect(page.getByTestId('processing-figure-pending')).toHaveText('0 pending')

  const delivered = await downloadResult(page)
  expect(delivered.name).toMatch(/\.zip$/)

  const entries = readZip(delivered.bytes)
  expect(entries.map((entry) => entry.name).sort()).toEqual([
    'diagram.png',
    'image_compression_report.txt',
    'portrait.jpg',
    'scene.avif',
  ])
  for (const entry of entries) {
    expect(entry.bytes.length, `${entry.name} is not empty`).toBeGreaterThan(0)
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]))
  // Each output really is its own format, not three renamings of one encoder's result.
  expect(byName.get('portrait.jpg')!.subarray(0, 2).toString('hex')).toBe('ffd8')
  expect(byName.get('diagram.png')!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(byName.get('scene.avif')!.subarray(4, 12).toString('ascii')).toBe('ftypavif')

  // The report names a file only when it has something to say about it (here the tiny AVIF, kept
  // as it was), so what it proves for the rest is the summary: three processed, three succeeded.
  const report = byName.get('image_compression_report.txt')!.toString('utf8')
  expect(report).toContain('Images processed: 3')
  expect(report).toContain('Succeeded: 3')
  expect(report).toContain('Failed: []')
  expect(report).toContain('scene.avif')
})
