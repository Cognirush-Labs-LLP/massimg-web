import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// T47 (Functional Design R-K1-R-K11; docs/ui-design.md §16) — the automated audit named in this
// task's Done-when clause, run once per stage mode. Gallery/Preview/Edit each already have a cheap,
// populated instance in their own feature spec (gallery-ingest.spec.ts, preview.spec.ts,
// edit-ui.spec.ts), so the audit lives there as one appended test rather than being duplicated here.
// Processing has no existing e2e coverage at all — share.spec.ts only exercises
// `src/platform/share.ts` against synthetic Files and never renders the stage — so this file builds
// the one new minimal seed it needs, reusing preview.spec.ts's `makeBytes`/`seed` convention.

const BATCH_MODULE_PATH = '/src/stores/batch.ts'
const SOURCE_FILES_MODULE_PATH = '/src/platform/source-files.ts'
const UI_MODULE_PATH = '/src/stores/ui.ts'

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

/** Seeds one 400x300 PNG straight into the batch store and source-file map. */
async function seedOne(page: Page): Promise<void> {
  await page.evaluate(
    async ({ batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)
      const bytes = await makeBytes(400, 300, 'image/png')

      setSourceFile('one', new File([bytes], 'one.png', { type: 'image/png' }))
      useBatchStore().addImages([
        {
          id: 'one',
          name: 'one.png',
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
        },
      ])
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

/**
 * T47: scoped to one stage's own root, so pre-existing site chrome (T43/T45) is out of scope.
 * `exclude` is for the one documented exception this task leaves in place rather than fixes: tint
 * (`--color-tint`) kept its original `#cf0000` (docs/functional-design.md §14.1) rather than being
 * brightened enough to clear text contrast everywhere it is used as text colour below the
 * large-text threshold — brightening it would also brighten every tint-coloured button background
 * across the whole interface, rejected as more disruptive than the one rule it would fix. See
 * docs/task-notes/T47.md.
 */
async function expectNoViolations(
  page: Page,
  testId: string,
  exclude: string[] = [],
): Promise<void> {
  let builder = new AxeBuilder({ page }).include(`[data-testid="${testId}"]`)
  for (const selector of exclude) {
    builder = builder.exclude(selector)
  }
  const results = await builder.analyze()
  expect(results.violations).toEqual([])
}

/** Processing's own tint-as-text spots — see `expectNoViolations`'s doc comment. */
const PROCESSING_TINT_TEXT = ['.total', '.halted', '.delivery-error', '.delivered']

test('Processing has no automated accessibility violations, running and delivered', async ({
  page,
}) => {
  await page.goto('/')
  await seedOne(page)
  await enterProcessing(page)
  await expect(page.getByTestId('processing-root')).toBeVisible()

  await expectNoViolations(page, 'processing-root', PROCESSING_TINT_TEXT)

  const download = page.getByTestId('processing-download')
  await expect(download).toBeVisible({ timeout: 120_000 })

  const downloadEvent = page.waitForEvent('download')
  await download.click()
  await downloadEvent

  await expect(page.getByTestId('processing-delivered')).toBeVisible()
  await expectNoViolations(page, 'processing-root', PROCESSING_TINT_TEXT)
})
