import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// T39: selection-time rejections through the real UI — classify()'s `unhandled` class surfaces as
// a named, dismissible entry instead of ingest.ts silently dropping it, while an ordinary non-image
// stays silent (R-I2's third class). Per-image failure/skip surfaces are Processing's own suite
// (tests/e2e/*.spec.ts covering T36-A/T38); this file is selection time only.

const ONE_PIXEL_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108020000009077053d' +
  '000000097048597300000ec300000ec301c76fa864000000174944415478da6360' +
  '6060000000000600' +
  '01ac9dbd3c00000000049454e44ae426082'

function writeFixtures(): {
  png: string
  png2: string
  psd: string
  svg: string
  nonImage: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-rejections-'))
  const png = join(dir, 'good.png')
  const png2 = join(dir, 'good2.png')
  const psd = join(dir, 'bad.psd')
  const svg = join(dir, 'icon.svg')
  const nonImage = join(dir, 'notes.txt')
  writeFileSync(png, Buffer.from(ONE_PIXEL_PNG_HEX, 'hex'))
  writeFileSync(png2, Buffer.from(ONE_PIXEL_PNG_HEX, 'hex'))
  writeFileSync(psd, Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(20)]))
  writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  writeFileSync(nonImage, 'not an image')
  return { png, png2, psd, svg, nonImage }
}

test('a mixed selection adds the supported images, names the unsupported one, and keeps the non-image silent (R-I2, R-I3, R-E1, R-E2)', async ({
  page,
}) => {
  const { png, png2, psd, nonImage } = writeFixtures()

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  // Two supported images, not one — a batch of exactly one auto-opens Preview (R-M1), unmounting
  // Gallery's own populated-state text, which this assertion needs. The single-image case is its
  // own test below.
  await (await chooserPromise).setFiles([png, png2, psd, nonImage])

  // Both PNGs were added; the .txt file is silently absent from both the batch and the rejection list.
  await expect(
    page.getByTestId('gallery-root').getByText('2 images', { exact: false }),
  ).toBeVisible()

  const rejectionList = page.getByTestId('rejection-list')
  await expect(rejectionList).toBeVisible()
  await expect(rejectionList).toContainText('bad.psd')
  await expect(rejectionList).not.toContainText('notes.txt')
  // One panel, one row for the one rejected file — not one alert per file (R-E2).
  await expect(page.getByTestId('rejection-entry')).toHaveCount(1)

  await page.getByTestId('rejection-dismiss').click()
  await expect(rejectionList).toHaveCount(0)
})

test('the rejection panel survives the auto-navigation to Preview when exactly one image is added (R-M1)', async ({
  page,
}) => {
  const { png, psd } = writeFixtures()

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  // Exactly one supported image alongside the rejected PSD: R-M1 auto-opens Preview for it and
  // unmounts Gallery (whose own component tree the rejection panel deliberately does not live
  // in — see RejectionList.vue) immediately after this selection lands.
  await (await chooserPromise).setFiles([png, psd])

  await expect(page.getByTestId('preview-root')).toBeVisible()
  await expect(page.getByTestId('gallery-root')).toHaveCount(0)
  const rejectionList = page.getByTestId('rejection-list')
  await expect(rejectionList).toBeVisible()
  await expect(rejectionList).toContainText('bad.psd')
})

test('a new selection replaces the previous rejection list rather than accumulating', async ({
  page,
}) => {
  const { psd, svg } = writeFixtures()

  await page.goto('/')
  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([psd])
  await expect(page.getByTestId('rejection-entry')).toHaveCount(1)
  await expect(page.getByTestId('rejection-list')).toContainText('bad.psd')

  // The batch is still empty (the PSD was rejected, not added), so the empty state's own
  // "Select images" button is still what's on screen, not the toolbar's "Add Images".
  chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([svg])

  await expect(page.getByTestId('rejection-entry')).toHaveCount(1)
  await expect(page.getByTestId('rejection-list')).toContainText('icon.svg')
  await expect(page.getByTestId('rejection-list')).not.toContainText('bad.psd')
})

// Header-declared size, through the real picker: a 39 KB PNG that declares 324 megapixels is named
// and turned away before anything decodes it (R-I19, R-I20, R-I21), while the ordinary images in the
// same selection are added. The fixture is tests/fixtures/limits/bomb-18k-area.png.
test('an image whose header declares more pixels than the device can hold is named, with its size and the cap', async ({
  page,
}) => {
  const { png, png2 } = writeFixtures()
  const bomb = fileURLToPath(new URL('../fixtures/limits/bomb-18k-area.png', import.meta.url))

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([png, png2, bomb])

  await expect(
    page.getByTestId('gallery-root').getByText('2 images', { exact: false }),
  ).toBeVisible()

  const entry = page.getByTestId('rejection-entry')
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('bomb-18k-area.png')
  await expect(entry).toContainText('18000 × 18000')
  await expect(entry).toContainText('megapixel')
  await expect(entry).toContainText('desktop application')
})
