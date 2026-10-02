import { expect, test, type Page } from '@playwright/test'

// T20 — platform/thumbnails.ts. Same DOM/dynamic-import constraint as capability.spec.ts,
// picker.spec.ts, folder.spec.ts and opfs.spec.ts: tests/e2e/** is compiled with tsconfig.node.json,
// which has no DOM lib, so the modules under test are loaded inside the page via a dynamic import of
// their served paths, and every browser-side result is mapped down to a plain, serializable shape
// before it crosses back to Node — a Blob's own bytes never make the trip (T18's caveat).
const THUMBNAILS_MODULE_PATH = '/src/platform/thumbnails.ts'
const LIMITS_MODULE_PATH = '/src/config/limits.ts'
const RENDER_MODULE_PATH = '/src/platform/thumbnail-render.ts'

interface Stats {
  readsStarted: number
  retained: number
  budget: number
  running: boolean
  workerAlive: boolean
}

interface PixelSize {
  width: number
  height: number
}

// The browser APIs used inside page callbacks, declared minimally because tests/e2e has no DOM lib.
interface CanvasContext {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
  drawImage(image: { width: number; height: number }, x: number, y: number): void
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
}
interface Canvas {
  width: number
  height: number
  getContext(contextId: '2d'): CanvasContext
  convertToBlob(options?: { type?: string }): Promise<Blob>
}
declare const OffscreenCanvas: new (width: number, height: number) => Canvas
declare function createImageBitmap(source: Blob): Promise<{ width: number; height: number }>

// Fixture builders installed into the page by the beforeEach below. Fixtures are generated in the
// page rather than loaded from disk so the permanent suite stays fast and self-contained; the real
// photographs belong to verification/t20-thumbnails, which is where C5's numbers come from.
interface FixtureSource {
  id: string
  blob: Blob
  source: PixelSize
  edit: unknown
}
declare function makeBlob(
  width: number,
  height: number,
  paint: (context: CanvasContext) => void,
): Promise<Blob>
declare function makeSources(
  count: number,
  width?: number,
  height?: number,
): Promise<FixtureSource[]>

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    async function makeBlob(
      width: number,
      height: number,
      paint: (context: CanvasContext) => void,
    ): Promise<Blob> {
      const canvas = new OffscreenCanvas(width, height)
      paint(canvas.getContext('2d'))
      return canvas.convertToBlob({ type: 'image/png' })
    }

    async function makeSources(count: number, width = 64, height = 48): Promise<FixtureSource[]> {
      const sources: FixtureSource[] = []
      for (let i = 0; i < count; i++) {
        const blob = await makeBlob(width, height, (context) => {
          context.fillStyle = `rgb(${(i * 20) % 256}, 120, 200)`
          context.fillRect(0, 0, width, height)
        })
        sources.push({ id: `img-${i}`, blob, source: { width, height }, edit: null })
      }
      return sources
    }
    ;(globalThis as unknown as Record<string, unknown>).makeBlob = makeBlob
    ;(globalThis as unknown as Record<string, unknown>).makeSources = makeSources
  })
})

/** Collects uncaught page errors and console errors — R-G10's budget path must raise neither. */
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

test('generates every requested tile, retaining only the most recently visible up to the budget (LRU)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path, budget, count }) => {
      const mod = await import(/* @vite-ignore */ path)
      const readyIds: string[] = []
      const service = mod.createThumbnailService({
        maximumThumbnails: budget,
        onReady: (id: string) => readyIds.push(id),
      })

      const sources = await makeSources(count)
      service.setVisible(sources)
      await service.whenIdle()

      const urls = sources.map((source) => service.urlFor(source.id) as string | null)
      const stats = service.stats() as Stats
      service.clear()

      return {
        stats,
        cached: urls.filter((url) => url !== null).length,
        placeholders: urls.filter((url) => url === null).length,
        readyIds,
      }
    },
    { path: THUMBNAILS_MODULE_PATH, budget: 3, count: 10 },
  )

  // Nothing is refused generation any more — every one of the 10 gets a real attempt.
  expect(result.stats.readsStarted).toBe(10)
  expect(result.readyIds).toHaveLength(10)
  // But only the 3 most recently generated stay retained; the rest were evicted to make room.
  expect(result.stats.retained).toBe(3)
  expect(result.stats.budget).toBe(3)
  expect(result.stats.running).toBe(false)
  expect(result.cached).toBe(3)
  expect(result.placeholders).toBe(7)
  expect(errors).toEqual([])
})

test('the budget caps retained thumbnails and is injected, not baked into the service', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path, limitsPath, budgets, count }) => {
      const mod = await import(/* @vite-ignore */ path)
      const limits = await import(/* @vite-ignore */ limitsPath)

      const retained: number[] = []
      for (const budget of budgets) {
        const service = mod.createThumbnailService({ maximumThumbnails: budget })
        service.setVisible(await makeSources(count))
        await service.whenIdle()
        retained.push((service.stats() as Stats).retained)
        service.clear()
      }

      const unconfigured = mod.createThumbnailService()
      const defaultBudget = (unconfigured.stats() as Stats).budget
      unconfigured.clear()

      return {
        retained,
        defaultBudget,
        configured: limits.runtimeLimits.maximumThumbnails as number,
      }
    },
    { path: THUMBNAILS_MODULE_PATH, limitsPath: LIMITS_MODULE_PATH, budgets: [3, 5], count: 8 },
  )

  // Two different limits against one unmodified service: changing the limit needs no service change,
  // and the unconfigured default is whatever the runtime limits module says, not a local constant.
  expect(result.retained).toEqual([3, 5])
  expect(result.defaultBudget).toBe(result.configured)
})

test('a tile evicted by LRU is regenerated once it becomes visible again', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path, budget, count }) => {
      const mod = await import(/* @vite-ignore */ path)
      const service = mod.createThumbnailService({ maximumThumbnails: budget })
      const sources = await makeSources(count)
      const [first] = sources as [FixtureSource]

      // Scroll through everything once — by the end, the first tile has long since been evicted.
      service.setVisible(sources)
      await service.whenIdle()
      const evicted = service.urlFor(first.id) as string | null
      const readsAfterFirstPass = (service.stats() as Stats).readsStarted

      // Scroll back up to it.
      service.setVisible([first])
      await service.whenIdle()
      const regenerated = service.urlFor(first.id) as string | null
      const readsAfterRevisit = (service.stats() as Stats).readsStarted

      service.clear()
      return { evicted, regenerated, readsAfterFirstPass, readsAfterRevisit }
    },
    { path: THUMBNAILS_MODULE_PATH, budget: 3, count: 10 },
  )

  expect(result.evicted).toBeNull()
  expect(result.regenerated).not.toBeNull()
  // The revisit is a genuine second read of the same source, not a cache hit — that's the cost of
  // choosing to regenerate rather than permanently give up.
  expect(result.readsAfterRevisit).toBe(result.readsAfterFirstPass + 1)
  expect(errors).toEqual([])
})

test('a tile kept in every visible window is never evicted, even once more distinct tiles than the budget have been requested', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path, budget, count }) => {
      const mod = await import(/* @vite-ignore */ path)
      const service = mod.createThumbnailService({ maximumThumbnails: budget })
      const sources = await makeSources(count)
      const [pinned] = sources as [FixtureSource]

      // Each window keeps the first tile alongside a different one-tile-at-a-time sweep through the
      // rest — like a pinned header tile that never scrolls out while everything else does.
      for (const source of sources.slice(1)) {
        service.setVisible([pinned, source])
        await service.whenIdle()
      }

      const pinnedUrl = service.urlFor(pinned.id) as string | null
      service.clear()
      return { pinnedUrl }
    },
    { path: THUMBNAILS_MODULE_PATH, budget: 3, count: 10 },
  )

  expect(result.pinnedUrl).not.toBeNull()
})

test('revisiting cached tiles causes no reread and reuses the same object URL', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const service = mod.createThumbnailService({ maximumThumbnails: 10 })
      const sources = await makeSources(4)

      service.setVisible(sources)
      await service.whenIdle()
      const first = {
        reads: (service.stats() as Stats).readsStarted,
        urls: sources.map((source) => service.urlFor(source.id) as string | null),
      }

      service.setVisible(sources)
      await service.whenIdle()
      const second = {
        reads: (service.stats() as Stats).readsStarted,
        urls: sources.map((source) => service.urlFor(source.id) as string | null),
      }

      service.clear()
      return { first, second }
    },
    { path: THUMBNAILS_MODULE_PATH },
  )

  expect(result.first.reads).toBe(4)
  expect(result.second.reads).toBe(4)
  expect(result.second.urls).toEqual(result.first.urls)
})

test('a fast scroll does not start a read for every tile it passes', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const service = mod.createThumbnailService({ maximumThumbnails: 100 })
      const sources = await makeSources(12)

      // Three disjoint windows in immediate succession: two of them scrolled straight past.
      service.setVisible(sources.slice(0, 4))
      service.setVisible(sources.slice(4, 8))
      service.setVisible(sources.slice(8, 12))
      await service.whenIdle()

      const reads = (service.stats() as Stats).readsStarted
      const lastWindowCached = sources
        .slice(8, 12)
        .every((source) => service.urlFor(source.id) !== null)
      service.clear()
      return { reads, lastWindowCached }
    },
    { path: THUMBNAILS_MODULE_PATH },
  )

  // At most the one job already in flight when the window changed, plus the final window of four.
  expect(result.reads).toBeLessThanOrEqual(5)
  expect(result.reads).toBeLessThan(12)
  expect(result.lastWindowCached).toBe(true)
})

test('thumbnails reflect stored rotation and crop', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path, renderPath }) => {
      const mod = await import(/* @vite-ignore */ path)
      const render = await import(/* @vite-ignore */ renderPath)

      // Four quadrants, so a rotation shows up in the pixels and not only in the dimensions.
      const width = 400
      const height = 200
      const blob = await makeBlob(width, height, (context) => {
        context.fillStyle = 'rgb(255, 0, 0)'
        context.fillRect(0, 0, 200, 100)
        context.fillStyle = 'rgb(0, 255, 0)'
        context.fillRect(200, 0, 200, 100)
        context.fillStyle = 'rgb(0, 0, 255)'
        context.fillRect(0, 100, 200, 100)
        context.fillStyle = 'rgb(255, 255, 0)'
        context.fillRect(200, 100, 200, 100)
      })

      const ops = [
        { kind: 'rotate', quarterTurns: 1 },
        {
          kind: 'crop',
          rect: { x: 0, y: 0, width: 1, height: 0.5 },
          zoom: 1,
          background: { r: 0, g: 0, b: 0, a: 1 },
        },
      ]

      const service = mod.createThumbnailService({
        maximumThumbnails: 4,
        maxEdge: 384,
        format: 'image/webp',
        quality: 1,
      })
      service.setVisible([
        { id: 'edited', blob, source: { width, height }, edit: { ops, version: 1 } },
      ])
      await service.whenIdle()

      const url = service.urlFor('edited') as string
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      context.drawImage(bitmap, 0, 0)

      const sample = (x: number, y: number) =>
        Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)

      const measured = { width: bitmap.width, height: bitmap.height }
      const expected = render.thumbnailSize({ width, height }, ops, 384) as PixelSize
      const left = sample(Math.round(bitmap.width * 0.25), Math.round(bitmap.height * 0.5))
      const right = sample(Math.round(bitmap.width * 0.75), Math.round(bitmap.height * 0.5))

      service.clear()
      return { measured, expected, left, right }
    },
    { path: THUMBNAILS_MODULE_PATH, renderPath: RENDER_MODULE_PATH },
  )

  expect(result.measured).toEqual(result.expected)
  // 400x200 rotated one turn clockwise is 200x400; its top half is the source's left column, which
  // is blue above red once rotated.
  expect(result.measured).toEqual({ width: 200, height: 200 })
  expectColour(result.left, [0, 0, 255])
  expectColour(result.right, [255, 0, 0])
})

function expectColour(measured: number[], expected: number[]): void {
  for (const [index, channel] of expected.entries()) {
    expect(Math.abs((measured[index] ?? -1) - channel)).toBeLessThanOrEqual(24)
  }
}

test('generation runs in a worker that stop() terminates, discarding the raced completion', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const readyIds: string[] = []
      const service = mod.createThumbnailService({
        maximumThumbnails: 20,
        onReady: (id: string) => readyIds.push(id),
      })

      // Large enough that the decode is still in flight when stop() lands.
      const sources = await makeSources(6, 2400, 1800)
      service.setVisible(sources)
      const whileRunning = service.stats() as Stats

      service.stop()
      const afterStop = service.stats() as Stats

      // Ample time for any un-terminated worker to deliver a late completion.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const settled = service.stats() as Stats

      // Work resumes on a fresh window, so stop() is not a one-way door.
      service.setVisible(sources.slice(0, 1))
      const resumed = service.stats() as Stats
      await service.whenIdle()
      const afterResume = service.stats() as Stats

      service.clear()
      return { whileRunning, afterStop, settled, resumed, afterResume, readyIds }
    },
    { path: THUMBNAILS_MODULE_PATH },
  )

  // The worker path is genuinely taken on this engine — the no-worker degradation in the service is
  // not silently hiding a broken test.
  expect(result.whileRunning.workerAlive).toBe(true)
  expect(result.whileRunning.running).toBe(true)

  expect(result.afterStop.running).toBe(false)
  expect(result.afterStop.workerAlive).toBe(false)

  // The in-flight job's completion never entered the cache, and no further work happened.
  expect(result.settled.retained).toBe(0)
  expect(result.settled.readsStarted).toBe(result.afterStop.readsStarted)
  expect(result.settled.running).toBe(false)
  expect(result.settled.workerAlive).toBe(false)

  expect(result.resumed.workerAlive).toBe(true)
  expect(result.afterResume.retained).toBe(1)
  expect(result.readyIds).toHaveLength(1)
  expect(errors).toEqual([])
})

test('releasing an entry revokes its object URL', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const service = mod.createThumbnailService({ maximumThumbnails: 10 })
      const sources = await makeSources(2)
      const [first, second] = sources as [FixtureSource, FixtureSource]

      service.setVisible(sources)
      await service.whenIdle()
      const invalidatedUrl = service.urlFor(first.id) as string
      const clearedUrl = service.urlFor(second.id) as string

      const fetchable = (url: string) => fetch(url).then(() => true) as Promise<boolean>

      service.invalidate(first.id)
      const afterInvalidate = {
        url: service.urlFor(first.id) as string | null,
        retained: (service.stats() as Stats).retained,
        reads: (service.stats() as Stats).readsStarted,
        fetchable: await fetchable(invalidatedUrl).catch(() => false),
      }

      service.clear()
      const afterClear = {
        url: service.urlFor(second.id) as string | null,
        retained: (service.stats() as Stats).retained,
        fetchable: await fetchable(clearedUrl).catch(() => false),
      }

      return { afterInvalidate, afterClear }
    },
    { path: THUMBNAILS_MODULE_PATH },
  )

  expect(result.afterInvalidate.url).toBeNull()
  expect(result.afterInvalidate.retained).toBe(1)
  expect(result.afterInvalidate.fetchable).toBe(false)
  // Releasing an entry does not refund the read attempt it already spent (R-G10).
  expect(result.afterInvalidate.reads).toBe(2)

  expect(result.afterClear.url).toBeNull()
  expect(result.afterClear.retained).toBe(0)
  expect(result.afterClear.fetchable).toBe(false)
})
