import { expect, test } from '@playwright/test'
import {
  buildPng,
  buildTruncatedPng,
  downloadResult,
  pressCompress,
  readZip,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: a run in which one image genuinely fails (T51, R-X9 to R-X12, Functional Design §10).
// The damaged file is accepted at selection (its header is fine) and fails inside the worker; the
// rest of the batch must be unaffected, the failure must be named on screen, and the ZIP's report
// must say the same thing.

test('one damaged image fails by name while the rest still compress and download', async ({
  page,
}) => {
  test.slow()
  const dir = scratchDir('failures')
  const files = [
    writeAt(dir, 'good-one.png', buildPng(320, 240, 1)),
    writeAt(dir, 'broken.png', buildTruncatedPng()),
    writeAt(dir, 'good-two.png', buildPng(320, 240, 2)),
  ]

  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('primary-action-meta')).toContainText('3 images')

  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('2 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('1 failed')
  await expect(page.getByTestId('processing-figure-pending')).toHaveText('0 pending')

  const failures = page.getByTestId('processing-failures')
  await expect(failures).toContainText('broken.png')
  await expect(failures).toContainText('Could not be read')
  await expect(failures).not.toContainText('good-one.png')
  await expect(failures).not.toContainText('good-two.png')

  // The run is not a write-off: what worked is deliverable.
  const { bytes } = await downloadResult(page)
  const entries = readZip(bytes)
  expect(entries.map((entry) => entry.name).sort()).toEqual([
    'good-one.png',
    'good-two.png',
    'image_compression_report.txt',
  ])

  const report = entries.find((entry) => entry.name === 'image_compression_report.txt')!
  const text = report.bytes.toString('utf8')
  expect(text).toContain('Succeeded: 2')
  expect(text).toContain('Failed: 1')
  expect(text).toContain('broken.png')
})

test('a run where every image fails says there is nothing to download', async ({ page }) => {
  test.slow()
  const dir = scratchDir('all-failed')
  const files = [
    writeAt(dir, 'one.png', buildTruncatedPng()),
    writeAt(dir, 'two.png', buildTruncatedPng(300, 200)),
  ]

  await page.goto('/')
  await selectFiles(page, files)
  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-failed')).toHaveText('2 failed')
  await expect(page.getByTestId('processing-total')).toContainText('Nothing to download')
  await expect(page.getByTestId('processing-download')).toHaveCount(0)
  await expect(page.getByTestId('processing-share')).toHaveCount(0)
})
