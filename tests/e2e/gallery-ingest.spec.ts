import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// T33-A: real selection through the actual UI (empty state -> populated -> Clear), proving
// ingest.ts's classify -> ImageRecord -> store path end to end, distinct from T20's own
// module-level thumbnail/dimension-probe tests. Grid-body behaviour (thumbnails, virtualization,
// badges, remove) is T33-B's own suite, tests/e2e/gallery-grid.spec.ts.

// A minimal, valid 1x1 red PNG (well-known fixture bytes).
const ONE_PIXEL_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077053d' +
  '000000097048597300000ec300000ec301c76fa864000000174944415478da6360' +
  '6060000000000600' +
  '01ac9dbd3c00000000049454e44ae426082'

function writeFixtures(): { pngA: string; pngB: string; nonImage: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-ingest-'))
  const png = Buffer.from(ONE_PIXEL_PNG_HEX, 'hex')
  const pngA = join(dir, 'a.png')
  const pngB = join(dir, 'b.png')
  const nonImage = join(dir, 'notes.txt')
  writeFileSync(pngA, png)
  writeFileSync(pngB, png)
  writeFileSync(nonImage, 'not an image')
  return { pngA, pngB, nonImage }
}

test('selecting files populates the batch; a non-image among them is skipped, not blocking (R-I3)', async ({
  page,
}) => {
  const { pngA, pngB, nonImage } = writeFixtures()

  await page.goto('/')
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()
  await expect(page.getByText('0 SELECTED')).toBeVisible()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([pngA, pngB, nonImage])

  // Only the two PNGs count — the .txt file is classified as not-image and silently skipped.
  await expect(page.getByText('2 SELECTED')).toBeVisible()
  await expect(page.getByTestId('gallery-empty-state')).toHaveCount(0)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible()
})

test('Clear empties the batch and returns to the empty state with no confirmation (R-G6)', async ({
  page,
}) => {
  const { pngA, pngB } = writeFixtures()

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  // Two images, not one — a batch of exactly one auto-opens Preview (R-M1), which has no Clear
  // button; this test wants Gallery's own populated state.
  await (await chooserPromise).setFiles([pngA, pngB])
  await expect(page.getByText('2 SELECTED')).toBeVisible()

  await page.getByRole('button', { name: 'Clear' }).click()

  await expect(page.getByText('0 SELECTED')).toBeVisible()
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()
})
