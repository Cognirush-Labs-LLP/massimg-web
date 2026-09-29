import { expect, test, type Page } from '@playwright/test'

// T33-B — the virtualized Gallery grid (Technical Design §10.4, R-G1-R-G6, R-G10, R-G12).
// Fixtures are seeded directly into the real app's batch store and source-file map via in-page
// dynamic imports of the served module paths — the same convention tests/e2e/thumbnails.spec.ts
// already uses — rather than driving hundreds of real file-picker selections, which is slow and
// already covered at small scale by gallery-ingest.spec.ts's real-picker tests. Image bytes are
// synthesized in-page with OffscreenCanvas (same `makeBlob` helper as thumbnails.spec.ts) rather
// than a hand-written PNG fixture: a degenerate hand-rolled 1x1 PNG was tried first and turned out
// to silently fail `createImageBitmap` on some engines, which is a fixture problem, not a grid one
// — canvas-synthesized bytes are what T20's own suite already validated as decodable everywhere.
//
// This suite proves the grid body itself: bounded DOM/thumbnail work regardless of batch size, the
// shared read budget, placeholders beyond it, generation stopping on leaving Gallery, and removal
// isolation.

const BATCH_MODULE_PATH = '/src/stores/batch.ts'
const SOURCE_FILES_MODULE_PATH = '/src/platform/source-files.ts'
const THUMBNAIL_SERVICE_MODULE_PATH = '/src/ui/gallery/thumbnail-service.ts'

interface ThumbnailStats {
  readsStarted: number
  retained: number
  budget: number
  running: boolean
  workerAlive: boolean
}

interface CanvasContext {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
}
interface Canvas {
  getContext(contextId: '2d'): CanvasContext
  convertToBlob(options?: { type?: string }): Promise<Blob>
}
declare const OffscreenCanvas: new (width: number, height: number) => Canvas
declare function makeBlob(width: number, height: number): Promise<Blob>

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    async function makeBlob(width: number, height: number): Promise<Blob> {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = 'rgb(180, 60, 60)'
      context.fillRect(0, 0, width, height)
      return canvas.convertToBlob({ type: 'image/png' })
    }
    ;(globalThis as unknown as Record<string, unknown>).makeBlob = makeBlob
  })
})

function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`)
    }
  })
  return errors
}

async function seedBatch(page: Page, count: number): Promise<void> {
  await page.evaluate(
    async ({ count, batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)

      const records = []
      for (let i = 0; i < count; i += 1) {
        const id = `seed-${i}`
        const blob = await makeBlob(64, 48)
        const file = new File([blob], `img-${i}.png`, { type: 'image/png' })
        setSourceFile(id, file)
        records.push({
          id,
          name: `img-${i}.png`,
          relativePath: null,
          sizeBytes: file.size,
          width: 64,
          height: 48,
          sourceFormat: 'png',
          isAnimated: false,
          frameCount: null,
          hasTransparency: null,
          edit: null,
          status: 'ready',
          failure: null,
        })
      }
      useBatchStore().addImages(records)
    },
    { count, batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
  )
}

async function getStats(page: Page): Promise<ThumbnailStats> {
  return page.evaluate(async (path) => {
    const { getThumbnailService } = await import(/* @vite-ignore */ path)
    return getThumbnailService().stats()
  }, THUMBNAIL_SERVICE_MODULE_PATH)
}

async function scrollStageBody(page: Page, top: number): Promise<void> {
  await page
    .locator('.stage-body')
    .evaluate((el, scrollTop) => el.scrollTo({ top: scrollTop }), top)
}

test('renders only a bounded window of tiles for a 500-image batch, at any scroll position (R-G10)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()

  await seedBatch(page, 500)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  const initialTiles = await page.getByTestId('gallery-tile').count()
  expect(initialTiles).toBeGreaterThan(0)
  expect(initialTiles).toBeLessThan(100) // virtualized: nowhere near 500 DOM tiles

  const scrollHeight = await page.locator('.stage-body').evaluate((el) => el.scrollHeight)
  await scrollStageBody(page, scrollHeight / 2)
  await expect.poll(() => page.getByTestId('gallery-tile').count()).toBeGreaterThan(0)
  expect(await page.getByTestId('gallery-tile').count()).toBeLessThan(100)

  await scrollStageBody(page, scrollHeight)
  await expect.poll(() => page.getByTestId('gallery-tile').count()).toBeGreaterThan(0)
  expect(await page.getByTestId('gallery-tile').count()).toBeLessThan(100)

  expect(errors).toEqual([])
})

test('thumbnail reads and retained blobs never exceed the runtime budget; the rest are placeholders (R-G10)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seedBatch(page, 400) // comfortably more than the 100 default budget
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  // Step through the whole scrollable range so, between them, every row is visited at least once.
  const scrollHeight = await page.locator('.stage-body').evaluate((el) => el.scrollHeight)
  for (let step = 0; step <= 10; step += 1) {
    await scrollStageBody(page, (scrollHeight * step) / 10)
    await page.waitForTimeout(200) // clears the request-settle debounce each step
  }

  await expect.poll(async () => (await getStats(page)).running).toBe(false)
  const stats = await getStats(page)
  expect(stats.readsStarted).toBeLessThanOrEqual(stats.budget)
  expect(stats.retained).toBeLessThanOrEqual(stats.budget)
  // With 400 images and a 100 budget, most of what's on screen at the end must be unread.
  const placeholders = await page.locator('[data-testid="gallery-tile"] .thumb.placeholder').count()
  expect(placeholders).toBeGreaterThan(0)

  expect(errors).toEqual([])
})

test('leaving Gallery stops thumbnail generation (R-G12)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  // More than one image, so the batch stays on Gallery grid rather than auto-opening Preview (R-M1).
  await seedBatch(page, 20)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await expect.poll(async () => (await getStats(page)).retained).toBeGreaterThan(0)

  await page.getByTestId('gallery-tile-open').first().click()
  await expect(page.getByTestId('gallery-grid')).toHaveCount(0)

  const stats = await getStats(page)
  expect(stats.running).toBe(false)
  expect(stats.workerAlive).toBe(false)
  expect(errors).toEqual([])
})

test('removing one tile releases only its own thumbnail, leaving the others cached (R-G2, R-G3)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seedBatch(page, 3)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  await expect.poll(async () => (await getStats(page)).retained).toBe(3)

  await page.getByTestId('gallery-tile-remove').first().click()

  await expect(page.getByTestId('gallery-tile')).toHaveCount(2)
  const stats = await getStats(page)
  expect(stats.retained).toBe(2)
  expect(errors).toEqual([])
})
