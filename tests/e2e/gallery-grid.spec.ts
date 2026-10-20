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
const GRID_WINDOW_MODULE_PATH = '/src/ui/gallery/gridWindow.ts'

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
          skipReason: null,
        })
      }
      useBatchStore().addImages(records)
    },
    { count, batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
  )
}

async function seedBatchWithNames(page: Page, names: string[]): Promise<void> {
  await page.evaluate(
    async ({ names, batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)

      const records = []
      for (const [i, name] of names.entries()) {
        const id = `seed-${i}`
        const blob = await makeBlob(64, 48)
        const file = new File([blob], name, { type: 'image/png' })
        setSourceFile(id, file)
        records.push({
          id,
          name,
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
          skipReason: null,
        })
      }
      useBatchStore().addImages(records)
    },
    { names, batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
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

/** The real layout math (gridWindow.ts), evaluated against the grid's actual measured width — so
 * expectations track real behavior instead of a hand-computed, scrollbar/browser-dependent guess. */
async function computeExpectedLayout(
  page: Page,
  itemCount: number,
): Promise<{ containerWidth: number; tileWidth: number; thumbSize: number }> {
  const containerWidth = await page
    .locator('[data-testid="gallery-grid"]')
    .evaluate((el) => el.clientWidth)
  const { tileWidth, thumbSize } = await page.evaluate(
    async ({ path, containerWidth, itemCount }) => {
      const { computeGridLayout } = await import(/* @vite-ignore */ path)
      return computeGridLayout(containerWidth, itemCount)
    },
    { path: GRID_WINDOW_MODULE_PATH, containerWidth, itemCount },
  )
  return { containerWidth, tileWidth, thumbSize }
}

/**
 * Switches the gallery back to grid view if it is not already showing.
 *
 * Seeding more images than `maximumThumbnails` (100) makes the gallery pick list view by itself
 * (T34, resolveAutomaticGalleryView in src/config/limits.ts) — these tests predate that and seed
 * 400-500. They are about the *grid's* virtualization, so they switch back the way a user would,
 * through the toolbar toggle, which also records the choice as the user's and stops anything
 * switching it back underneath them.
 */
async function showGrid(page: Page): Promise<void> {
  if ((await page.getByTestId('gallery-grid').count()) === 0) {
    await page.getByTestId('gallery-view-toggle').click()
  }
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
}

test('renders only a bounded window of tiles for a 500-image batch, at any scroll position (R-G10)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()

  await seedBatch(page, 500)
  await showGrid(page)

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

test('retained thumbnails never exceed the runtime budget, and evicted tiles regenerate (R-G10)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seedBatch(page, 400) // comfortably more than the 100 default budget
  await showGrid(page)

  // Step through the whole scrollable range so, between them, every row is visited at least once.
  const scrollHeight = await page.locator('.stage-body').evaluate((el) => el.scrollHeight)
  for (let step = 0; step <= 10; step += 1) {
    await scrollStageBody(page, (scrollHeight * step) / 10)
    await page.waitForTimeout(200) // clears the request-settle debounce each step
  }

  await expect.poll(async () => (await getStats(page)).running).toBe(false)
  const stats = await getStats(page)
  // Retention is the cap, not reads. The budget bounds how many thumbnail Blobs are held at
  // once; scrolling past more than that evicts the least-recently-visible entry and regenerates
  // it if the tile comes back, so `readsStarted` legitimately exceeds the budget on a long
  // scroll. An earlier revision did cap reads for the lifetime of the batch, which left any tile
  // scrolled past before its turn a permanent placeholder — Technical Design §10.4 records that
  // as a correctness bug and the LRU cache as its replacement.
  expect(stats.readsStarted).toBeGreaterThan(0)
  expect(stats.retained).toBeLessThanOrEqual(stats.budget)

  // The other half of the LRU contract, and the reason it replaced the lifetime read budget:
  // scrolling back to the top shows tiles whose thumbnails were evicted hundreds of images ago,
  // and they must be regenerated rather than left as placeholders for the rest of the session.
  await scrollStageBody(page, 0)
  await expect
    .poll(async () => page.locator('[data-testid="gallery-tile"] .thumb.placeholder').count(), {
      timeout: 15_000,
    })
    .toBe(0)
  // Still capped afterwards: regeneration evicts, it does not grow the cache.
  expect((await getStats(page)).retained).toBeLessThanOrEqual(stats.budget)

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

test('scrolling a large batch does not drift from scroll anchoring correcting the virtualized spacers', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  // Under maximumThumbnails (100): above it, Gallery auto-switches to list mode (R-G8), which has
  // no spacers to drift in the first place — this test wants grid mode's virtualized spacers.
  await seedBatch(page, 80)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  const scrollHeight = await page.locator('.stage-body').evaluate((el) => el.scrollHeight)
  const target = Math.floor(scrollHeight / 2)
  await scrollStageBody(page, target)
  // Give the windowing watcher, the resulting spacer-height DOM update, and any scroll-anchoring
  // correction it could provoke time to settle before reading the final position.
  await page.waitForTimeout(300)

  const actual = await page.locator('.stage-body').evaluate((el) => el.scrollTop)
  expect(Math.abs(actual - target)).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('the thumbnail box is capped and square even once the tile stretches past the cap (R-G3)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  // Narrow enough to land on a small column count, wide enough that each column's tile stretches
  // past MAX_THUMBNAIL_SIZE (200px) — the scenario the cap exists for.
  await page.setViewportSize({ width: 700, height: 800 })
  await page.goto('/')
  await seedBatch(page, 5)
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  const expected = await computeExpectedLayout(page, 5)
  expect(expected.tileWidth).toBeGreaterThan(200) // sanity: this viewport does exercise the cap
  expect(expected.thumbSize).toBe(200)

  const box = await page.getByTestId('gallery-tile').first().locator('.thumb').boundingBox()
  expect(box).not.toBeNull()
  expect(box?.width).toBeCloseTo(200, 0)
  expect(box?.height).toBeCloseTo(200, 0)
  expect(errors).toEqual([])
})

test('a long filename wraps across tiles instead of widening its tile (R-G1)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  const longName = 'a'.repeat(40) + '_a_filename_with_no_natural_break_points_whatsoever.png'
  await seedBatchWithNames(page, ['img-0.png', longName, 'img-2.png'])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  const tiles = page.getByTestId('gallery-tile')
  const widths = await tiles.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
  // All tiles share one grid row at this width, so a widened tile would show up as unequal widths.
  expect(widths[0]).toBeCloseTo(widths[1], 0)
  expect(widths[0]).toBeCloseTo(widths[2], 0)

  // A short filename's own box is one line's worth of height — use it as the reference instead of
  // a hard-coded line-height, so the assertion doesn't depend on font metrics.
  const oneLineHeight = (await tiles.nth(0).locator('.filename').boundingBox())?.height ?? 15
  const longFilenameBox = await tiles.nth(1).locator('.filename').boundingBox()
  expect(longFilenameBox).not.toBeNull()
  // Wraps past one line (it's genuinely using the fix), but clamped to 2 — not growing without
  // bound for an arbitrarily long name.
  expect(longFilenameBox?.height ?? 0).toBeGreaterThan(oneLineHeight * 1.3)
  expect(longFilenameBox?.height ?? 0).toBeLessThanOrEqual(oneLineHeight * 2.2)
  expect(errors).toEqual([])
})
