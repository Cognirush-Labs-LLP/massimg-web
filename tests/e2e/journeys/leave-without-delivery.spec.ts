import { expect, test, type Page } from '@playwright/test'
import {
  buildPng,
  downloadResult,
  pressCompress,
  readDownload,
  readZip,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: leaving a finished run before anything was delivered (T51, R-X18, R-X54, R-M6 to R-M8,
// R-K9). The browser's own Back button is the way most people leave, so it is what these press.
// A finished run with undelivered results asks first, with exactly three ways out; one that has
// been delivered — or has nothing to deliver — lets go silently.

async function finishedRun(page: Page): Promise<void> {
  const dir = scratchDir('leave')
  const files = [
    writeAt(dir, 'a.png', buildPng(240, 180, 1)),
    writeAt(dir, 'b.png', buildPng(240, 180, 2)),
  ]
  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('primary-action-meta')).toContainText('2 images')
  await pressCompress(page)
  await waitForRunFinished(page)
}

test('Back from an undelivered run asks, offers exactly three actions, and Stay changes nothing', async ({
  page,
}) => {
  test.slow()
  await finishedRun(page)

  await page.goBack()

  const dialog = page.getByTestId('confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Leave without downloading?')
  await expect(dialog.getByRole('button')).toHaveText([
    'Stay',
    'Leave without downloading',
    'Download and leave',
  ])
  // R-K9: Stay is where focus starts.
  await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused()

  await dialog.getByRole('button', { name: 'Stay' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('processing-root')).toBeVisible()
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('2 succeeded')

  // Staying did not use the results up: Download still works, and the dialog can be raised again.
  await page.goBack()
  await expect(page.getByTestId('confirm-dialog')).toBeVisible()
  await page.getByTestId('confirm-action-stay').click()
  const delivered = await downloadResult(page)
  expect(delivered.name).toMatch(/\.zip$/)
})

test('Leave without downloading returns to Gallery with the batch intact and the results gone', async ({
  page,
}) => {
  test.slow()
  await finishedRun(page)

  await page.goBack()
  await page.getByTestId('confirm-action-leave-without-downloading').click()

  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('processing-root')).toHaveCount(0)
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect(page.getByTestId('primary-action-meta')).toContainText('2 images')
  // R-X25: results are not carried back to Gallery.
  await expect(page.getByTestId('processing-download')).toHaveCount(0)
})

test('Download and leave delivers the file first, then returns to Gallery', async ({ page }) => {
  test.slow()
  await finishedRun(page)

  await page.goBack()
  const event = page.waitForEvent('download', { timeout: 15_000 })
  await page.getByTestId('confirm-action-download-and-leave').click()
  const download = await event
  expect(download.suggestedFilename()).toMatch(/\.zip$/)

  // The leave tears the run's storage down straight after the hand-off, so what arrives must be
  // read back whole: a file the browser was still pulling when its source vanished would not parse.
  const entries = readZip(await readDownload(download))
  expect(entries.map((entry) => entry.name).sort()).toEqual([
    'a.png',
    'b.png',
    'image_compression_report.txt',
  ])

  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('processing-root')).toHaveCount(0)
})

test('Back after a delivered run leaves without asking (R-X54)', async ({ page }) => {
  test.slow()
  await finishedRun(page)
  await downloadResult(page)
  await expect(page.getByTestId('processing-delivered')).toBeVisible()

  await page.goBack()

  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
})
