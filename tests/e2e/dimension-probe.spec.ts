import { expect, test, type Page } from '@playwright/test'

// T33-A — platform/dimension-probe.ts. Same DOM/dynamic-import constraint as thumbnails.spec.ts:
// tests/e2e/** is compiled with tsconfig.node.json (no DOM lib), so the module under test is
// loaded inside the page via a dynamic import of its served path.
const DIMENSION_PROBE_MODULE_PATH = '/src/platform/dimension-probe.ts'

interface PixelSize {
  width: number
  height: number
}

interface CanvasContext {
  fillStyle: string
  fillRect(x: number, y: number, width: number, height: number): void
}
interface Canvas {
  width: number
  height: number
  getContext(contextId: '2d'): CanvasContext
  convertToBlob(options?: { type?: string }): Promise<Blob>
}
declare const OffscreenCanvas: new (width: number, height: number) => Canvas

declare function makeFile(width: number, height: number, name: string): Promise<File>

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    async function makeFile(width: number, height: number, name: string): Promise<File> {
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      context.fillStyle = 'rgb(120, 40, 200)'
      context.fillRect(0, 0, width, height)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return new File([blob], name, { type: 'image/png' })
    }
    ;(globalThis as unknown as Record<string, unknown>).makeFile = makeFile
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

test('resolves the real natural size for each enqueued file, in the background', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const resolved: Record<string, PixelSize> = {}
      const service = mod.createDimensionProbeService({
        onResolved: (id: string, size: PixelSize) => {
          resolved[id] = size
        },
      })

      const a = await makeFile(64, 48, 'a.png')
      const b = await makeFile(100, 200, 'b.png')
      service.enqueue('a', a)
      service.enqueue('b', b)

      await new Promise((resolve) => setTimeout(resolve, 1000))
      service.clear()
      return resolved
    },
    { path: DIMENSION_PROBE_MODULE_PATH },
  )

  expect(result).toEqual({ a: { width: 64, height: 48 }, b: { width: 100, height: 200 } })
  expect(errors).toEqual([])
})

test('stop() terminates the worker instantly; resume() retries the interrupted job', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const resolved: string[] = []
      const service = mod.createDimensionProbeService({
        onResolved: (id: string) => resolved.push(id),
      })

      // Large enough that the decode is still in flight when stop() lands.
      const big = await makeFile(4000, 3000, 'big.png')
      service.enqueue('big', big)

      service.stop()
      const afterStop = [...resolved]

      // Ample time for any un-terminated worker to deliver a late completion.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const afterWait = [...resolved]

      // resume() must pick the interrupted job back up rather than losing it.
      service.resume()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const afterResume = [...resolved]

      service.clear()
      return { afterStop, afterWait, afterResume }
    },
    { path: DIMENSION_PROBE_MODULE_PATH },
  )

  expect(result.afterStop).toEqual([])
  // Nothing arrived while stopped, however long we wait — the worker was really terminated, not
  // merely told to ignore its own in-flight result.
  expect(result.afterWait).toEqual([])
  expect(result.afterResume).toEqual(['big'])
  expect(errors).toEqual([])
})

test('cancel() discards a result for one id without disturbing the rest of the queue', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ path }) => {
      const mod = await import(/* @vite-ignore */ path)
      const resolved: string[] = []
      const service = mod.createDimensionProbeService({
        onResolved: (id: string) => resolved.push(id),
      })

      const a = await makeFile(50, 50, 'a.png')
      const b = await makeFile(60, 60, 'b.png')
      service.enqueue('a', a)
      service.enqueue('b', b)
      service.cancel('a')

      await new Promise((resolve) => setTimeout(resolve, 1000))
      service.clear()
      return resolved
    },
    { path: DIMENSION_PROBE_MODULE_PATH },
  )

  expect(result).not.toContain('a')
  expect(result).toContain('b')
})
