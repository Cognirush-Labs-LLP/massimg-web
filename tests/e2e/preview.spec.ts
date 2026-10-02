import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// T36 — Preview mode (Functional Design R-P1-R-P8, R-M3, R-I16; Technical Design §4, §5.3).
//
// These are real encodes through the real worker pool and the real codecs: the point of Preview is
// that the figures are measured rather than estimated (§14.3), and a mocked encode would prove
// nothing about that. Fixtures are seeded straight into the batch store and the source-file map via
// in-page dynamic imports of the served module paths, the convention tests/e2e/gallery-grid.spec.ts
// and thumbnails.spec.ts already use, with bytes synthesized by OffscreenCanvas so every engine
// decodes them.
//
// Codec initialisation on first use dominates the wall time here, so the whole file is given a long
// timeout rather than sprinkling waits.

const BATCH_MODULE_PATH = '/src/stores/batch.ts'
const SOURCE_FILES_MODULE_PATH = '/src/platform/source-files.ts'
const PREVIEW_POOL_MODULE_PATH = '/src/ui/preview/preview-pool.ts'
const SIZES_MODULE_PATH = '/src/domain/sizes.ts'

test.describe.configure({ timeout: 180_000 })

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
/** Ambient so the zoom/pan tests can dispatch a real wheel event without the DOM lib loaded here. */
declare const WheelEvent: new (
  type: string,
  init?: {
    deltaY?: number
    clientX?: number
    clientY?: number
    bubbles?: boolean
    cancelable?: boolean
  },
) => Event
declare function getComputedStyle(element: unknown): {
  animationName: string
  backgroundColor: string
  color: string
}

interface SeedImage {
  id: string
  name: string
  /** Raw bytes to register as this image's source file; synthesized when absent. */
  bytes?: number[]
  sourceFormat?: string
  isAnimated?: boolean
  width?: number
  height?: number
}

function fixtureBytes(relativePath: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url))),
  )
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    async function makeBytes(width: number, height: number, type: string): Promise<Uint8Array> {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')

      // Several blocks of flat colour rather than one: a single-colour JPEG compresses to almost
      // nothing, and the zoom assertions want something with structure in it.
      for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 3; row += 1) {
          context.fillStyle = `rgb(${40 + column * 50}, ${30 + row * 60}, ${200 - column * 40})`
          context.fillRect(
            (column * width) / 4,
            (row * height) / 3,
            Math.ceil(width / 4),
            Math.ceil(height / 3),
          )
        }
      }

      return new Uint8Array(await (await canvas.convertToBlob({ type })).arrayBuffer())
    }
    ;(globalThis as unknown as Record<string, unknown>).makeBytes = makeBytes
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

async function seed(page: Page, images: SeedImage[]): Promise<void> {
  await page.evaluate(
    async ({ images, batchPath, sourceFilesPath }) => {
      const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
      const { setSourceFile } = await import(/* @vite-ignore */ sourceFilesPath)
      const records = []

      for (const image of images) {
        const format = image.sourceFormat ?? 'jpeg'
        const type = `image/${format === 'jpeg' ? 'jpeg' : format}`
        const bytes =
          image.bytes === undefined
            ? await makeBytes(image.width ?? 400, image.height ?? 300, type)
            : new Uint8Array(image.bytes)

        setSourceFile(image.id, new File([bytes], image.name, { type }))
        records.push({
          id: image.id,
          name: image.name,
          relativePath: null,
          sizeBytes: bytes.byteLength,
          width: image.width ?? 400,
          height: image.height ?? 300,
          sourceFormat: format,
          isAnimated: image.isAnimated ?? false,
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
    { images, batchPath: BATCH_MODULE_PATH, sourceFilesPath: SOURCE_FILES_MODULE_PATH },
  )
}

async function poolStarted(page: Page): Promise<number> {
  return page.evaluate(async (path) => {
    const { getPreviewPool } = await import(/* @vite-ignore */ path)
    return getPreviewPool().stats().started as number
  }, PREVIEW_POOL_MODULE_PATH)
}

/** The rendered image and its frame, in viewport pixels, for the geometry assertions. */
async function frameGeometry(page: Page) {
  const [frameBox, imageBox] = await Promise.all([
    page.getByTestId('preview-frame').boundingBox(),
    page.getByTestId('preview-image').boundingBox(),
  ])

  if (frameBox === null || imageBox === null) {
    return null
  }

  return {
    frame: { left: frameBox.x, top: frameBox.y, width: frameBox.width, height: frameBox.height },
    image: { left: imageBox.x, top: imageBox.y, width: imageBox.width, height: imageBox.height },
  }
}

/** Dispatches a real wheel-zoom gesture on the preview frame, centred at a fraction of its box. */
async function wheelZoom(page: Page, at: { xFraction: number; yFraction: number }): Promise<void> {
  await page.locator('[data-testid="preview-frame"]').evaluate((frame, params) => {
    const box = frame.getBoundingClientRect()

    frame.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -600,
        clientX: box.left + box.width * params.xFraction,
        clientY: box.top + box.height * params.yFraction,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, at)
}

/** Which fraction of the drawn image sits under the middle of the frame. */
function centredFraction(geometry: NonNullable<Awaited<ReturnType<typeof frameGeometry>>>) {
  return {
    x:
      (geometry.frame.left + geometry.frame.width / 2 - geometry.image.left) / geometry.image.width,
    y:
      (geometry.frame.top + geometry.frame.height / 2 - geometry.image.top) / geometry.image.height,
  }
}

test('encodes on entry and shows the measured size of what it rendered (R-P1, R-P2, §14.3)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()

  // Exactly one image: R-M1 opens Preview for it rather than a one-tile gallery.
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-root')).toBeVisible()
  await expect(page.getByTestId('preview-creating')).toBeVisible()
  const loadingAnimation = await page
    .getByTestId('loading-indicator')
    .locator('span')
    .first()
    .evaluate((dot) => getComputedStyle(dot).animationName)
  expect(loadingAnimation).not.toBe('none')

  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('preview-creating')).toHaveCount(0)

  // R-I16: the encoded bytes go into an <img>, and nothing in Preview is drawn through a canvas.
  const source = await page.getByTestId('preview-image').getAttribute('src')
  expect(source).toMatch(/^blob:/)
  await expect(page.locator('[data-testid="preview-root"] canvas')).toHaveCount(0)

  // The figure on screen is the byte length of the image on screen, formatted by the same
  // formatter — not an estimate, and not the figure from some other encode.
  const shown = await page.getByTestId('preview-compressed-size').textContent()
  const measured = await page.evaluate(
    async ({ url, sizesPath }) => {
      const { formatUiSize } = await import(/* @vite-ignore */ sizesPath)
      const blob = await (await fetch(url)).blob()
      return { formatted: formatUiSize(blob.size) as string, size: blob.size, type: blob.type }
    },
    { url: source!, sizesPath: SIZES_MODULE_PATH },
  )

  expect(shown?.trim()).toBe(measured.formatted)
  expect(measured.size).toBeGreaterThan(0)
  expect(measured.type).toBe('image/jpeg')

  // R-P2: the Compressed tab is the one selected.
  await expect(page.getByTestId('preview-comparison-toggle')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByTestId('preview-transform-line')).toContainText('photo.jpeg 400×300')

  expect(errors).toEqual([])
})

test('an unreachable size uses a dark notice and never renders the oversized attempt', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  await page.getByTestId('quality-target-size').click()
  await page.getByTestId('quality-size-field').fill('0.1')

  const notice = page.getByTestId('preview-size-unreachable')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  await expect(notice).toContainText('This image will be skipped.')
  await expect(page.getByTestId('preview-frame')).toHaveCount(0)
  await expect(page.getByTestId('preview-image')).toHaveCount(0)
  await expect(page.getByTestId('preview-comparison')).toHaveCount(0)

  const colors = await notice.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, text: style.color }
  })
  expect(colors).toEqual({ background: 'rgb(18, 18, 18)', text: 'rgb(255, 255, 255)' })
  expect(errors).toEqual([])
})

test('a dragged quality slider produces one encode, not one per step (R-P3)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const before = await poolStarted(page)
  const slider = page.getByTestId('quality-slider')
  const box = await slider.boundingBox()
  expect(box).not.toBeNull()

  // A real drag across the slider: `steps` generates the intermediate moves in one protocol call,
  // so they all arrive well inside the 300 ms debounce window.
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height / 2, { steps: 12 })
  await page.mouse.up()

  // The figures are hidden while the new encode is in flight rather than left stale (R-P4).
  await expect(page.getByTestId('preview-comparison')).toHaveCount(0)
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('preview-comparison')).toBeVisible()

  expect(await poolStarted(page)).toBe(before + 1)
  expect(errors).toEqual([])
})

test('the stepper wraps at both ends and keeps the comparison tab (R-P7)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [
    { id: 'a', name: 'a.jpeg' },
    { id: 'b', name: 'b.jpeg' },
    { id: 'c', name: 'c.jpeg' },
  ])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await page.getByTestId('gallery-tile-open').first().click()

  await expect(page.getByTestId('preview-stepper-position')).toHaveText('1 / 3')
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  await page.getByTestId('preview-comparison-toggle').click()
  await expect(page.getByTestId('preview-comparison-toggle')).toHaveAttribute(
    'aria-checked',
    'false',
  )

  await page.getByTestId('preview-step-previous').click()
  await expect(page.getByTestId('preview-stepper-position')).toHaveText('3 / 3')
  // R-P7: the tab survives the step. The breadcrumb proves the image really changed.
  await expect(page.getByTestId('preview-comparison-toggle')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.locator('.breadcrumb')).toHaveText('PREVIEW · c.jpeg')

  await page.getByTestId('preview-step-next').click()
  await expect(page.getByTestId('preview-stepper-position')).toHaveText('1 / 3')
  await expect(page.locator('.breadcrumb')).toHaveText('PREVIEW · a.jpeg')

  expect(errors).toEqual([])
})

test('stepping releases the outgoing image before encoding the incoming one (R-B5)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [
    { id: 'a', name: 'a.jpeg' },
    { id: 'b', name: 'b.jpeg' },
  ])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await page.getByTestId('gallery-tile-open').first().click()
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const outgoing = await page.getByTestId('preview-image').getAttribute('src')

  await page.getByTestId('preview-step-next').click()
  await expect(page.locator('.breadcrumb')).toHaveText('PREVIEW · b.jpeg')

  // The outgoing image's object URL is revoked, so its bytes are no longer reachable at all. The
  // revoked fetch itself is expected to log a resource-load failure to the console — that log line
  // is this assertion's proof, not a product error — so it is excluded from the "nothing else went
  // wrong" check below rather than asserting an empty error list outright.
  const stillReadable = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url)
      return response.ok
    } catch {
      return false
    }
  }, outgoing!)

  expect(stillReadable).toBe(false)
  // The exact wording differs per engine (Chromium: "net::ERR_FILE_NOT_FOUND"; WebKit:
  // "WebKitBlobResource error"), but both are the browser's own resource-load diagnostic for the
  // revoked fetch above, not an application error.
  expect(errors.filter((entry) => !entry.includes('Failed to load resource'))).toEqual([])
})

test('zooming and panning, then flipping tabs, keeps the same patch of the image centred', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const atRest = await frameGeometry(page)
  expect(atRest).not.toBeNull()
  // R-P6 at rest: the image exactly fills its contain-fit frame.
  expect(atRest!.image.width).toBeCloseTo(atRest!.frame.width, 0)

  // Zoom in about a point above and left of centre, then drag.
  await wheelZoom(page, { xFraction: 0.3, yFraction: 0.3 })

  const zoomed = await frameGeometry(page)
  expect(zoomed!.image.width).toBeGreaterThan(atRest!.image.width * 1.5)

  const frameBox = await page.getByTestId('preview-frame').boundingBox()
  await page.mouse.move(frameBox!.x + frameBox!.width / 2, frameBox!.y + frameBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    frameBox!.x + frameBox!.width / 2 - 40,
    frameBox!.y + frameBox!.height / 2 - 25,
    { steps: 5 },
  )
  await page.mouse.up()

  const compressed = await frameGeometry(page)
  const compressedFraction = centredFraction(compressed!)

  // Flip to Original. The viewport is stored once, in one space, so the same patch must be centred.
  await page.getByTestId('preview-comparison-toggle').click()
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'original')
  await expect
    .poll(async () => (await frameGeometry(page))!.image.width)
    .toBeGreaterThan(atRest!.image.width * 1.5)

  const originalFraction = centredFraction((await frameGeometry(page))!)

  expect(originalFraction.x).toBeCloseTo(compressedFraction.x, 2)
  expect(originalFraction.y).toBeCloseTo(compressedFraction.y, 2)

  // And flipping back lands exactly where it was.
  await page.getByTestId('preview-comparison-toggle').click()
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'compressed')

  const backAgain = centredFraction((await frameGeometry(page))!)

  expect(backAgain.x).toBeCloseTo(compressedFraction.x, 3)
  expect(backAgain.y).toBeCloseTo(compressedFraction.y, 3)

  expect(errors).toEqual([])
})

test('the viewport survives a settings change and resets on a step', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [
    { id: 'a', name: 'a.jpeg' },
    { id: 'b', name: 'b.jpeg' },
  ])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await page.getByTestId('gallery-tile-open').first().click()
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const atRest = await frameGeometry(page)

  await wheelZoom(page, { xFraction: 0.5, yFraction: 0.5 })

  const zoomedWidth = (await frameGeometry(page))!.image.width
  expect(zoomedWidth).toBeGreaterThan(atRest!.image.width * 1.5)

  // Tuning quality while inspecting a detail is the whole point of keeping the viewport.
  await page.getByTestId('quality-chip-low').click()
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(async () => (await frameGeometry(page))!.image.width)
    .toBeCloseTo(zoomedWidth, 0)

  // Stepping to a different image starts from fit-to-frame again.
  await page.getByTestId('preview-step-next').click()
  await expect(page.locator('.breadcrumb')).toHaveText('PREVIEW · b.jpeg')
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(async () => {
      const geometry = await frameGeometry(page)
      return geometry === null ? 0 : geometry.image.width - geometry.frame.width
    })
    .toBeCloseTo(0, 0)

  expect(errors).toEqual([])
})

test('a frame that cannot be encoded shows an inline error with a retry (§10)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  // Bytes that are not an image at all, declared as a PNG: the decode fails inside the worker.
  await seed(page, [
    { id: 'bad', name: 'broken.png', sourceFormat: 'png', bytes: [1, 2, 3, 4, 5, 6, 7, 8] },
  ])

  await expect(page.getByTestId('preview-error')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('preview-error')).toContainText('broken.png')
  await expect(page.getByTestId('preview-comparison')).toHaveCount(0)

  const before = await poolStarted(page)
  await page.getByTestId('preview-retry').click()

  await expect(page.getByTestId('preview-error')).toBeVisible({ timeout: 120_000 })
  expect(await poolStarted(page)).toBe(before + 1)

  // A failed decode is reported, not thrown at the console.
  expect(errors).toEqual([])
})

test('keeps the image aspect ratio at every viewport size (R-P6)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg', width: 400, height: 300 }])
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1000, height: 420 },
    { width: 700, height: 900 },
    { width: 380, height: 700 },
  ]) {
    await page.setViewportSize(size)

    // Waits for the host's ResizeObserver callback to actually settle, not just for one geometry
    // read: between `setViewportSize` and that callback firing, the frame's rendered box is already
    // CSS-clamped to its new, resized flex container while the absolutely-positioned image inside is
    // still sized from the previous `hostSize` measurement — one ordinary ResizeObserver-driven tick
    // of lag, the same kind `GalleryGrid.vue` has, not a persistent R-P6 violation. Polling the whole
    // invariant (ratio *and* containment) is what waits that out, rather than racing a single
    // snapshot immediately after the resize.
    await expect
      .poll(async () => {
        const geometry = await frameGeometry(page)

        if (geometry === null || geometry.image.height === 0) {
          return false
        }

        const ratio = geometry.image.width / geometry.image.height

        return (
          Math.abs(ratio - 4 / 3) < 0.05 &&
          geometry.image.width <= geometry.frame.width + 1 &&
          geometry.image.height <= geometry.frame.height + 1
        )
      })
      .toBe(true)
  }

  expect(errors).toEqual([])
})

test('an animated source is shown as an image on both tabs, never a canvas (R-P8, R-I16)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [
    {
      id: 'anim',
      name: 'loop.gif',
      sourceFormat: 'gif',
      isAnimated: true,
      bytes: fixtureBytes('animated/anim-6f.gif'),
      width: 64,
      height: 64,
    },
  ])

  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const compressed = await page.getByTestId('preview-image').getAttribute('src')
  const encoded = await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob()
    const header = new Uint8Array(await blob.slice(0, 6).arrayBuffer())

    return { type: blob.type, size: blob.size, header: [...header] }
  }, compressed!)

  // Still a GIF, so the animation survived rather than being flattened (R-F5).
  expect(encoded.type).toBe('image/gif')
  expect(String.fromCharCode(...encoded.header)).toMatch(/^GIF8/)
  expect(encoded.size).toBeGreaterThan(0)

  await page.getByTestId('preview-comparison-toggle').click()
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'original')
  expect(await page.getByTestId('preview-image').getAttribute('src')).toMatch(/^blob:/)
  await expect(page.locator('[data-testid="preview-root"] canvas')).toHaveCount(0)

  // R-C16: editing an animated source is not offered, and the reason is stated.
  await expect(page.getByTestId('preview-edit')).toBeDisabled()
  await expect(page.getByTestId('preview-edit-animated-note')).toBeVisible()

  expect(errors).toEqual([])
})

test('Add more images and Back to images leave Preview the way the transition table says', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-root')).toBeVisible()

  // R-M3's action is offered from Preview; the picker itself is the platform layer's, so this
  // asserts the control is there and wired rather than driving a real file dialog.
  await expect(page.getByTestId('preview-add-more')).toBeVisible()

  await page.getByTestId('preview-back').click()
  await expect(page.getByTestId('gallery-grid')).toBeVisible()
  await expect(page.getByTestId('preview-root')).toHaveCount(0)

  // R-M2: a second image added while Preview is open returns to the Gallery.
  await page.getByTestId('gallery-tile-open').first().click()
  await expect(page.getByTestId('preview-root')).toBeVisible()
  await seed(page, [{ id: 'two', name: 'second.jpeg' }])
  await expect(page.getByTestId('gallery-grid')).toBeVisible()

  expect(errors).toEqual([])
})

test('changing the format re-encodes and updates both the line and the figures', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')
  await seed(page, [{ id: 'one', name: 'photo.jpeg' }])
  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })

  const before = await page.getByTestId('preview-compressed-size').textContent()

  await page.getByTestId('format-select').selectOption('webp')

  // The transform line is settings-driven, so it changes at once — before any encode finishes.
  await expect(page.getByTestId('preview-transform-line')).toContainText('photo.webp')

  await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('preview-comparison')).toBeVisible()

  const source = await page.getByTestId('preview-image').getAttribute('src')
  const type = await page.evaluate(async (url) => (await (await fetch(url)).blob()).type, source!)

  expect(type).toBe('image/webp')
  expect(await page.getByTestId('preview-compressed-size').textContent()).not.toBe(before)

  expect(errors).toEqual([])
})
