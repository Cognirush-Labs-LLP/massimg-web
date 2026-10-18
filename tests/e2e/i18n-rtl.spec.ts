import { expect, test, type Locator, type Page } from '@playwright/test'

// T48 (Functional Design R-L4; docs/technical-design.md §11) — the RTL pseudo-locale layout test
// named in this task's Done-when clause. stylelint's `liberty/use-logical-spec` (T07) already
// catches a physical property *name* at lint time; what it cannot catch is a logical property that
// resolves to the wrong side at *render* time because something else overrode it, or a component
// that never used a logical property to begin with. This spec renders the app with the real CSS
// cascade applied and asserts the side panel and mobile drawer actually swap edges under the
// pseudo locale (`src/i18n/pseudo/messages.ts`), which only happens if R-L4's inline-start/
// inline-end properties are doing real work.
//
// Fixtures are seeded the same way accessibility.spec.ts/preview.spec.ts/edit-ui.spec.ts already
// do: a synthetic image written straight into the batch store and source-file map via in-page
// dynamic imports of the served module paths, not a real file-picker selection.

const BATCH_MODULE_PATH = '/src/stores/batch.ts'
const SOURCE_FILES_MODULE_PATH = '/src/platform/source-files.ts'
const UI_MODULE_PATH = '/src/stores/ui.ts'
const LOCALE_MODULE_PATH = '/src/i18n/locale.ts'

interface CanvasContext {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
}
interface Canvas {
  getContext(contextId: '2d'): CanvasContext
  convertToBlob(options?: { type?: string }): Promise<Blob>
}
declare const OffscreenCanvas: new (width: number, height: number) => Canvas
declare function makeBytes(
  width: number,
  height: number,
  type: string,
): Promise<Uint8Array<ArrayBuffer>>
// tests/e2e has no DOM lib (tsconfig.node.json) — these page-side reads are declared minimally,
// the same convention this file's other ambient declarations already use.
declare const document: {
  documentElement: { dir: string; scrollWidth: number; clientWidth: number }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    async function makeBytes(width: number, height: number, type: string): Promise<Uint8Array> {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = 'rgb(80, 120, 200)'
      context.fillRect(0, 0, width, height)
      return new Uint8Array(await (await canvas.convertToBlob({ type })).arrayBuffer())
    }
    ;(globalThis as unknown as Record<string, unknown>).makeBytes = makeBytes
  })
})

/**
 * Seeds two 400x300 PNGs straight into the batch store and source-file map. Two, not one: adding
 * exactly one image auto-opens Preview for it (R-M1, src/stores/ui.ts's `onBatchCountChanged`,
 * fired by `useBatchStore.addImages` regardless of caller), which would skip past Gallery before
 * this helper's caller gets a chance to assert anything about it.
 */
async function seedTwo(page: Page): Promise<void> {
  await page.evaluate(
    async ({ batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)
      const records = []

      for (const id of ['one', 'two']) {
        const bytes = await makeBytes(400, 300, 'image/png')
        setSourceFile(id, new File([bytes], `${id}.png`, { type: 'image/png' }))
        records.push({
          id,
          name: `${id}.png`,
          relativePath: null,
          sizeBytes: bytes.byteLength,
          width: 400,
          height: 300,
          sourceFormat: 'png',
          isAnimated: false,
          frameCount: null,
          hasTransparency: false,
          edit: null,
          status: 'ready',
          failure: null,
          skipReason: null,
        })
      }

      useBatchStore().addImages(records)
    },
    { batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
  )
}

/** Drives straight into the Processing stage, the same way the real "Compress" action does. */
async function enterProcessing(page: Page): Promise<void> {
  await page.evaluate(async (uiPath) => {
    const { useUiStore } = await import(/* @vite-ignore */ uiPath)
    useUiStore().enterProcessing()
  }, UI_MODULE_PATH)
}

async function setPageLocale(page: Page, code: 'en' | 'pseudo'): Promise<void> {
  await page.evaluate(
    async ({ localePath, code }) => {
      const { setLocale } = await import(/* @vite-ignore */ localePath)
      setLocale(code)
    },
    { localePath: LOCALE_MODULE_PATH, code },
  )
}

async function htmlDir(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.dir)
}

/** Captures an element's box, switches to the pseudo locale, and returns both boxes. */
async function mirroredBoxes(
  page: Page,
  locator: Locator,
): Promise<{ ltr: { x: number }; rtl: { x: number } }> {
  const ltr = await locator.boundingBox()
  if (!ltr) {
    throw new Error('element has no box under the default locale')
  }

  await setPageLocale(page, 'pseudo')
  await expect.poll(() => htmlDir(page)).toBe('rtl')

  const rtl = await locator.boundingBox()
  if (!rtl) {
    throw new Error('element has no box under the pseudo locale')
  }

  return { ltr, rtl }
}

test.describe('RTL pseudo-locale layout (R-L4, T48)', () => {
  // Preview performs a real encode before preview-image appears (same reason preview.spec.ts
  // gives itself a long timeout) — codec initialisation on first use dominates the wall time.
  test.describe.configure({ timeout: 120_000 })

  test('the default locale is not RTL', async ({ page }) => {
    await page.goto('/')
    expect(await htmlDir(page)).toBe('ltr')
  })

  test('mirrors the desktop side panel in Gallery', async ({ page }) => {
    await page.goto('/')
    await seedTwo(page)
    const panel = page.locator('.side-panel-static')
    await expect(panel).toBeVisible()

    const { ltr, rtl } = await mirroredBoxes(page, panel)
    expect(rtl.x).toBeLessThan(ltr.x)
  })

  test('mirrors the desktop side panel in Preview', async ({ page }) => {
    await page.goto('/')
    await seedTwo(page)
    await expect(page.getByTestId('gallery-grid')).toBeVisible()
    await page.getByTestId('gallery-tile-open').first().click()
    await expect(page.getByTestId('preview-root')).toBeVisible()

    const panel = page.locator('.side-panel-static')
    await expect(panel).toBeVisible()
    const { ltr, rtl } = await mirroredBoxes(page, panel)
    expect(rtl.x).toBeLessThan(ltr.x)
  })

  test('mirrors the desktop side panel in Edit', async ({ page }) => {
    await page.goto('/')
    await seedTwo(page)
    await expect(page.getByTestId('gallery-grid')).toBeVisible()
    await page.getByTestId('gallery-tile-open').first().click()
    await expect(page.getByTestId('preview-root')).toBeVisible()
    await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
    await page.getByTestId('preview-edit').click()
    await expect(page.getByTestId('edit-root')).toBeVisible()

    const panel = page.locator('.side-panel-static')
    await expect(panel).toBeVisible()
    const { ltr, rtl } = await mirroredBoxes(page, panel)
    expect(rtl.x).toBeLessThan(ltr.x)
  })

  test('mirrors the mobile drawer', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 })
    await page.goto('/')
    await seedTwo(page)
    await page.getByTestId('options-button').click()

    const drawer = page.getByTestId('drawer-panel')
    await expect(drawer).toBeVisible()
    const { ltr, rtl } = await mirroredBoxes(page, drawer)
    expect(rtl.x).toBeLessThan(ltr.x)
  })

  test('renders Processing under the pseudo locale with no horizontal overflow', async ({
    page,
  }) => {
    await page.goto('/')
    await seedTwo(page)
    await setPageLocale(page, 'pseudo')
    await expect.poll(() => htmlDir(page)).toBe('rtl')
    await enterProcessing(page)
    await expect(page.getByTestId('processing-root')).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })
})
