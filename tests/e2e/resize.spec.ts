import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// T25 — pipeline/stages/resize.ts (Functional Design §4.2, R-N1, R-N2, R-D1, R-D4; Technical Design
// §4.2).
//
// The size arithmetic is unit-tested in src/domain/dimension.spec.ts. This file proves the stage that
// resamples through ImageMagick, which only a browser can load: downscale, upscale, the no-op, and a
// cropped image ignoring the dimension rule, on all three engines.
//
// Same constraints as edit.spec.ts: tests/e2e has no DOM lib and no path alias, so modules are
// imported inside `page.evaluate` by served path (WebKit refuses imports from `addInitScript` scope).
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const EDIT_MODULE_PATH = '/src/pipeline/stages/edit.ts'
const RESIZE_MODULE_PATH = '/src/pipeline/stages/resize.ts'
const DIMENSION_MODULE_PATH = '/src/domain/dimension.ts'
const JOB_MODULE_PATH = '/src/domain/job.ts'

/** Top-left, top-right, bottom-left, bottom-right. Any two differ by 170 or more in some channel. */
const QUADRANTS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
] as const

// The canonical decode fixture: a 3x2 grid of 20px cells, 60x40, top-left first. Mirrored from
// decode.spec.ts and scripts/build-test-fixtures.mjs.
const CELL_COLORS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
] as const

/** Resampling slack at quadrant centers, far from any seam. */
const CHANNEL_TOLERANCE = 30

type Dimension =
  { kind: 'original' } | { kind: 'fit-long-edge' | 'fixed-width' | 'fixed-height'; pixels: number }

interface ResizeCase {
  width: number
  height: number
  dimension: Dimension
  quarterTurns?: 0 | 1 | 2 | 3
  /** Make the right half fully transparent. */
  transparentRight?: boolean
}

interface ResizeOutcome {
  width: number
  height: number
  predicted: { width: number; height: number }
  sameFrame: boolean
  inputUntouched: boolean
  owned: boolean
  colour: unknown
  sourceOrientation: unknown
  /** RGBA at the four quadrant centers of the output. */
  quadrants: number[][]
}

function expectNear(actual: readonly number[], expected: readonly number[], label: string): void {
  expected.forEach((channel, band) => {
    expect(
      Math.abs(actual[band]! - channel),
      `${label} band ${band}: got ${actual[band]}, expected ~${channel}`,
    ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
  })
}

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

/**
 * Builds a four-quadrant frame of the given size, optionally rotates it through the edit stage, and
 * resizes it. A quadrant image catches an axis swap, a flip or an offset that a size check cannot.
 */
function runResize(page: Page, spec: ResizeCase): Promise<ResizeOutcome> {
  return page.evaluate(
    async ({ editPath, resizePath, dimensionPath, spec, quadrants }) => {
      const edit = await import(/* @vite-ignore */ editPath)
      const resize = await import(/* @vite-ignore */ resizePath)
      const dimension = await import(/* @vite-ignore */ dimensionPath)

      const { width, height } = spec
      const pixels = new Uint8Array(width * height * 4)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const right = x >= width / 2
          const q = quadrants[(y < height / 2 ? 0 : 2) + (right ? 1 : 0)]!
          const alpha = spec.transparentRight && right ? 0 : 255
          pixels.set([q[0]!, q[1]!, q[2]!, alpha], (y * width + x) * 4)
        }
      }
      const colour = {
        kind: 'cicp',
        cicp: { primaries: 12, transfer: 13, matrix: 0, fullRange: true },
      }
      const sourceOrientation = { kind: 'present', value: 6 }
      const source = { width, height, pixels, colour, sourceOrientation }

      const edited = spec.quarterTurns
        ? edit.applyEdit(
            source,
            { ops: [{ kind: 'rotate', quarterTurns: spec.quarterTurns }], version: 1 },
            { kind: 'preserve' },
          ).frame
        : source
      const editedSize = { width: edited.width, height: edited.height }
      const before = edited.pixels.slice()

      const out = await resize.applyResize(edited, spec.dimension)

      const sample = (x: number, y: number) => {
        const i = (Math.floor(y) * out.width + Math.floor(x)) * 4
        return Array.from(out.pixels.subarray(i, i + 4)) as number[]
      }

      return {
        width: out.width,
        height: out.height,
        predicted: dimension.resolveResizedSize(editedSize, spec.dimension),
        sameFrame: out === edited,
        inputUntouched: before.every(
          (value: number, index: number) => value === edited.pixels[index],
        ),
        owned:
          out.pixels.byteOffset === 0 && out.pixels.byteLength === out.pixels.buffer.byteLength,
        colour: out.colour,
        sourceOrientation: out.sourceOrientation,
        quadrants: [
          sample(out.width / 4, out.height / 4),
          sample((3 * out.width) / 4, out.height / 4),
          sample(out.width / 4, (3 * out.height) / 4),
          sample((3 * out.width) / 4, (3 * out.height) / 4),
        ],
      }
    },
    {
      editPath: EDIT_MODULE_PATH,
      resizePath: RESIZE_MODULE_PATH,
      dimensionPath: DIMENSION_MODULE_PATH,
      spec,
      quadrants: QUADRANTS.map((q) => [...q]),
    },
  )
}

function expectQuadrantsKept(outcome: ResizeOutcome): void {
  outcome.quadrants.forEach((sample, index) => {
    expectNear(sample, [...QUADRANTS[index]!, 255], `quadrant ${index}`)
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

// ---------------------------------------------------------------------------------------------
// Downscale
// ---------------------------------------------------------------------------------------------

test('fit within long edge downscales to the predicted size and keeps the content', async ({
  page,
}) => {
  const outcome = await runResize(page, {
    width: 400,
    height: 300,
    dimension: { kind: 'fit-long-edge', pixels: 200 },
  })

  expect([outcome.width, outcome.height]).toEqual([200, 150])
  expect(outcome.predicted).toEqual({ width: 200, height: 150 })
  expect(outcome.sameFrame).toBe(false)
  expect(outcome.owned).toBe(true)
  expectQuadrantsKept(outcome)
})

test('fixed width downscales and derives the height (R-N1)', async ({ page }) => {
  const outcome = await runResize(page, {
    width: 333,
    height: 217,
    dimension: { kind: 'fixed-width', pixels: 100 },
  })

  expect({ width: outcome.width, height: outcome.height }).toEqual(outcome.predicted)
  expect([outcome.width, outcome.height]).toEqual([100, 65])
  expectQuadrantsKept(outcome)
})

// ---------------------------------------------------------------------------------------------
// Upscale
// ---------------------------------------------------------------------------------------------

test('fixed width upscales a smaller image (R-N2)', async ({ page }) => {
  const outcome = await runResize(page, {
    width: 400,
    height: 300,
    dimension: { kind: 'fixed-width', pixels: 800 },
  })

  expect([outcome.width, outcome.height]).toEqual([800, 600])
  expect(outcome.predicted).toEqual({ width: 800, height: 600 })
  expect(outcome.owned).toBe(true)
  expectQuadrantsKept(outcome)
})

test('fixed height upscales a smaller image (R-N2)', async ({ page }) => {
  const outcome = await runResize(page, {
    width: 120,
    height: 90,
    dimension: { kind: 'fixed-height', pixels: 250 },
  })

  expect([outcome.width, outcome.height]).toEqual([333, 250])
  expect({ width: outcome.width, height: outcome.height }).toEqual(outcome.predicted)
  expectQuadrantsKept(outcome)
})

// ---------------------------------------------------------------------------------------------
// No-op
// ---------------------------------------------------------------------------------------------

for (const [label, dimension] of [
  ['an image already inside a fit-within limit', { kind: 'fit-long-edge', pixels: 1920 }],
  ['a long edge exactly at the limit', { kind: 'fit-long-edge', pixels: 400 }],
  ['a fixed width the image already has', { kind: 'fixed-width', pixels: 400 }],
  ['the original size', { kind: 'original' }],
] as const) {
  test(`${label} is returned untouched`, async ({ page }) => {
    const outcome = await runResize(page, { width: 400, height: 300, dimension })

    expect([outcome.width, outcome.height]).toEqual([400, 300])
    expect(outcome.sameFrame).toBe(true)
    expect(outcome.inputUntouched).toBe(true)
  })
}

// ---------------------------------------------------------------------------------------------
// Edits and the dimension rule
// ---------------------------------------------------------------------------------------------

test('a cropped image takes its size from the crop and ignores the dimension rule (R-D1)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ decodePath, editPath, resizePath, jobPath, bytes }) => {
      const decode = await import(/* @vite-ignore */ decodePath)
      const edit = await import(/* @vite-ignore */ editPath)
      const resize = await import(/* @vite-ignore */ resizePath)
      const job = await import(/* @vite-ignore */ jobPath)

      // The right two columns of the 60x40 grid: a 40x40 crop.
      const cropped = {
        ops: [
          {
            kind: 'crop',
            rect: { x: 1 / 3, y: 0, width: 2 / 3, height: 1 },
            zoom: 1,
            background: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        version: 1,
      }
      const batch = {
        quality: { kind: 'quality', value: 70 },
        dimension: { kind: 'fit-long-edge', pixels: 20 },
        format: 'png',
      }

      const run = async (record: typeof cropped | null) => {
        const resolution = job.resolveSettings(
          { sourceFormat: 'jpeg', isAnimated: false, edit: record },
          batch,
        )
        const frame = await decode.decodeFrame(new Uint8Array(bytes))
        const edited = edit.applyEdit(frame, record, resolution.settings.alpha).frame
        const out = await resize.applyResize(edited, resolution.settings.dimension)
        const sample = (x: number, y: number) => {
          const i = (y * out.width + x) * 4
          return Array.from(out.pixels.subarray(i, i + 4)) as number[]
        }

        return {
          dimension: resolution.settings.dimension,
          width: out.width,
          height: out.height,
          sameFrame: out === edited,
          topLeft: sample(10, 10),
          bottomRight: sample(30, 30),
        }
      }

      return { cropped: await run(cropped), uncropped: await run(null) }
    },
    {
      decodePath: DECODE_MODULE_PATH,
      editPath: EDIT_MODULE_PATH,
      resizePath: RESIZE_MODULE_PATH,
      jobPath: JOB_MODULE_PATH,
      bytes: fixture('orientation-1.jpg'),
    },
  )

  // The same batch rule shrinks the uncropped image, so the crop is what stopped it.
  expect(result.uncropped.dimension).toEqual({ kind: 'fit-long-edge', pixels: 20 })
  expect([result.uncropped.width, result.uncropped.height]).toEqual([20, 13])

  expect(result.cropped.dimension).toEqual({ kind: 'original' })
  expect([result.cropped.width, result.cropped.height]).toEqual([40, 40])
  expect(result.cropped.sameFrame).toBe(true)
  expectNear(result.cropped.topLeft, [...CELL_COLORS[1], 255], 'cropped top-left')
  expectNear(result.cropped.bottomRight, [...CELL_COLORS[5], 255], 'cropped bottom-right')
})

test('a rotated but uncropped image follows the rule on its rotated size (R-D4)', async ({
  page,
}) => {
  const outcome = await runResize(page, {
    width: 400,
    height: 300,
    quarterTurns: 1,
    dimension: { kind: 'fit-long-edge', pixels: 200 },
  })

  expect([outcome.width, outcome.height]).toEqual([150, 200])
  expect(outcome.predicted).toEqual({ width: 150, height: 200 })
  // A clockwise turn brings bottom-left to top-left, top-left to top-right, and so on.
  const [topLeft, topRight, bottomLeft, bottomRight] = QUADRANTS
  const rotated = [bottomLeft, topLeft, bottomRight, topRight]
  outcome.quadrants.forEach((sample, index) => {
    expectNear(sample, [...rotated[index]!, 255], `rotated quadrant ${index}`)
  })
})

// ---------------------------------------------------------------------------------------------
// Frame contract
// ---------------------------------------------------------------------------------------------

test('transparency, color and orientation survive a resize', async ({ page }) => {
  for (const dimension of [
    { kind: 'fit-long-edge', pixels: 100 },
    { kind: 'fixed-width', pixels: 800 },
  ] as const) {
    const outcome = await runResize(page, {
      width: 400,
      height: 300,
      dimension,
      transparentRight: true,
    })

    expect(outcome.quadrants[0]![3]).toBe(255)
    expect(outcome.quadrants[2]![3]).toBe(255)
    expect(outcome.quadrants[1]![3]).toBe(0)
    expect(outcome.quadrants[3]![3]).toBe(0)
    expectNear(outcome.quadrants[0]!, [...QUADRANTS[0], 255], `${dimension.kind} opaque left`)
    expect(outcome.colour).toEqual({
      kind: 'cicp',
      cicp: { primaries: 12, transfer: 13, matrix: 0, fullRange: true },
    })
    expect(outcome.sourceOrientation).toEqual({ kind: 'present', value: 6 })
    expect(outcome.owned).toBe(true)
  }
})

// ---------------------------------------------------------------------------------------------
// Resampling quality: the pinned filter, and no color bleed from transparent pixels
// ---------------------------------------------------------------------------------------------

const LOADER_MODULE_PATH = '/src/pipeline/codecs/loader.ts'

test('the stage resamples with Lanczos to shrink and Mitchell to enlarge', async ({ page }) => {
  const result = await page.evaluate(
    async ({ resizePath, loaderPath }) => {
      const resize = await import(/* @vite-ignore */ resizePath)
      const loader = await import(/* @vite-ignore */ loaderPath)
      const { ImageMagick, MagickFormat, MagickGeometry, MagickReadSettings, FilterType } =
        await loader.ensureImageMagick()

      // Two-pixel vertical stripes with alpha present: high-frequency content on which every
      // filter gives a different answer, and an alpha channel, which is what makes ImageMagick's
      // automatic choice fall back to Mitchell.
      const stripes = (width: number, height: number) => {
        const pixels = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const v = Math.floor(x / 2) % 2 === 0 ? 20 : 235
            pixels.set([v, 255 - v, v, 255], (y * width + x) * 4)
          }
        }
        return pixels
      }
      const direct = (
        pixels: Uint8Array,
        width: number,
        height: number,
        target: number[],
        filter?: number,
      ) =>
        ImageMagick.read(
          pixels,
          new MagickReadSettings({ format: MagickFormat.Rgba, width, height, depth: 8 }),
          (image: MagickImageLike): Uint8Array => {
            const geometry = new MagickGeometry(target[0]!, target[1]!)
            geometry.ignoreAspectRatio = true
            if (filter === undefined) image.resize(geometry)
            else image.resize(geometry, filter)
            return image.getPixels((c) => c.toByteArray(0, 0, target[0]!, target[1]!, 'RGBA'))!
          },
        )
      // The loader is imported by served path, so its types are not visible here.
      interface MagickImageLike {
        resize(geometry: unknown, filter?: number): void
        getPixels(
          read: (collection: {
            toByteArray(x: number, y: number, w: number, h: number, map: string): Uint8Array | null
          }) => Uint8Array | null,
        ): Uint8Array | null
      }
      const equal = (a: Uint8Array, b: Uint8Array) =>
        a.length === b.length && a.every((value, index) => value === b[index])
      const compare = async (width: number, height: number, dimension: unknown) => {
        const source = stripes(width, height)
        const frame = {
          width,
          height,
          pixels: source.slice(),
          colour: { kind: 'untagged' },
          sourceOrientation: { kind: 'absent' },
        }
        const out = await resize.applyResize(frame, dimension)
        const target = [out.width, out.height]
        return {
          size: target,
          lanczos: equal(out.pixels, direct(source, width, height, target, FilterType.Lanczos)),
          mitchell: equal(out.pixels, direct(source, width, height, target, FilterType.Mitchell)),
          automatic: equal(out.pixels, direct(source, width, height, target)),
        }
      }

      return {
        shrink: await compare(101, 61, { kind: 'fit-long-edge', pixels: 50 }),
        enlarge: await compare(50, 30, { kind: 'fixed-width', pixels: 150 }),
      }
    },
    { resizePath: RESIZE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  expect(result.shrink.size).toEqual([50, 30])
  expect(result.shrink).toMatchObject({ lanczos: true, mitchell: false })
  // The reason the filter is pinned: left to itself, ImageMagick would not have used Lanczos here.
  expect(result.shrink.automatic).toBe(false)
  expect(result.enlarge.size).toEqual([150, 90])
  expect(result.enlarge).toMatchObject({ lanczos: false, mitchell: true })
})

for (const dimension of [
  { kind: 'fit-long-edge', pixels: 37 },
  { kind: 'fixed-width', pixels: 250 },
] as const) {
  test(`a ${dimension.kind} resize does not bleed the color of fully transparent pixels`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ resizePath, dimension }) => {
        const resize = await import(/* @vite-ignore */ resizePath)

        // Opaque red on the left; on the right, pixels that are fully transparent but whose stored
        // RGB is pure green. Any green that reaches a visible output pixel leaked through the alpha.
        const width = 101
        const height = 40
        const pixels = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            pixels.set(x < 50 ? [255, 0, 0, 255] : [0, 255, 0, 0], (y * width + x) * 4)
          }
        }

        const out = await resize.applyResize(
          {
            width,
            height,
            pixels,
            colour: { kind: 'untagged' },
            sourceOrientation: { kind: 'absent' },
          },
          dimension,
        )

        let maxGreen = 0
        let partial = 0
        const row = Math.floor(out.height / 2)
        for (let x = 0; x < out.width; x += 1) {
          const i = (row * out.width + x) * 4
          const alpha = out.pixels[i + 3]!
          if (alpha >= 16) maxGreen = Math.max(maxGreen, out.pixels[i + 1]!)
          if (alpha >= 16 && alpha <= 239) partial += 1
        }

        return { maxGreen, partial }
      },
      { resizePath: RESIZE_MODULE_PATH, dimension },
    )

    // The seam produces clearly translucent pixels. Averaged without alpha weighting, such a pixel
    // would take roughly (1 - alpha) of the hidden green, far above the bound, so the check is not
    // vacuous.
    expect(result.partial).toBeGreaterThan(0)
    expect(result.maxGreen).toBeLessThanOrEqual(8)
  })
}
