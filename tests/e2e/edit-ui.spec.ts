import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/** T47: scoped to one stage's own root, so pre-existing site chrome (T43/T45) is out of scope. */
async function expectNoViolations(page: Page, testId: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include(`[data-testid="${testId}"]`).analyze()
  expect(results.violations).toEqual([])
}

// T37 — Edit mode (Functional Design R-C1-R-C17, R-K4; Technical Design §6; docs/ui-design.md §12).
//
// Edit mode performs no encode of its own (see src/stores/edit-draft.ts's own header comment), so
// unlike preview.spec.ts these tests need no codec warm-up — they drive the real crop/rotation UI
// and check it against the real domain arithmetic (`domain/edit.ts`) and the real stores, the same
// in-page dynamic-import convention preview.spec.ts/edit.spec.ts already use.
//
// Two gaps flagged by earlier tasks are closed here, since this is the first real crop UI to exist:
//   - T35: no Playwright check existed that a genuine crop engages the Dimension accordion's
//     R-D2/R-D3 override note (docs/task-notes/T35.md).
//   - T36: `domain/viewport.ts`'s crop-aware projection was unit-tested on constructed fixtures
//     only, with no real UI path to exercise it (docs/task-notes/T36.md).

const BATCH_MODULE_PATH = '/src/stores/batch.ts'
const SOURCE_FILES_MODULE_PATH = '/src/platform/source-files.ts'
const EDIT_DRAFT_MODULE_PATH = '/src/stores/edit-draft.ts'
const UI_MODULE_PATH = '/src/stores/ui.ts'

// T43 wrapped the tool route in an outer site shell. The tool route itself gets no outer
// header, only a compact footer (31px, measured live via .site-footer's boundingBox at the
// default 1280×720 viewport), which shrinks the Edit frame host below what these
// pixel-calibrated drag assertions were tuned against. Restoring that 31px keeps the host's
// on-screen size — and therefore the letterbox geometry `snapMoveToImage`'s snap threshold is
// checked against — identical to before T43, so this file's existing coordinate math stays
// valid without touching domain/edit.ts or the test logic itself.
test.use({ viewport: { width: 1280, height: 720 + 31 } })

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

/** Seeds one 800x400 PNG image, straight into the batch store and source-file map. */
async function seedOne(page: Page, id = 'one'): Promise<void> {
  await page.evaluate(
    async ({ id, batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)
      const bytes = await makeBytes(800, 400, 'image/png')

      setSourceFile(id, new File([bytes], `${id}.png`, { type: 'image/png' }))
      useBatchStore().addImages([
        {
          id,
          name: `${id}.png`,
          relativePath: null,
          sizeBytes: bytes.byteLength,
          width: 800,
          height: 400,
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
    { id, batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
  )
}

async function openEdit(page: Page): Promise<void> {
  await page.getByTestId('preview-edit').click()
  await expect(page.getByTestId('edit-root')).toBeVisible()
}

interface PixelSize {
  width: number
  height: number
}

/** The live, resolved crop geometry straight from the running draft store — the same value the
 * on-screen badge renders, read independently of the DOM. */
async function draftGeometry(
  page: Page,
): Promise<{ kind: string; output?: { size: PixelSize } } | null> {
  return page.evaluate(async (path) => {
    const { useEditDraftStore } = await import(/* @vite-ignore */ path)
    return useEditDraftStore().geometry
  }, EDIT_DRAFT_MODULE_PATH)
}

async function storedEdit(page: Page, id = 'one'): Promise<unknown> {
  return page.evaluate(
    async ({ path, id }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ path)
      const image = useBatchStore().images.find((candidate: { id: string }) => candidate.id === id)
      return image?.edit ?? null
    },
    { path: BATCH_MODULE_PATH, id },
  )
}

async function stageMode(page: Page): Promise<string> {
  return page.evaluate(async (path) => {
    const { useUiStore } = await import(/* @vite-ignore */ path)
    return useUiStore().stageMode
  }, UI_MODULE_PATH)
}

/** `preview.spec.ts`'s own convention: an Apply/Cancel/Remove that returns to Preview triggers a
 * real re-encode through a real worker, so these tests need the same console/error watch — a
 * failed `postMessage` (e.g. a reactive value smuggled into the stored edit) throws as an
 * unhandled rejection rather than a visible UI error, and would otherwise pass silently (see
 * docs/task-notes/T37.md, Surprises). */
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

/** Waits for the real re-encode after Apply/Cancel/Remove to actually finish, not just for
 * `preview-root` to be in the DOM — the symptom of a failed `postMessage` is exactly a
 * `preview-root` that renders immediately and then sits on "Creating preview..." forever. */
async function expectPreviewFinishes(page: Page): Promise<void> {
  await expect(page.getByTestId('preview-root')).toBeVisible()
  await expect(page.getByTestId('preview-creating')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 15_000 })
}

test('the on-screen badge matches domain/edit.ts exactly through rotate, drag, ratio and zoom', async ({
  page,
}) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-ratio-1:1').click()
  await page.getByTestId('edit-zoom-slider').fill('0.6')

  const handle = page.getByTestId('edit-frame-handle-bottom-right')
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x - 30, box!.y - 30, { steps: 5 })
  await page.mouse.up()

  const geometry = await draftGeometry(page)
  expect(geometry?.kind).toBe('resolved')
  const badgeText = await page.getByTestId('edit-frame-badge').textContent()
  expect(badgeText).toBe(`${geometry?.output?.size.width}×${geometry?.output?.size.height}`)
})

test('dragging the rect toward a spilling corner neither reflows the frame nor flickers the background row mid-gesture', async ({
  page,
}) => {
  // Regression for a real bug: the background row has real layout height, and Edit's stage is a
  // flex column, so mounting it reactively the instant an intermediate drag position happened to
  // spill shrank the measured frame *while the drag was still computing deltas against the old
  // size* — one geometry change feeding back into the gesture that caused it, visibly distorting
  // the crop and producing a confusing final result (docs/task-notes/T37.md, Surprises). Fixed by
  // freezing the row's visibility for the duration of any drag/resize and debouncing it by 1s
  // after release (`useEditDraftStore`'s `dragging`/`visibleBackgroundRow`).
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  async function frameSize() {
    return page.evaluate(async (p) => {
      const { useEditDraftStore } = await import(/* @vite-ignore */ p)
      return useEditDraftStore().frame
    }, EDIT_DRAFT_MODULE_PATH)
  }

  const frameBefore = await frameSize()
  const rectBox = await page.getByTestId('edit-frame-rect').boundingBox()
  const hostBox = await page.getByTestId('edit-frame-host').boundingBox()
  const startX = rectBox!.x + rectBox!.width / 2
  const startY = rectBox!.y + rectBox!.height / 2
  const targetX = hostBox!.x + 2
  const targetY = hostBox!.y + 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()

  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(
      startX + (targetX - startX) * fraction,
      startY + (targetY - startY) * fraction,
    )
    // Never mounts mid-gesture, no matter what any intermediate position's spill state is.
    await expect(page.getByTestId('edit-background-row')).toHaveCount(0)
    expect(await frameSize()).toEqual(frameBefore)
  }

  await page.mouse.up()

  // The final (top-left-corner) position does spill, but the row only appears after a debounce —
  // not instantly on release either. Once it does, the frame legitimately reflows to make room
  // for it — that's correct settled behaviour, not the bug this test guards against.
  await expect(page.getByTestId('edit-background-row')).toHaveCount(0)
  await expect(page.getByTestId('edit-background-row')).toBeVisible({ timeout: 3000 })
})

test('at 100% zoom, dragging to the image corner snaps flush and never needs a background', async ({
  page,
}) => {
  // Regression for the user's own report: a drag intended to land exactly on the image's edge
  // routinely overshot by a few pixels into the frame's letterbox margin (the gap between a
  // non-matching-aspect frame and the image's own smaller displayed box), triggering spill and
  // the background row for a plain JPEG -> JPEG crop with no transparency involved at all. Fixed
  // with a magnetic edge snap (`domain/edit.ts`'s `snapMoveToImage`/`snapResizeToImage`) — see
  // docs/task-notes/T37.md, Surprises.
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  const rectBox = await page.getByTestId('edit-frame-rect').boundingBox()
  const hostBox = await page.getByTestId('edit-frame-host').boundingBox()
  await page.mouse.move(rectBox!.x + rectBox!.width / 2, rectBox!.y + rectBox!.height / 2)
  await page.mouse.down()
  // Toward the host's corner, but stopping a couple of pixels short of it — close enough to the
  // image's own (letterboxed, inset) edge to fall inside the snap threshold.
  await page.mouse.move(hostBox!.x + 30, hostBox!.y + 30, { steps: 10 })
  await page.mouse.up()

  await page.waitForTimeout(1500) // longer than the debounce — no late appearance either
  await expect(page.getByTestId('edit-background-row')).toHaveCount(0)
})

test('Apply stores the crop, Preview reflects it, and re-opening Edit restores every value', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-width-field').fill('300')
  await page.getByTestId('edit-apply').click()

  await expectPreviewFinishes(page)
  expect(await stageMode(page)).toBe('preview')
  const applied = (await storedEdit(page)) as { ops: Array<{ kind: string }> } | null
  expect(applied).not.toBeNull()
  expect(applied?.ops.some((op) => op.kind === 'rotate')).toBe(true)
  expect(applied?.ops.some((op) => op.kind === 'crop')).toBe(true)
  await expect(page.getByTestId('preview-edit')).toHaveText('Edit changes')

  await openEdit(page)
  const reopened = await draftGeometry(page)
  expect(reopened).toMatchObject({ output: { size: { width: 300 } } })
  const quarterTurns = await page.evaluate(async (path) => {
    const { useEditDraftStore } = await import(/* @vite-ignore */ path)
    return useEditDraftStore().quarterTurns
  }, EDIT_DRAFT_MODULE_PATH)
  expect(quarterTurns).toBe(1)
  expect(errors).toEqual([])
})

test('Cancel restores every value including rotation, discarding further changes', async ({
  page,
}) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)
  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-width-field').fill('300')
  await page.getByTestId('edit-apply').click()
  const before = await storedEdit(page)

  await openEdit(page)
  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-width-field').fill('150')
  await page.getByTestId('edit-cancel').click()

  await expect(page.getByTestId('preview-root')).toBeVisible()
  expect(await storedEdit(page)).toEqual(before)
})

test('Remove edit clears rotation and crop together, back to Preview', async ({ page }) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)
  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-apply').click()

  await openEdit(page)
  await expect(page.getByTestId('edit-remove')).toBeVisible()
  await page.getByTestId('edit-remove').click()

  await expect(page.getByTestId('preview-root')).toBeVisible()
  expect(await storedEdit(page)).toBeNull()
  await expect(page.getByTestId('preview-edit')).toHaveText('Edit')
})

test('the background row appears only on spill and reacts live to a JPEG format change', async ({
  page,
}) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await expect(page.getByTestId('edit-background-row')).toHaveCount(0)

  await page.getByTestId('edit-zoom-slider').fill('0.3')
  await expect(page.getByTestId('edit-background-row')).toBeVisible()
  await expect(page.getByTestId('edit-background-transparent')).toBeVisible()
  await expect(page.getByTestId('edit-background-jpeg-hint')).toHaveCount(0)

  // R-C13/R-C14, live: the side panel's Format control stays open and interactive during Edit.
  await page.getByTestId('format-select').selectOption('jpeg')
  await expect(page.getByTestId('edit-background-transparent')).toHaveCount(0)
  await expect(page.getByTestId('edit-background-jpeg-hint')).toBeVisible()

  await page.getByTestId('format-select').selectOption('dont-change')
  await expect(page.getByTestId('edit-background-transparent')).toBeVisible()
})

test('a non-default background fill on a spilled crop survives Apply and re-encodes cleanly', async ({
  page,
}) => {
  // Regression for a real bug: a chosen swatch is a reactive Pinia ref read, and embedding it
  // unsanitised in the stored crop op poisoned the next `postMessage` to the pipeline worker with
  // a `DataCloneError` — silent in the console, surfacing only as Preview stuck forever on
  // "Creating preview..." (docs/task-notes/T37.md, Surprises). Fixed in `batch.ts#updateImage`.
  const errors = watchForErrors(page)
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await page.getByTestId('edit-ratio-16:9').click()
  await page.getByTestId('edit-zoom-slider').fill('0.3')
  await expect(page.getByTestId('edit-background-row')).toBeVisible()
  await page.getByTestId('edit-background-white').click()
  await page.getByTestId('edit-apply').click()

  await expectPreviewFinishes(page)

  // Re-entering Edit and applying again exercises the op-carried-forward path too (the same shape
  // T36-A's recovery-resize write already relied on before this fix existed).
  await openEdit(page)
  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-apply').click()
  await expectPreviewFinishes(page)

  expect(errors).toEqual([])
})

test('Escape cancels without applying, Enter applies (R-K4)', async ({ page }) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await page.getByTestId('edit-rotate-right').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('preview-root')).toBeVisible()
  expect(await storedEdit(page)).toBeNull()

  await openEdit(page)
  await page.getByTestId('edit-rotate-right').click()
  await page.locator('[data-testid="edit-frame-rect"]').focus()
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('preview-root')).toBeVisible()
  const applied = (await storedEdit(page)) as { ops: Array<{ kind: string }> } | null
  expect(applied?.ops.some((op) => op.kind === 'rotate')).toBe(true)
})

test('a genuine crop engages the Dimension accordion override note (closes T35 gap)', async ({
  page,
}) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  await page.getByTestId('edit-width-field').fill('300')
  await page.getByTestId('edit-apply').click()
  await expect(page.getByTestId('preview-root')).toBeVisible()

  await expect(page.getByTestId('dimension-note-single')).toBeVisible()
  await expect(page.getByTestId('dimension-row-fit-long-edge')).toBeDisabled()
})

// T47 (R-K1-R-K11): an automated audit of Edit mode, including the richer state after a crop drag
// so the background row/handles that only appear once the crop spills past the image are covered.
test('Edit has no automated accessibility violations', async ({ page }) => {
  await page.goto('/')
  await seedOne(page)
  await expect(page.getByTestId('preview-image')).toBeVisible()
  await openEdit(page)

  const handle = page.getByTestId('edit-frame-handle-bottom-right')
  const box = await handle.boundingBox()
  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 60)
    await page.mouse.up()
  }

  await expectNoViolations(page, 'edit-root')
})
