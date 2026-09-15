import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// T24 — pipeline/stages/edit.ts (Functional Design R-C1 to R-C17, R-I11; Technical Design §4.2, §6).
//
// The pixel-exact proof of the stage lives in src/pipeline/stages/edit.spec.ts, which runs the §6
// table through an independent oracle. This file proves the three things only a browser can:
//
//   1. R-I11 — user rotation composes on the EXIF-corrected image, through the real `decodeFrame`.
//   2. The pipeline and the thumbnail renderer (a canvas) agree on which way a quarter turn goes,
//      so the grid can never show an image turned the opposite way from the download.
//   3. D5 — how long the pixel-level transparency scan takes on a 48 MP frame, per engine.
//
// Same constraints as decode.spec.ts: tests/e2e has no DOM lib and no path alias, so modules are
// imported inside `page.evaluate` by served path (WebKit refuses imports from `addInitScript` scope).
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const EDIT_MODULE_PATH = '/src/pipeline/stages/edit.ts'
const RENDER_MODULE_PATH = '/src/platform/thumbnail-render.ts'

// The canonical decode fixture: a 3x2 grid of 20px cells, 60x40, top-left first. Mirrored from
// decode.spec.ts and scripts/build-test-fixtures.mjs.
const CELL_COLOURS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
] as const

/** JPEG slack at cell centres; any two fixture colours differ by 170 or more in some channel. */
const CHANNEL_TOLERANCE = 30

declare const OffscreenCanvas: new (
  width: number,
  height: number,
) => {
  getContext(kind: '2d'): {
    fillStyle: string
    fillRect(x: number, y: number, w: number, h: number): void
    drawImage(image: unknown, x: number, y: number): void
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
  }
  convertToBlob(options: { type: string }): Promise<unknown>
}
declare function createImageBitmap(source: unknown): Promise<{ width: number; height: number }>

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

function expectNear(actual: readonly number[], expected: readonly number[], label: string): void {
  expected.forEach((channel, band) => {
    expect(
      Math.abs(actual[band]! - channel),
      `${label} band ${band}: got ${actual[band]}, expected ~${channel}`,
    ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

// ---------------------------------------------------------------------------------------------
// R-I11 — rotation and crop compose on top of the EXIF-corrected image
// ---------------------------------------------------------------------------------------------

test('a user rotation and spill crop compose on an EXIF orientation 6 source', async ({ page }) => {
  const result = await page.evaluate(
    async ({ decodePath, editPath, bytes }) => {
      const decode = await import(/* @vite-ignore */ decodePath)
      const edit = await import(/* @vite-ignore */ editPath)
      const frame = await decode.decodeFrame(new Uint8Array(bytes))
      const decoded = { width: frame.width, height: frame.height }

      // Turn the upright 60x40 grid clockwise (40x60), then keep its top third with a 20px
      // transparent spill on the left: 60x20.
      const ops = [
        { kind: 'rotate', quarterTurns: 1 },
        {
          kind: 'crop',
          rect: { x: -0.5, y: 0, width: 1.5, height: 1 / 3 },
          zoom: 1,
          background: { r: 0, g: 0, b: 0, a: 0 },
        },
      ]
      const { frame: out, caveats } = edit.applyEdit(
        frame,
        { ops, version: 1 },
        { kind: 'preserve' },
      )
      const sample = (x: number, y: number) => {
        const i = (y * out.width + x) * 4
        return Array.from(out.pixels.subarray(i, i + 4)) as number[]
      }

      return {
        decoded,
        width: out.width,
        height: out.height,
        spill: sample(10, 10),
        middle: sample(30, 10),
        right: sample(50, 10),
        caveats,
      }
    },
    {
      decodePath: DECODE_MODULE_PATH,
      editPath: EDIT_MODULE_PATH,
      bytes: fixture('orientation-6.jpg'),
    },
  )

  // Decode made it upright first (R-I9); the edit then saw the corrected 60x40 image, not the
  // stored 40x60 pixels.
  expect(result.decoded).toEqual({ width: 60, height: 40 })
  expect([result.width, result.height]).toEqual([60, 20])
  expect(result.spill).toEqual([0, 0, 0, 0])
  // A clockwise turn brings the upright bottom-left cell (3) to the top-left and the top-left cell
  // (0) beside it.
  expectNear(result.middle, [...CELL_COLOURS[3], 255], 'rotated top-left')
  expectNear(result.right, [...CELL_COLOURS[0], 255], 'rotated top-right')
  expect(result.caveats).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// The pipeline and the thumbnail renderer agree on rotation
// ---------------------------------------------------------------------------------------------

for (const quarterTurns of [0, 1, 2, 3] as const) {
  test(`the edit stage and the thumbnail renderer agree on ${quarterTurns} quarter turns`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ editPath, renderPath, quarterTurns }) => {
        const edit = await import(/* @vite-ignore */ editPath)
        const render = await import(/* @vite-ignore */ renderPath)

        // 48x32, non-square so a swapped axis cannot pass, with four distinct quadrants.
        const width = 48
        const height = 32
        const quadrants = [
          [230, 25, 25],
          [25, 200, 25],
          [25, 60, 230],
          [235, 215, 30],
        ]
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d')
        const pixels = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const q = quadrants[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!
            pixels.set([q[0]!, q[1]!, q[2]!, 255], (y * width + x) * 4)
          }
        }
        quadrants.forEach((q, index) => {
          context.fillStyle = `rgb(${q[0]}, ${q[1]}, ${q[2]})`
          context.fillRect(
            (index % 2) * (width / 2),
            Math.floor(index / 2) * (height / 2),
            width / 2,
            height / 2,
          )
        })
        const blob = await canvas.convertToBlob({ type: 'image/png' })

        const ops = [{ kind: 'rotate', quarterTurns }]
        const staged = edit.applyEdit(
          {
            width,
            height,
            pixels,
            colour: { kind: 'untagged' },
            sourceOrientation: { kind: 'absent' },
          },
          { ops, version: 1 },
          { kind: 'preserve' },
        ).frame

        const thumbnail = await render.render({
          token: 1,
          id: 'agreement',
          blob,
          source: { width, height },
          ops,
          maxEdge: 64,
          format: 'image/webp',
          quality: 1,
          allowFallback: false,
        })
        const bitmap = await createImageBitmap(thumbnail.blob)
        const readback = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
        readback.drawImage(bitmap, 0, 0)
        const data = readback.getImageData(0, 0, bitmap.width, bitmap.height).data

        const centres = (w: number, h: number, read: (x: number, y: number) => number[]) =>
          [
            [w / 4, h / 4],
            [(3 * w) / 4, h / 4],
            [w / 4, (3 * h) / 4],
            [(3 * w) / 4, (3 * h) / 4],
          ].map(([x, y]) => read(Math.floor(x!), Math.floor(y!)))

        return {
          stagedSize: [staged.width, staged.height],
          thumbnailSize: [thumbnail.width, thumbnail.height],
          staged: centres(staged.width, staged.height, (x, y) => {
            const i = (y * staged.width + x) * 4
            return Array.from(staged.pixels.subarray(i, i + 3)) as number[]
          }),
          thumbnail: centres(bitmap.width, bitmap.height, (x, y) => {
            const i = (y * bitmap.width + x) * 4
            return [data[i]!, data[i + 1]!, data[i + 2]!]
          }),
        }
      },
      { editPath: EDIT_MODULE_PATH, renderPath: RENDER_MODULE_PATH, quarterTurns },
    )

    expect(result.thumbnailSize).toEqual(result.stagedSize)
    result.staged.forEach((colour, index) => {
      expectNear(result.thumbnail[index]!, colour, `quadrant ${index}`)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// D5 — the cost of the pixel-level transparency test
// ---------------------------------------------------------------------------------------------

test('D5: flattening a 48 MP frame scans and blends in bounded time', async ({
  page,
}, testInfo) => {
  const timings = await page.evaluate(
    async ({ editPath }) => {
      const edit = await import(/* @vite-ignore */ editPath)
      const width = 8000
      const height = 6000
      const flatten = { kind: 'flatten', background: { r: 255, g: 255, b: 255, a: 1 } }
      const frameWith = (alpha: number) => {
        const pixels = new Uint8Array(width * height * 4).fill(128)
        for (let i = 3; i < pixels.length; i += 4) pixels[i] = alpha
        return {
          width,
          height,
          pixels,
          colour: { kind: 'untagged' },
          sourceOrientation: { kind: 'absent' },
        }
      }
      const time = (alpha: number) => {
        const frame = frameWith(alpha)
        const start = performance.now()
        const { caveats } = edit.applyEdit(frame, null, flatten)
        return { ms: performance.now() - start, caveats: caveats.length }
      }

      // Warm the JIT on a small frame so the first measurement is not a compile.
      edit.applyEdit(
        {
          width: 64,
          height: 64,
          pixels: new Uint8Array(64 * 64 * 4),
          colour: { kind: 'untagged' },
          sourceOrientation: { kind: 'absent' },
        },
        null,
        flatten,
      )

      return { opaqueScan: time(255), fullBlend: time(128) }
    },
    { editPath: EDIT_MODULE_PATH },
  )

  testInfo.annotations.push({
    type: 'D5',
    description: `${testInfo.project.name}: opaque scan ${timings.opaqueScan.ms.toFixed(0)} ms, full blend ${timings.fullBlend.ms.toFixed(0)} ms (48 MP)`,
  })
  console.log(
    `D5 ${testInfo.project.name}: opaque scan ${timings.opaqueScan.ms.toFixed(0)} ms, full blend ${timings.fullBlend.ms.toFixed(0)} ms`,
  )

  expect(timings.opaqueScan.caveats).toBe(0)
  expect(timings.fullBlend.caveats).toBe(1)
  // A bound wide enough for a slow CI runner, tight enough to catch an accidental per-pixel
  // allocation, which costs tens of seconds at this size.
  expect(timings.opaqueScan.ms).toBeLessThan(5_000)
  expect(timings.fullBlend.ms).toBeLessThan(10_000)
})
