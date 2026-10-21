import { expect, test } from '@playwright/test'
import {
  buildPng,
  downloadResult,
  pressCompress,
  RUN_TIMEOUT,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: one image, start to finish through the real interface (T51, R-M1, R-X16).
//
// A batch of exactly one opens Preview rather than a one-tile Gallery; Compress from there runs the
// same pipeline, and the person receives the compressed image itself, not a ZIP and not a report.

test('one image: Preview opens, Compress runs, Download delivers that one file (R-M1, R-X16)', async ({
  page,
}) => {
  test.slow()
  const dir = scratchDir('single')
  const source = writeAt(dir, 'holiday.png', buildPng(320, 240))

  await page.goto('/')
  await selectFiles(page, [source])

  await expect(page.getByTestId('preview-root')).toBeVisible()
  await expect(page.getByTestId('gallery-root')).toHaveCount(0)
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: RUN_TIMEOUT })

  await pressCompress(page)
  await waitForRunFinished(page)
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('1 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('0 failed')

  const delivered = await downloadResult(page)

  // The image itself, under its own name: no archive, no report beside it.
  expect(delivered.name).toBe('holiday.png')
  expect(delivered.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(delivered.bytes.length).toBeGreaterThan(0)

  await expect(page.getByTestId('processing-delivered')).toHaveText(/Download started/)
})
