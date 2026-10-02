import { expect, test, type Page } from '@playwright/test'

// T22 — pipeline/codecs/loader.ts (Technical Design §5.2, §12.1; Assumption C8). Same
// DOM/dynamic-import constraint as pool.spec.ts, thumbnails.spec.ts and capability.spec.ts:
// tests/e2e/** is compiled with tsconfig.node.json, which has no DOM lib, so the pool and the loader
// are driven inside the page via a dynamic import of their served paths.
//
// Every job in this file is dispatched through the real `createWorkerPool()` with its default
// `workerFactory` — the shipped `pipeline/worker.ts` → `execute.ts` → `codecs/loader.ts` path, not a
// probe. Every job carries a one-byte source, so it settles `failed` — `decode-failed` for the
// formats whose stage chain exists (JPEG since T26, still PNG since T27), `unimplemented` for the
// ones that are still unbuilt — which is irrelevant here: what this file
// proves is which network requests `executeJob`'s `ensureCodecsForJob(job.settings)` call causes
// before any stage runs, not what the job returns. Awaiting a job's own `done` promise is therefore a deterministic checkpoint — by the time
// it settles, every codec load that job was going to trigger has either happened or never will.
const POOL_MODULE_PATH = '/src/pipeline/pool.ts'
const PREVIEW_POOL_MODULE_PATH = '/src/ui/preview/preview-pool.ts'

// The browser APIs used inside page callbacks, declared minimally because tests/e2e has no DOM lib.
declare function makeCodecJob(
  imageId: string,
  format: 'jpeg' | 'gif' | 'png',
  isAnimated?: boolean,
): unknown

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>

    scope.makeCodecJob = (imageId: string, format: string, isAnimated = false) => ({
      imageId,
      source: new Uint8Array([0]),
      edit: null,
      settings: {
        quality: { kind: 'quality', value: 80, lossless: false },
        dimension: { kind: 'original' },
        format,
        isAnimated,
        alpha: { kind: 'preserve' },
      },
      intent: 'preview',
    })
  })
})

/** Runs one job to completion through the real pool and returns nothing — only the side effects on
 * the network (captured by the caller via `page.on('request')`) matter to these tests. */
async function runJob(
  page: Page,
  format: 'jpeg' | 'gif' | 'png',
  isAnimated = false,
): Promise<void> {
  await page.evaluate(
    async ({ poolPath, format, isAnimated }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1 })
      await instance.run(makeCodecJob('img', format, isAnimated)).done
      instance.destroy()
    },
    { poolPath: POOL_MODULE_PATH, format, isAnimated },
  )
}

function requestUrls(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (request) => urls.push(request.url()))
  return urls
}

test('first paint is not blocked by any WASM fetch, and ImageMagick loads afterward', async ({
  page,
}) => {
  const urls = requestUrls(page)

  // 'domcontentloaded' fires once the placeholder shell has parsed and rendered — before the
  // `load` event that `scheduleImageMagickPreload()` (wired into app/ToolPage.vue) waits for.
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const atFirstPaint = [...urls]
  expect(atFirstPaint.some((url) => url.includes('magick'))).toBe(false)
  // Broader than the ImageMagick-specific check above: catches an eager oxipng/quantizer/
  // apng-optimizer load too, not just ImageMagick. Does not catch gifsicle — it ships its WASM
  // embedded inside a JS string rather than as a separate `.wasm` asset (loader.ts's `ensureGifsicle`
  // doc comment) — but nothing before this point should be loading gifsicle either way (no job has
  // run yet), so that gap doesn't weaken what this assertion is checking.
  expect(atFirstPaint.some((url) => url.endsWith('.wasm'))).toBe(false)

  // The idle preload really does fire afterwards — proving the property above is "deferred", not
  // "never happens". requestIdleCallback's own timeout is 2000ms and the WebKit setTimeout fallback
  // is 200ms (loader.ts), so this is a generous bound, not a tight one.
  await page.waitForRequest((request) => request.url().includes('magick'), { timeout: 10000 })
})

test('ImageMagick loads exactly once: the idle preload warms the same worker a later job uses', async ({
  page,
}) => {
  const urls = requestUrls(page)
  await page.goto('/')

  // The preload's own load is two requests — the pre-bundled JS wrapper, then the wasm binary
  // itself — so wait for the actual binary specifically before taking the "before" snapshot, or an
  // in-flight first load could be mistaken for a second one below.
  await page.waitForRequest((request) => request.url().endsWith('magick.wasm'), { timeout: 10000 })
  const afterPreload = urls.filter((url) => url.endsWith('magick.wasm')).length
  expect(afterPreload).toBe(1)

  // Reuses `getPreviewPool()` — the very pool `app/ToolPage.vue`'s idle preload just warmed via
  // `pool.ts`'s `warm()` — and runs a real job through it, the same way dropping an image does. This
  // is the regression this test exists to catch: before `warm()` existed, the preload initialised a
  // throwaway ImageMagick instance on the main thread while the first real job paid for a second,
  // independent load inside the worker. One load total, not two, is what this asserts now.
  await page.evaluate(async (previewPoolPath) => {
    const mod = await import(/* @vite-ignore */ previewPoolPath)
    const pool = mod.getPreviewPool()
    await pool.run(makeCodecJob('img', 'jpeg')).done
  }, PREVIEW_POOL_MODULE_PATH)

  expect(urls.filter((url) => url.endsWith('magick.wasm')).length).toBe(afterPreload)
})

test('a GIF job triggers the gifsicle load', async ({ page }) => {
  const urls = requestUrls(page)
  await page.goto('/')

  await runJob(page, 'gif')

  expect(urls.some((url) => url.includes('gifsicle'))).toBe(true)
})

test('a JPEG job never triggers the gifsicle load', async ({ page }) => {
  const urls = requestUrls(page)
  await page.goto('/')

  await runJob(page, 'jpeg')

  // The job's own `done` promise (inside runJob) already settled, and `ensureCodecsForJob` is
  // awaited before `execute.ts` throws — so every codec load a JPEG job could have caused has
  // already either happened or never will by this point. No arbitrary wait needed.
  expect(urls.some((url) => url.includes('gifsicle'))).toBe(false)
})

test('a still PNG job loads oxipng and the quantizer, not UPNG or apng-optimizer', async ({
  page,
}) => {
  const urls = requestUrls(page)
  await page.goto('/')

  await runJob(page, 'png', false)

  expect(urls.some((url) => url.includes('oxipng') || url.includes('squoosh_oxipng'))).toBe(true)
  expect(urls.some((url) => url.includes('imagequant'))).toBe(true)
  expect(urls.some((url) => url.includes('apng-optimizer'))).toBe(false)
})

test('an animated PNG job loads apng-optimizer and oxipng, but not the quantizer', async ({
  page,
}) => {
  const urls = requestUrls(page)
  await page.goto('/')

  await runJob(page, 'png', true)

  expect(urls.some((url) => url.includes('apng-optimizer'))).toBe(true)
  expect(urls.some((url) => url.includes('oxipng') || url.includes('squoosh_oxipng'))).toBe(true)
  expect(urls.some((url) => url.includes('imagequant'))).toBe(false)
})

test('a JPEG job still loads ImageMagick, on the worker side, even before the idle preload fires', async ({
  page,
}) => {
  const urls = requestUrls(page)
  // No `waitUntil: 'load'` here and no wait for the idle preload — the job itself is the only
  // trigger being tested.
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1 })
      await instance.run(makeCodecJob('img', 'jpeg')).done
      instance.destroy()
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(urls.some((url) => url.includes('magick'))).toBe(true)
})
