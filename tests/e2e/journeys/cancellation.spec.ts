import { expect, test } from '@playwright/test'
import { pressCompress, readFixture, scratchDir, selectFiles, writeAt } from './support'

// Journey: cancelling a run (T51, R-X19, R-X20, R-X26, R-X27). Cancel stops after the image in
// flight, shows "Stopping" at once, raises no confirmation, throws every partial result away and
// returns to Gallery with the batch — and so the settings and edits — exactly as it was.
//
// The images are the repository's deliberately slow decode fixture (a 12 MP JPEG 2000), enough of
// them that the run cannot finish before Cancel lands.

const COUNT = 8

test('Cancel stops the run, asks nothing, and returns to Gallery with the batch intact', async ({
  page,
}) => {
  test.slow()
  const dir = scratchDir('cancel')
  const slow = readFixture('decode', 'slow.jp2')
  const files = Array.from({ length: COUNT }, (_, index) =>
    writeAt(dir, `slow-${String(index).padStart(2, '0')}.jp2`, slow),
  )

  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('primary-action-meta')).toContainText(`${COUNT} images`)

  await pressCompress(page)
  await expect(page.getByTestId('processing-root')).toBeVisible()
  const cancel = page.getByTestId('processing-cancel')
  await expect(cancel).toHaveText('Cancel')
  await cancel.click()

  // R-X27: the button owns up to what it is doing before the run has actually halted.
  await expect(cancel).toHaveText('Stopping')

  // R-X19/R-X20: straight to Gallery, no dialog, nothing left over from the run.
  await expect(page.getByTestId('gallery-root')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('processing-root')).toHaveCount(0)
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect(page.getByTestId('processing-download')).toHaveCount(0)

  // The batch is exactly as it was, so the same Compress can simply be pressed again.
  await expect(page.getByTestId('primary-action-meta')).toContainText(`${COUNT} images`)
  await expect(page.getByTestId('gallery-meta')).toContainText(`${COUNT} images`)
})
