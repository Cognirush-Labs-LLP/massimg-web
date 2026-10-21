import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/** T47: scoped to one stage's own root, so pre-existing site chrome (T43/T45) is out of scope. */
async function expectNoViolations(page: Page, testId: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include(`[data-testid="${testId}"]`).analyze()
  expect(results.violations).toEqual([])
}

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
  // An empty batch renders no populated header at all, so there is no count to read.
  await expect(page.getByTestId('gallery-meta')).toHaveCount(0)

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([pngA, pngB, nonImage])

  // Only the two PNGs count — the .txt file is classified as not-image and silently skipped.
  await expect(page.getByTestId('gallery-meta')).toContainText('2 images')
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
  await expect(page.getByTestId('gallery-meta')).toContainText('2 images')

  await page.getByRole('button', { name: 'Clear' }).click()

  await expect(page.getByTestId('gallery-meta')).toHaveCount(0)
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()
})

// T47 (R-K1-R-K11): an automated audit of the populated Gallery stage.
test('the populated gallery has no automated accessibility violations', async ({ page }) => {
  const { pngA, pngB } = writeFixtures()

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([pngA, pngB])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  await expectNoViolations(page, 'gallery-root')
})

// T47-B: the side panel (`aside.side-panel-static`) is a sibling of `gallery-root` in
// ToolPage.vue, not nested inside it, so the scan above never covers it or the new Dimension-row
// help dialogs it added. Scanned separately here, open, since that's the state most likely to
// surface a contrast issue in new content (the muted note line, the illustrative diagram).
test('a Dimension help dialog has no automated accessibility violations, open', async ({
  page,
}) => {
  const { pngA, pngB } = writeFixtures()

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([pngA, pngB])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  await page.getByTestId('dimension-help-fit-long-edge').click()
  await expect(page.getByTestId('help-dialog')).toBeVisible()

  await expectNoViolations(page, 'help-dialog')
})

test('WebP for animated images: offered before any image is added, and the warning follows the choice', async ({
  page,
}) => {
  const animatedGif = fileURLToPath(new URL('../fixtures/animated/anim-6f.gif', import.meta.url))
  const { pngA } = writeFixtures()
  const checkbox = page.getByTestId('format-animated-webp')

  await page.goto('/')
  await expect(checkbox).toHaveCount(0)

  // Choosing the format first still shows the choice, with the default on.
  await page.getByTestId('format-select').selectOption('jpeg')
  await expect(checkbox).toBeChecked()
  await expect(page.getByTestId('format-animated-hint')).toHaveCount(0)

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([animatedGif, pngA])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  await expect(page.getByTestId('format-animated-hint')).toContainText('animated WebP')
  await expect(page.locator('.badge-animated')).toHaveText('ANIMATED')

  await checkbox.uncheck()

  await expect(page.getByTestId('format-animated-hint')).toContainText('first frame')
  await expect(page.locator('.badge-first-frame')).toHaveText('FIRST FRAME')
  await expect(page.locator('.badge-animated')).toHaveCount(0)

  const results = await new AxeBuilder({ page })
    .include('[data-testid="format-animated-hint"]')
    .include('.badge-first-frame')
    .analyze()
  expect(results.violations).toEqual([])

  // Switching to a format that can animate removes the choice and restores the ANIMATED badge.
  await page.getByTestId('format-select').selectOption('webp')
  await expect(checkbox).toHaveCount(0)
  await expect(page.locator('.badge-animated')).toHaveText('ANIMATED')
})
