import { expect, test, type Page } from '@playwright/test'
import {
  buildPng,
  pressCompress,
  readShareCalls,
  scratchDir,
  selectFiles,
  stubShare,
  waitForRunFinished,
  writeAt,
  type ShareMode,
} from './support'

// Journey: Share, with the platform stubbed (T51, R-X47 to R-X50, R-V5, R-X54). Real engines
// differ — Playwright's Chromium and Firefox cannot share files at all, its WebKit only on macOS —
// so `navigator.canShare`/`navigator.share` are replaced before the page loads and every engine
// walks the same four branches: available, accepted, dismissed, refused. What each branch does to
// the screen is the application's behaviour and is identical everywhere.
//
// What the platform itself does with these calls is covered, against the real browser, by
// tests/e2e/share.spec.ts; this file is about what a person sees and can do next.

async function finishRun(page: Page, mode: ShareMode): Promise<void> {
  await stubShare(page, mode)
  const dir = scratchDir('share')
  const files = [
    writeAt(dir, 'first.png', buildPng(200, 150, 1)),
    writeAt(dir, 'second.png', buildPng(200, 150, 2)),
  ]
  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('primary-action-meta')).toContainText('2 images')
  await pressCompress(page)
  await waitForRunFinished(page)
}

test('Share is offered beside Download once the platform accepts the exact payload', async ({
  page,
}) => {
  test.slow()
  await finishRun(page, 'resolve')

  await expect(page.getByTestId('processing-share')).toBeVisible()
  await expect(page.getByTestId('processing-download')).toBeVisible()
  // Offering it is not sharing: nothing reaches the platform until it is pressed.
  expect(await readShareCalls(page)).toEqual([])
})

test('an accepted share ends in the checked state and offers nothing further (R-X54)', async ({
  page,
}) => {
  test.slow()
  await finishRun(page, 'resolve')

  await page.getByTestId('processing-share').click()

  await expect(page.getByTestId('processing-delivered')).toHaveText(/Shared/)
  await expect(page.getByTestId('processing-share')).toHaveCount(0)
  await expect(page.getByTestId('processing-download')).toHaveCount(0)
  await expect(page.getByTestId('processing-share-error')).toHaveCount(0)

  // R-V5: the files and nothing else — no title, text, URL, ZIP or report.
  const calls = await readShareCalls(page)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.keys).toEqual(['files'])
  expect(calls[0]?.names.sort()).toEqual(['first.png', 'second.png'])

  // Delivered, so Back leaves without the confirmation.
  await page.goBack()
  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
})

test('dismissing the share sheet is silent: no message, both actions still offered (R-X50)', async ({
  page,
}) => {
  test.slow()
  await finishRun(page, 'abort')

  await page.getByTestId('processing-share').click()
  await expect.poll(async () => (await readShareCalls(page)).length).toBe(1)

  await expect(page.getByTestId('processing-share-error')).toHaveCount(0)
  await expect(page.getByTestId('processing-download-error')).toHaveCount(0)
  await expect(page.getByTestId('processing-delivered')).toHaveCount(0)
  await expect(page.getByTestId('processing-share')).toBeVisible()
  await expect(page.getByTestId('processing-download')).toBeVisible()

  // And it can be tried again.
  await page.getByTestId('processing-share').click()
  await expect.poll(async () => (await readShareCalls(page)).length).toBe(2)
})

test('a failed share says so, keeps both actions, and can be retried (R-X50)', async ({ page }) => {
  test.slow()
  await finishRun(page, 'reject')

  await page.getByTestId('processing-share').click()

  const error = page.getByTestId('processing-share-error')
  await expect(error).toBeVisible()
  await expect(error).toContainText("Sharing didn't finish")
  await expect(page.getByTestId('processing-delivered')).toHaveCount(0)
  await expect(page.getByTestId('processing-share')).toBeVisible()
  await expect(page.getByTestId('processing-download')).toBeVisible()

  await page.getByTestId('processing-share').click()
  await expect.poll(async () => (await readShareCalls(page)).length).toBe(2)
  await expect(error).toBeVisible()
})

test('when the platform refuses the exact payload, Share is not offered and Download is unchanged (R-X48)', async ({
  page,
}) => {
  test.slow()
  await finishRun(page, 'unsupported')

  await expect(page.getByTestId('processing-download')).toBeVisible()
  await expect(page.getByTestId('processing-share')).toHaveCount(0)
  expect(await readShareCalls(page)).toEqual([])
})

test('a single-image run can be shared too, as that one file (R-X47, R-X49)', async ({ page }) => {
  test.slow()
  await stubShare(page, 'resolve')
  const dir = scratchDir('share-single')
  const source = writeAt(dir, 'only.png', buildPng(200, 150))

  await page.goto('/')
  await selectFiles(page, [source])
  await expect(page.getByTestId('preview-root')).toBeVisible()
  await pressCompress(page)
  await waitForRunFinished(page)

  await page.getByTestId('processing-share').click()
  await expect(page.getByTestId('processing-delivered')).toHaveText(/Shared/)

  const calls = await readShareCalls(page)
  expect(calls[0]?.names).toEqual(['only.png'])
})
