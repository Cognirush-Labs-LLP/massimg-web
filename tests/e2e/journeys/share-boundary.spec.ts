import { expect, test } from '@playwright/test'
import {
  buildPng,
  buildTruncatedPng,
  pressCompress,
  scratchDir,
  selectFiles,
  stubShare,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: the ten-versus-eleven boundary (T51, R-X47). A run is eligible for Share only if it
// STARTS with between one and ten accepted images; eligibility is fixed at the start, so a run
// that starts with eleven stays Download-only even when a failure leaves ten successes.
//
// Share is stubbed as available everywhere (see share-ui.spec.ts), so the only thing that can
// withhold the button here is the count.

function imageFiles(label: string, count: number, truncatedIndex?: number): string[] {
  const dir = scratchDir(label)
  return Array.from({ length: count }, (_, index) => {
    const name = `img-${String(index).padStart(2, '0')}.png`
    return writeAt(
      dir,
      name,
      index === truncatedIndex ? buildTruncatedPng(64, 64) : buildPng(64, 64, index),
    )
  })
}

test('a run starting with ten images offers Share', async ({ page }) => {
  test.slow()
  await stubShare(page, 'resolve')
  await page.goto('/')
  await selectFiles(page, imageFiles('ten', 10))
  await expect(page.getByTestId('primary-action-meta')).toContainText('10 images')

  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('10 succeeded')
  await expect(page.getByTestId('processing-share')).toBeVisible()
})

test('a run starting with eleven images is Download-only', async ({ page }) => {
  test.slow()
  await stubShare(page, 'resolve')
  await page.goto('/')
  await selectFiles(page, imageFiles('eleven', 11))
  await expect(page.getByTestId('primary-action-meta')).toContainText('11 images')

  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('11 succeeded')
  await expect(page.getByTestId('processing-download')).toBeVisible()
  await expect(page.getByTestId('processing-share')).toHaveCount(0)
})

test('eleven starting images stay Download-only even when a failure leaves ten successes', async ({
  page,
}) => {
  test.slow()
  await stubShare(page, 'resolve')
  await page.goto('/')
  await selectFiles(page, imageFiles('eleven-one-bad', 11, 5))
  await expect(page.getByTestId('primary-action-meta')).toContainText('11 images')

  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('10 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('1 failed')
  await expect(page.getByTestId('processing-download')).toBeVisible()
  await expect(page.getByTestId('processing-share')).toHaveCount(0)
})

test('ten starting images with one failure still offer Share for the nine that worked', async ({
  page,
}) => {
  test.slow()
  await stubShare(page, 'resolve')
  await page.goto('/')
  await selectFiles(page, imageFiles('ten-one-bad', 10, 3))

  await pressCompress(page)
  await waitForRunFinished(page)

  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('9 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('1 failed')
  await expect(page.getByTestId('processing-share')).toBeVisible()
})
