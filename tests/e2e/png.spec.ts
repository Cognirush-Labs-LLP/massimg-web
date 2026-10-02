import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// T27 — pipeline/stages/png.ts (Functional Design R-Q11, R-Q12, R-Q13, R-Q14, R-I12, R-I14, R-I17;
// Technical Design §4.2's PNG-still row, §7.3, §7.6).
//
// The decisions — branches, the rounding, the quantizer settings, the chunk surgery, the caveat —
// are unit-tested in src/pipeline/stages/png-plan.spec.ts. This file proves that ImageMagick,
// libimagequant and oxipng carry them out, on all three engines.
//
// T26's hardest-won lesson is applied throughout: an ImageMagick round trip proves only that the
// bytes are self-consistent. Every pixel claim below is also checked against the engine's own PNG
// decoder, which is what Preview (R-I16) and the downloaded file actually use.
//
// Same constraints as encode.spec.ts: no DOM lib and no path alias in tests/e2e, so modules are
// imported inside `page.evaluate` by served path, and the frame builders below are pure and import
// nothing, which is why WebKit accepts them from `addInitScript` scope.
const PNG_MODULE_PATH = '/src/pipeline/stages/png.ts'
const PNG_PLAN_MODULE_PATH = '/src/pipeline/stages/png-plan.ts'
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const LOADER_MODULE_PATH = '/src/pipeline/codecs/loader.ts'
const POOL_MODULE_PATH = '/src/pipeline/pool.ts'
const JOB_MODULE_PATH = '/src/domain/job.ts'

/** Every slider value the tests below use. `beforeEach` maps each one through the real `domain/job.ts`. */
const SLIDERS = [10, 12, 20, 40, 70, 84, 85, 86, 100]

type Content =
  'flat' | 'photo' | 'translucent' | 'gradient' | 'ramp' | 'twoColour' | 'shaded' | 'hiddenColour'

interface RgbaFrame {
  width: number
  height: number
  pixels: Uint8Array
  colour: unknown
  sourceOrientation: unknown
}

// Declared for the page callbacks; defined by the init script below.
declare function makeFrame(content: Content, width: number, height: number): RgbaFrame
declare function quality(slider: number): { kind: 'quality'; value: number; lossless: boolean }
declare function drawPng(bytes: Uint8Array): Promise<{
  width: number
  height: number
  data: number[]
}>

/** The slice of magick-wasm's `IMagickImage` these callbacks touch. */
interface MagickImageLike {
  width: number
  height: number
  orientation: number
  readonly profileNames: readonly string[]
  getProfile(name: string): { data: Uint8Array } | null
  getPixels<T>(callback: (collection: { toByteArray(...args: unknown[]): T }) => T): T
}

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

const ICC_PROFILE = fixture('icc-profile.bin')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>

    const random = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 4294967296
    }

    scope.makeFrame = (content: string, width: number, height: number) => {
      const pixels = new Uint8Array(width * height * 4)
      const next = random(2027)
      const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4
          let rgba: number[]

          if (content === 'flat') {
            // Six flat blocks and a border: a logo or a diagram, well under 256 colours.
            const block = Math.floor((x * 3) / width) + 3 * Math.floor((y * 2) / height)
            const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8
            rgba = border
              ? [20, 20, 20, 255]
              : [30 + block * 30, 200 - block * 20, (block * 57) & 255, 255]
          } else if (content === 'twoColour') {
            // Two colours, one of them fully transparent: quantization can only reproduce it exactly.
            const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (height / 3) ** 2
            rgba = inside ? [232, 76, 61, 255] : [0, 0, 0, 0]
          } else if (content === 'hiddenColour') {
            // A shape on a field that is fully transparent but *not* uniform underneath. This is
            // what `optimiseAlpha` rewrites, so it is the only frame that can show that the lossless
            // branch leaves it alone. The noise is a deterministic function of the position rather
            // than of the generator's sequence, so every pixel's hidden colour is knowable.
            const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (height / 3) ** 2
            rgba = inside
              ? [232, 76, 61, 255]
              : [(x * 37 + y * 11) & 255, (x * 5 + y * 73) & 255, (x * 131 + y * 29) & 255, 0]
          } else if (content === 'gradient') {
            // Smooth in both axes: many colours, and the case banding would show on.
            const t = y / (height - 1)
            const u = x / (width - 1)
            rgba = [clamp(30 + t * 205 + u * 12), clamp(85 + t * 140), clamp(205 - t * 55), 255]
          } else if (content === 'shaded') {
            // A shaded illustration: thousands of colours from smooth shading over hard shape
            // edges. A palette holds it in about two hundred entries, so quantization halves it.
            const u = x / width
            const v = y / height
            const shade = 0.55 + 0.45 * Math.sin(u * 3.1) * Math.cos(v * 2.3)
            const base = v > 0.55 + 0.1 * Math.sin(u * 7) ? [76, 122, 84] : [140, 196, 230]
            rgba = [clamp(base[0]! * shade), clamp(base[1]! * shade), clamp(base[2]! * shade), 255]
          } else if (content === 'ramp') {
            // Every row identical and more than 256 distinct colours across a row. A lossless PNG
            // predicts each row from the one above and costs almost nothing; a quantizer must drop
            // to 256 and dither, and the dither pattern is what breaks that prediction.
            rgba = [
              clamp((x * 255) / (width - 1)),
              clamp(255 - (x * 255) / (width - 1)),
              (x * 3) & 255,
              255,
            ]
          } else if (content === 'translucent') {
            const noise = () => (next() - 0.5) * 24
            rgba = [
              clamp((x * 255) / width + noise()),
              clamp((y * 255) / height + noise()),
              clamp(((x + y) * 255) / (width + height) + noise()),
              Math.floor((x * 255) / (width - 1)),
            ]
          } else {
            // A photographic stand-in: sensor-like noise over a gradient. No 256-colour palette
            // reaches quality 70 on this, which is what makes it the abort case.
            const noise = () => (next() - 0.5) * 40
            rgba = [
              clamp((x * 255) / width + noise()),
              clamp((y * 255) / height + noise()),
              clamp(((x + y) * 255) / (width + height) + noise()),
              255,
            ]
          }

          pixels.set(rgba, i)
        }
      }

      return {
        width,
        height,
        pixels,
        colour: { kind: 'untagged' },
        sourceOrientation: { kind: 'absent' },
      }
    }

    // R-Q11's mapping is not computed here, and not restated either: `beforeEach` runs the real
    // `domain/job.ts` in the page and leaves the answers on `__t27Quality`. Restating
    // `70 + (q - 10) * 30 / 90` would make every claim below conditional on the restatement, which
    // is exactly the end-to-end property these tests exist to prove. It cannot be imported from
    // here — `addInitScript` scope cannot dynamic-import on WebKit (T23) — hence the two steps.
    scope.quality = (slider: number) => {
      const resolved = (scope.__t27Quality as Record<number, unknown> | undefined)?.[slider]
      if (resolved === undefined) throw new Error(`slider ${slider} was not resolved`)
      return resolved
    }

    // The engine's own PNG decoder, which is what the downloaded file and Preview use.
    scope.drawPng = async (bytes: Uint8Array) => {
      const view = globalThis as unknown as {
        Blob: new (parts: [Uint8Array], options: { type: string }) => object
        URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void }
        Image: new () => { src: string; decode(): Promise<void> }
        document: {
          createElement(tag: 'canvas'): {
            width: number
            height: number
            getContext(
              type: '2d',
              options?: { willReadFrequently: boolean },
            ): {
              clearRect(x: number, y: number, w: number, h: number): void
              drawImage(image: unknown, x: number, y: number): void
              getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
            } | null
          }
        }
      }

      const url = view.URL.createObjectURL(new view.Blob([bytes], { type: 'image/png' }))
      try {
        const image = new view.Image()
        image.src = url
        await image.decode()

        const canvas = view.document.createElement('canvas')
        const width = (image as unknown as { naturalWidth: number }).naturalWidth
        const height = (image as unknown as { naturalHeight: number }).naturalHeight
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) throw new Error('no 2d context')
        context.clearRect(0, 0, width, height)
        context.drawImage(image, 0, 0)

        return { width, height, data: Array.from(context.getImageData(0, 0, width, height).data) }
      } finally {
        view.URL.revokeObjectURL(url)
      }
    }
  })

  await page.goto('/')

  // The mapping, from the module that owns it, in the page that is about to be measured.
  await page.evaluate(
    async ({ jobPath, sliders }) => {
      const { resolveSettings } = await import(/* @vite-ignore */ jobPath)
      const scope = globalThis as unknown as Record<string, unknown>
      const mapped: Record<number, unknown> = {}

      for (const slider of sliders) {
        const resolution = resolveSettings(
          { sourceFormat: 'png', isAnimated: false, edit: null },
          {
            quality: { kind: 'quality', value: slider },
            dimension: { kind: 'original' },
            format: 'png',
          },
        )
        if (resolution.kind !== 'resolved' || resolution.settings.quality.kind !== 'quality') {
          throw new Error(`slider ${slider} did not resolve to a PNG quality`)
        }
        mapped[slider] = resolution.settings.quality
      }

      scope.__t27Quality = mapped
    },
    { jobPath: JOB_MODULE_PATH, sliders: SLIDERS },
  )
})

test('the lossless branch is exact in the engine that will display it (R-Q12)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)

      const measure = async (content: Content, slider: number) => {
        const frame = makeFrame(content, 160, 120)
        const expected = frame.pixels.slice()
        const encoded = await encodePng(frame, quality(slider))
        const drawn = await drawPng(encoded.bytes)

        let rgb = 0
        let alpha = 0
        let opaqueRgb = 0
        let translucentRgb = 0
        for (let i = 0; i < expected.length; i += 4) {
          alpha = Math.max(alpha, Math.abs(expected[i + 3]! - drawn.data[i + 3]!))
          if (expected[i + 3] === 0) continue
          for (let band = 0; band < 3; band += 1) {
            const delta = Math.abs(expected[i + band]! - drawn.data[i + band]!)
            rgb = Math.max(rgb, delta)
            if (expected[i + 3] === 255) opaqueRgb = Math.max(opaqueRgb, delta)
            // A canvas stores colour premultiplied by alpha in eight bits, so reading a
            // partly transparent pixel back divides by a small number and rounds. The loss is the
            // canvas's, not the encoder's, and it grows without bound as alpha approaches zero;
            // a quarter alpha is where it is still small enough to be a useful assertion.
            if (expected[i + 3]! >= 64) translucentRgb = Math.max(translucentRgb, delta)
          }
        }

        return {
          branch: encoded.branch as string,
          branches: encoded.branches as string[],
          width: drawn.width,
          height: drawn.height,
          rgb,
          alpha,
          opaqueRgb,
          translucentRgb,
          header: plan.readPngHeader(encoded.bytes),
          owned:
            encoded.bytes.byteOffset === 0 &&
            encoded.bytes.byteLength === encoded.bytes.buffer.byteLength,
        }
      }

      return {
        // Slider 85 is R-Q12's point: one branch, and it is the lossless one.
        gradient85: await measure('gradient', 85),
        photo100: await measure('photo', 100),
        translucent85: await measure('translucent', 85),
        // Below the point the quantized branch runs too, and loses on this content.
        ramp10: await measure('ramp', 10),
      }
    },
    { pngPath: PNG_MODULE_PATH, planPath: PNG_PLAN_MODULE_PATH },
  )

  for (const key of ['gradient85', 'photo100', 'translucent85'] as const) {
    expect(result[key].branches, key).toEqual(['lossless'])
    expect(result[key].branch, key).toBe('lossless')
  }

  // Opaque content: the engine's own decoder returns the source pixels, byte for byte.
  for (const key of ['gradient85', 'photo100', 'ramp10'] as const) {
    expect(result[key], key).toMatchObject({
      rgb: 0,
      alpha: 0,
      width: 160,
      height: 120,
      owned: true,
    })
  }

  // A translucent frame: the alpha channel is exact, and so is the colour of every opaque pixel.
  // Partly transparent pixels go through the canvas's premultiplied store and come back rounded,
  // which is the canvas's arithmetic and not the encoder's — the next test reads the same file back
  // through ImageMagick and finds it exact at every alpha.
  expect(result.translucent85.alpha).toBe(0)
  expect(result.translucent85.opaqueRgb).toBe(0)
  expect(result.translucent85.translucentRgb).toBeLessThanOrEqual(4)

  // Interlacing is off, so the file is not Adam7 (§7.3's size-first reading).
  for (const key of Object.keys(result) as (keyof typeof result)[]) {
    expect(result[key].header.interlace, key).toBe(0)
    expect(result[key].header.bitDepth, key).toBeLessThanOrEqual(8)
  }
})

test('an opaque frame writes no alpha channel; a translucent one keeps its alpha exactly', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath, loaderPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()

      const measure = async (content: Content, slider: number) => {
        const frame = makeFrame(content, 160, 120)
        const expected = frame.pixels.slice()
        const encoded = await encodePng(frame, quality(slider))
        const decoded = ImageMagick.read(encoded.bytes, (image: MagickImageLike) =>
          image.getPixels((c) => c.toByteArray(0, 0, image.width, image.height, 'RGBA')),
        ) as Uint8Array

        let rgb = 0
        let alpha = 0
        // The colour *under* fully transparent pixels, which every other loop in this file skips
        // because it is invisible. `optimiseAlpha` is off precisely so that the lossless branch does
        // not touch it, and a claim nothing measures is a claim nothing holds to.
        let transparentRgb = 0
        let transparentPixels = 0
        for (let i = 0; i < expected.length; i += 4) {
          alpha = Math.max(alpha, Math.abs(expected[i + 3]! - decoded[i + 3]!))
          if (expected[i + 3] === 0) {
            transparentPixels += 1
            for (let band = 0; band < 3; band += 1) {
              transparentRgb = Math.max(
                transparentRgb,
                Math.abs(expected[i + band]! - decoded[i + band]!),
              )
            }
            continue
          }
          for (let band = 0; band < 3; band += 1) {
            rgb = Math.max(rgb, Math.abs(expected[i + band]! - decoded[i + band]!))
          }
        }

        return {
          branch: encoded.branch as string,
          hasAlpha: plan.hasAlphaChannel(encoded.bytes),
          colorType: plan.readPngHeader(encoded.bytes).colorType,
          chunks: plan.readPngChunks(encoded.bytes).map((chunk: { type: string }) => chunk.type),
          rgb,
          alpha,
          transparentRgb,
          transparentPixels,
        }
      }

      return {
        opaqueLossless: await measure('gradient', 85),
        opaqueQuantized: await measure('gradient', 10),
        opaquePhoto: await measure('photo', 100),
        translucentLossless: await measure('translucent', 85),
        translucentQuantized: await measure('twoColour', 10),
        hiddenLossless: await measure('hiddenColour', 85),
        hiddenQuantized: await measure('hiddenColour', 10),
      }
    },
    {
      pngPath: PNG_MODULE_PATH,
      planPath: PNG_PLAN_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
    },
  )

  // No alpha channel on either branch when every source pixel is opaque: a plane of 255s says
  // nothing and costs bytes.
  for (const key of ['opaqueLossless', 'opaqueQuantized', 'opaquePhoto'] as const) {
    expect(result[key].hasAlpha, key).toBe(false)
    expect([0, 2, 3], key).toContain(result[key].colorType)
    expect(result[key].chunks, key).not.toContain('tRNS')
  }

  // The lossless branch reproduces a translucent frame exactly, colour and alpha.
  expect(result.translucentLossless).toMatchObject({
    branch: 'lossless',
    hasAlpha: true,
    rgb: 0,
    alpha: 0,
  })

  // Two colours, one fully transparent: a quantizer cannot lose anything, so this is exact too.
  expect(result.translucentQuantized.hasAlpha).toBe(true)
  expect(result.translucentQuantized.alpha).toBe(0)
  expect(result.translucentQuantized.rgb).toBe(0)

  // **The lossless branch is lossless under its transparent pixels too**, which is the whole reason
  // `optimiseAlpha` is off (§7.3). Thousands of invisible pixels, each a different colour, all of
  // them unchanged.
  expect(result.hiddenLossless.transparentPixels).toBeGreaterThan(1000)
  expect(result.hiddenLossless.branch).toBe('lossless')
  expect(result.hiddenLossless.transparentRgb).toBe(0)
  expect(result.hiddenLossless.rgb).toBe(0)
  expect(result.hiddenLossless.alpha).toBe(0)

  // The quantized branch does not make that promise and does not keep it: libimagequant collapses
  // every fully transparent pixel onto one palette entry. Visible pixels and alpha still survive,
  // and an output that reached here is one R-Q14 chose on size alone.
  expect(result.hiddenQuantized.transparentPixels).toBeGreaterThan(1000)
  expect(result.hiddenQuantized.alpha).toBe(0)
})

test('R-Q14 keeps the smaller candidate in both directions, and a tie keeps lossless', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)

      const run = async (content: Content, slider: number, width: number, height: number) => {
        const encoded = await encodePng(makeFrame(content, width, height), quality(slider))
        return {
          branch: encoded.branch as string,
          branches: encoded.branches as string[],
          aborted: encoded.quantizeAborted as boolean,
          bytes: encoded.bytes.byteLength as number,
          sizes: encoded.sizes as { lossless: number; quantized: number | null },
          caveats: (encoded.caveats as { kind: string }[]).map((caveat) => caveat.kind),
          palette: encoded.paletteColors as number | null,
        }
      }

      return {
        quantizedWins: await run('shaded', 10, 400, 300),
        losslessWins: await run('ramp', 10, 400, 300),
        tie: await run('twoColour', 10, 400, 300),
        aborted: await run('photo', 10, 400, 300),
        losslessOnly: await run('gradient', 85, 400, 300),
      }
    },
    { pngPath: PNG_MODULE_PATH },
  )

  // Both candidates encoded below the lossless point, every time.
  for (const key of ['quantizedWins', 'losslessWins', 'tie'] as const) {
    expect(result[key].branches, key).toEqual(['lossless', 'quantized'])
    expect(result[key].sizes.quantized, key).not.toBeNull()
  }

  // Quantized smaller: it is kept, and it is what the bytes are.
  expect(result.quantizedWins.branch).toBe('quantized')
  expect(result.quantizedWins.sizes.quantized).toBeLessThan(result.quantizedWins.sizes.lossless)
  expect(result.quantizedWins.bytes).toBe(result.quantizedWins.sizes.quantized)
  expect(result.quantizedWins.caveats).toEqual(['png-quantized'])
  expect(result.quantizedWins.palette).not.toBeNull()

  // Lossless smaller: a row-constant ramp of more than 256 colours costs almost nothing losslessly
  // and a great deal once a quantizer has to dither it. R-Q14's own case.
  expect(result.losslessWins.branch).toBe('lossless')
  expect(result.losslessWins.sizes.lossless).toBeLessThan(
    result.losslessWins.sizes.quantized as number,
  )
  expect(result.losslessWins.bytes).toBe(result.losslessWins.sizes.lossless)
  expect(result.losslessWins.caveats).toEqual([])

  // A tie keeps lossless: the same size, with nothing given up and no caveat to explain.
  expect(result.tie.sizes.quantized).toBe(result.tie.sizes.lossless)
  expect(result.tie.branch).toBe('lossless')
  expect(result.tie.caveats).toEqual([])

  // R-Q11's floor: no 256-colour palette reaches quality 70 on a noisy photograph, so libimagequant
  // aborts and the lossless candidate stands. Not a failure — the requirement asks for exactly this.
  expect(result.aborted).toMatchObject({
    branch: 'lossless',
    branches: ['lossless'],
    aborted: true,
    caveats: [],
  })
  expect(result.aborted.sizes.quantized).toBeNull()

  // At and above R-Q12's point there is one candidate and no comparison.
  expect(result.losslessOnly).toMatchObject({
    branch: 'lossless',
    branches: ['lossless'],
    aborted: false,
  })
})

test('the quantized branch stays inside 256 colours, in the engine’s own decoder', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)

      const run = async (content: Content, slider: number) => {
        const frame = makeFrame(content, 400, 300)
        const sourceColours = new Set<number>()
        const sourceView = new Uint32Array(
          frame.pixels.buffer,
          frame.pixels.byteOffset,
          frame.pixels.byteLength / 4,
        )
        for (const value of sourceView) sourceColours.add(value)

        const encoded = await encodePng(frame, quality(slider))
        const drawn = await drawPng(encoded.bytes)
        const colours = new Set<number>()
        for (let i = 0; i < drawn.data.length; i += 4) {
          colours.add(
            ((drawn.data[i]! << 24) |
              (drawn.data[i + 1]! << 16) |
              (drawn.data[i + 2]! << 8) |
              drawn.data[i + 3]!) >>>
              0,
          )
        }

        return {
          branch: encoded.branch as string,
          palette: encoded.paletteColors as number | null,
          sourceColours: sourceColours.size,
          drawnColours: colours.size,
          header: plan.readPngHeader(encoded.bytes),
        }
      }

      return { shaded: await run('shaded', 10), flat: await run('flat', 10) }
    },
    { pngPath: PNG_MODULE_PATH, planPath: PNG_PLAN_MODULE_PATH },
  )

  expect(result.shaded.branch).toBe('quantized')
  expect(result.shaded.sourceColours).toBeGreaterThan(256)
  // Counted in the engine's own decoder, not in the palette the file declares.
  expect(result.shaded.drawnColours).toBeLessThanOrEqual(256)
  expect(result.shaded.palette).toBeLessThanOrEqual(256)

  expect(result.flat.sourceColours).toBeLessThanOrEqual(256)
  expect(result.flat.drawnColours).toBeLessThanOrEqual(256)
})

test('an ICC profile is written verbatim on both branches, with nothing to contradict it (R-I12)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath, decodePath, loaderPath, source }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const { decodeFrame } = await import(/* @vite-ignore */ decodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()

      const run = async (slider: number, force: 'none' | 'quantized') => {
        const frame = await decodeFrame(new Uint8Array(source))
        // The fixture is a photograph and would abort at the floor, so the quantized case is driven
        // by replacing its pixels with content a palette can hold while keeping its real profile.
        const subject =
          force === 'quantized'
            ? { ...makeFrame('shaded', frame.width, frame.height), colour: frame.colour }
            : frame
        const encoded = await encodePng(subject, quality(slider))
        const chunks = plan
          .readPngChunks(encoded.bytes)
          .map((chunk: { type: string }) => chunk.type)

        return {
          branch: encoded.branch as string,
          chunks,
          profile: ImageMagick.read(encoded.bytes, (image: MagickImageLike) => {
            const found = image.getProfile('icc')
            return found ? Array.from(found.data) : null
          }),
        }
      }

      return {
        lossless: await run(85, 'none'),
        losslessLowSlider: await run(10, 'none'),
        quantized: await run(10, 'quantized'),
      }
    },
    {
      pngPath: PNG_MODULE_PATH,
      planPath: PNG_PLAN_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      source: fixture('icc-p3.jpg'),
    },
  )

  expect(result.quantized.branch).toBe('quantized')

  for (const [key, row] of Object.entries(result)) {
    // The same bytes that were embedded in the source, on whichever branch produced the file — the
    // quantized one gets ImageMagick's own chunk spliced in, moved whole rather than re-encoded.
    expect(row.profile, key).toEqual(ICC_PROFILE)
    expect(row.chunks, key).toContain('iCCP')
    // `sRGB` and `iCCP` are mutually exclusive in the PNG specification, and a file carrying both
    // makes two readers disagree about the colour (T23). `cHRM` and `gAMA` say it a third way.
    for (const contradiction of ['sRGB', 'gAMA', 'cHRM']) {
      expect(row.chunks, key).not.toContain(contradiction)
    }
  }
})

test('the engine honours the spliced profile, not merely the bytes ImageMagick can read back', async ({
  page,
}) => {
  // The test above proves the `iCCP` chunk round-trips through the library that wrote it, which is
  // exactly the proof T26 found insufficient. This one asks the engine's own decoder: identical
  // pixels written with and without the Display P3 profile must not draw the same, because a
  // colour-managed decoder converts the tagged one into the canvas's sRGB. That can only happen if
  // the chunk is a profile the engine parses — including the one spliced into libimagequant's file.
  const result = await page.evaluate(
    async ({ pngPath, profile }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const p3 = { kind: 'icc', profile: new Uint8Array(profile), description: 'Display P3' }
      const untagged = { kind: 'untagged' }

      // The two files hold the same pixels — a profile changes nothing about what is encoded — so
      // every difference between what the engine draws from them is the profile being applied.
      const compare = async (content: Content, slider: number) => {
        const source = makeFrame(content, 160, 120).pixels
        const plain = await encodePng(
          { ...makeFrame(content, 160, 120), colour: untagged },
          quality(slider),
        )
        const tagged = await encodePng(
          { ...makeFrame(content, 160, 120), colour: p3 },
          quality(slider),
        )
        const drawnPlain = await drawPng(plain.bytes)
        const drawnTagged = await drawPng(tagged.bytes)

        let betweenFiles = 0
        let plainAgainstSource = 0
        for (let i = 0; i < source.length; i += 4) {
          for (let band = 0; band < 3; band += 1) {
            betweenFiles = Math.max(
              betweenFiles,
              Math.abs(drawnPlain.data[i + band]! - drawnTagged.data[i + band]!),
            )
            plainAgainstSource = Math.max(
              plainAgainstSource,
              Math.abs(source[i + band]! - drawnPlain.data[i + band]!),
            )
          }
        }

        return {
          branch: tagged.branch as string,
          plainBranch: plain.branch as string,
          betweenFiles,
          plainAgainstSource,
        }
      }

      return {
        lossless: await compare('flat', 85),
        // Smooth shading, so the quantized candidate is the smaller one and the profile the engine
        // reads is the chunk this stage spliced into libimagequant's output.
        quantized: await compare('shaded', 10),
      }
    },
    { pngPath: PNG_MODULE_PATH, profile: ICC_PROFILE },
  )

  expect(result.lossless).toMatchObject({ branch: 'lossless', plainBranch: 'lossless' })
  expect(result.quantized).toMatchObject({ branch: 'quantized', plainBranch: 'quantized' })

  // Seven flat colours: the lossless candidate draws back exactly, so nothing but the profile is
  // moving in the comparison below.
  expect(result.lossless.plainAgainstSource).toBe(0)

  if (test.info().project.name === 'firefox') {
    // **Firefox does not colour-manage an image drawn into a 2D canvas**, in this Playwright build:
    // the tagged and untagged files draw identically, to the encoder's own values. So on Firefox
    // this test can only show that the profile changed nothing about the pixels — which is still
    // worth asserting, because it is what makes the comparison on the other two engines attributable
    // to the profile and to nothing else. Firefox *does* colour-manage a plain `<img>`, which is
    // what R-I16's Preview will use; a canvas is not a colour-managed surface there.
    expect(result.lossless.betweenFiles).toBe(0)
    expect(result.quantized.betweenFiles).toBe(0)
    return
  }

  // Chromium and WebKit converted the tagged file and not the untagged one. Display P3 is wider
  // than sRGB, so a saturated colour moves a long way; the bound is loose because how far is the
  // engine's business, and that it moved at all is the claim. A chunk that were merely well-formed
  // bytes — or a profile broken by the splice — would draw identically and this would read 0.
  expect(result.lossless.betweenFiles).toBeGreaterThan(3)
  expect(result.quantized.betweenFiles).toBeGreaterThan(3)
})

test('an untagged frame gains no profile; a CICP frame is refused unless it says nothing (R-I14, R-I35)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)

      const run = async (colour: unknown, slider: number) => {
        const frame = { ...makeFrame('gradient', 120, 90), colour }
        try {
          const encoded = await encodePng(frame, quality(slider))
          return {
            ok: true,
            chunks: plan.readPngChunks(encoded.bytes).map((chunk: { type: string }) => chunk.type),
          }
        } catch (error) {
          return { ok: false, name: (error as Error).name }
        }
      }

      const cicp = (primaries: number, transfer: number, matrix: number) => ({
        kind: 'cicp',
        cicp: { primaries, transfer, matrix, fullRange: false },
      })

      return {
        untagged: await run({ kind: 'untagged' }, 85),
        untaggedQuantized: await run({ kind: 'untagged' }, 10),
        unspecified: await run(cicp(2, 2, 2), 85),
        bt709Srgb: await run(cicp(1, 13, 6), 85),
        displayP3: await run(cicp(12, 13, 6), 85),
        bt2020Pq: await run(cicp(9, 16, 9), 10),
      }
    },
    { pngPath: PNG_MODULE_PATH, planPath: PNG_PLAN_MODULE_PATH },
  )

  // Nothing is added to a frame with no colour signal, and none is invented for a signal that says
  // no more than an untagged output already says.
  for (const key of ['untagged', 'untaggedQuantized', 'unspecified', 'bt709Srgb'] as const) {
    expect(result[key].ok, key).toBe(true)
    for (const chunk of ['iCCP', 'sRGB', 'gAMA', 'cHRM']) {
      expect(result[key].chunks, key).not.toContain(chunk)
    }
  }

  // A real colour PNG cannot carry in this build: refused rather than written as sRGB, which is the
  // silent shift R-I35 exists to prevent. This build writes no `cICP` chunk whatever it is told.
  expect(result.displayP3).toEqual({ ok: false, name: 'UnsupportedColourError' })
  expect(result.bt2020Pq).toEqual({ ok: false, name: 'UnsupportedColourError' })
})

test('no metadata reaches the output, from the source or from ImageMagick itself (R-I10, R-I17)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath, decodePath, loaderPath, source }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const { decodeFrame } = await import(/* @vite-ignore */ decodePath)
      const magick = await (await import(/* @vite-ignore */ loaderPath)).ensureImageMagick()
      const { ImageMagick, MagickFormat, MagickReadSettings } = magick

      const frame = await decodeFrame(new Uint8Array(source))
      const encoded = await encodePng(frame, quality(85))

      // What ImageMagick writes when nothing strips it — the thing the chunk rewrite is for.
      const unstripped = ImageMagick.read(
        frame.pixels,
        new MagickReadSettings({
          format: MagickFormat.Rgba,
          width: frame.width,
          height: frame.height,
          depth: 8,
        }),
        (image: { write<T>(format: string, callback: (data: Uint8Array) => T): T }) =>
          image.write(MagickFormat.Png, (data) => data.slice()),
      ) as Uint8Array

      return {
        chunks: plan.readPngChunks(encoded.bytes).map((chunk: { type: string }) => chunk.type),
        unstrippedChunks: plan
          .readPngChunks(unstripped)
          .map((chunk: { type: string }) => chunk.type),
        read: ImageMagick.read(encoded.bytes, (image: MagickImageLike) => ({
          profiles: [...image.profileNames],
          orientation: image.orientation,
        })),
      }
    },
    {
      pngPath: PNG_MODULE_PATH,
      planPath: PNG_PLAN_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      source: fixture('orientation-6.jpg'),
    },
  )

  // ImageMagick writes timestamps of its own on every PNG; this is the file it would have produced.
  expect(result.unstrippedChunks).toContain('tEXt')
  expect(result.unstrippedChunks).toContain('tIME')

  for (const chunk of ['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']) {
    expect(result.chunks, chunk).not.toContain(chunk)
  }
  for (const name of ['exif', 'xmp', 'iptc', '8bim', 'icc']) {
    expect(result.read.profiles).not.toContain(name)
  }
  expect([0, 1]).toContain(result.read.orientation)
})

test('oxipng runs at level 2 in the single-threaded worker baseline (§7.3, §8)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath, loaderPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const magick = await (await import(/* @vite-ignore */ loaderPath)).ensureImageMagick()
      const { ImageMagick, MagickFormat, MagickReadSettings, AlphaAction } = magick

      const frame = makeFrame('photo', 400, 300)
      const encoded = await encodePng(frame, quality(100))

      // The same file without oxipng: ImageMagick's write with its metadata stripped, nothing more.
      const written = ImageMagick.read(
        frame.pixels,
        new MagickReadSettings({
          format: MagickFormat.Rgba,
          width: frame.width,
          height: frame.height,
          depth: 8,
        }),
        (image: {
          alpha(action: number): void
          write<T>(f: string, cb: (d: Uint8Array) => T): T
        }) => {
          image.alpha(AlphaAction.Off)
          return image.write(MagickFormat.Png, (data) => data.slice())
        },
      ) as Uint8Array
      const stripped = plan.rewritePngChunks(written, { kind: 'drop' })

      // T27's old dual-build wrapper chose threads only when SharedArrayBuffer could be posted.
      // The compatibility-fixed APNG build now ships only the baseline that predicate selected,
      // but the deployment fact behind the choice remains observable here.
      const source = `self.addEventListener('message', () => {
        let postable = false
        try { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); postable = true } catch {}
        const threaded = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11])
        let validates = false
        try { validates = WebAssembly.validate(threaded) } catch {}
        self.postMessage({
          isWorker: typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope,
          concurrency: navigator.hardwareConcurrency,
          threadsPredicate: postable && validates,
        })
      })`
      const view = globalThis as unknown as {
        Blob: new (parts: [string], options: { type: string }) => object
        URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void }
        Worker: new (url: string) => {
          postMessage(message: unknown): void
          terminate(): void
          addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
        }
        crossOriginIsolated?: boolean
      }
      const url = view.URL.createObjectURL(new view.Blob([source], { type: 'text/javascript' }))
      const worker = new view.Worker(url)
      const probe = await new Promise<{
        isWorker: boolean
        concurrency: number
        threadsPredicate: boolean
      }>((resolve) => {
        worker.addEventListener('message', (event) =>
          resolve(
            event.data as { isWorker: boolean; concurrency: number; threadsPredicate: boolean },
          ),
        )
        worker.postMessage('go')
      })
      worker.terminate()
      view.URL.revokeObjectURL(url)

      return {
        level: plan.OXIPNG_LEVEL as number,
        options: plan.oxipngOptions(),
        unoptimised: stripped.byteLength,
        optimised: encoded.bytes.byteLength as number,
        probe,
        crossOriginIsolated: view.crossOriginIsolated ?? null,
      }
    },
    { pngPath: PNG_MODULE_PATH, planPath: PNG_PLAN_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  expect(result.level).toBe(2)
  expect(result.options).toEqual({ level: 2, interlace: false, optimiseAlpha: false })
  // oxipng really ran: the shipped file is smaller than the same PNG straight out of ImageMagick.
  expect(result.optimised).toBeLessThan(result.unoptimised)

  // Context for the assertion in the next test: the pipeline runs inside a Worker with more than one
  // core, but SharedArrayBuffer is unavailable without cross-origin isolation. This is why the
  // APNG-compatible rebuild deliberately bundles only the single-threaded baseline.
  expect(result.probe.isWorker).toBe(true)
  expect(result.probe.concurrency).toBeGreaterThan(1)
  expect(result.crossOriginIsolated).toBe(false)
  expect(result.probe.threadsPredicate).toBe(false)
})

test('the pipeline worker fetches only the compatibility-fixed single-threaded oxipng wasm (§8.1, B6)', async ({
  page,
}) => {
  // Observed, not inferred. Watching the real worker's request proves the old package binaries did
  // not leak into the build and that the APNG-compatible 9.1.5 core is the one actually fetched.
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))

  await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1 })

      // A one-byte source: the job fails at decode, but `ensureCodecsForJob` has already loaded
      // oxipng inside the real pipeline worker by then, which is the only thing this test watches.
      await instance.run({
        imageId: 'oxipng-build',
        source: new Uint8Array([0]),
        edit: null,
        settings: {
          quality: quality(10),
          dimension: { kind: 'original' },
          format: 'png',
          sourceFormat: 'png',
          isAnimated: false,
          alpha: { kind: 'preserve' },
        },
        intent: 'preview',
      }).done
      instance.destroy()
    },
    { poolPath: POOL_MODULE_PATH },
  )

  const oxipngWasm = requested.filter((url) => /oxipng.*\.wasm$/.test(url))

  expect(oxipngWasm, `oxipng wasm requests: ${JSON.stringify(requested.slice(-8))}`).toHaveLength(1)
  expect(oxipngWasm[0]).toContain('oxipng-9.1.5')
  expect(requested.some((url) => url.includes('pkg-parallel'))).toBe(false)
})

test('the R-Q12 boundary lands on slider 85, and the floor holds all the way down (R-Q11)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ pngPath, planPath }) => {
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const plan = await import(/* @vite-ignore */ planPath)

      const rows: Record<number, unknown> = {}
      for (const slider of [10, 12, 20, 40, 70, 84, 85, 86, 100]) {
        const settings = quality(slider)
        const encoded = await encodePng(makeFrame('gradient', 160, 120), settings)
        rows[slider] = {
          minimum: plan.quantizerSettings(settings).minimum,
          branches: encoded.branches as string[],
          lossless: settings.lossless,
        }
      }
      return rows as Record<number, { minimum: number; branches: string[]; lossless: boolean }>
    },
    { pngPath: PNG_MODULE_PATH, planPath: PNG_PLAN_MODULE_PATH },
  )

  // R-Q11's table, end to end through the shipped stage.
  expect(result[10]!.minimum).toBe(70)
  expect(result[12]!.minimum).toBe(71)
  expect(result[20]!.minimum).toBe(73)
  expect(result[40]!.minimum).toBe(80)
  expect(result[70]!.minimum).toBe(90)
  expect(result[100]!.minimum).toBe(100)

  // R-Q12: lossless from 85, not from 84 — even though 84 rounds to the same 95.
  expect(result[84]).toMatchObject({
    minimum: 95,
    lossless: false,
    branches: ['lossless', 'quantized'],
  })
  expect(result[85]).toMatchObject({ minimum: 95, lossless: true, branches: ['lossless'] })
  expect(result[86]!.branches).toEqual(['lossless'])
  expect(result[100]!.branches).toEqual(['lossless'])

  // Nothing below 85 escapes the comparison, and nothing asks for less than 70.
  for (const slider of [10, 12, 20, 40, 70, 84]) {
    expect(result[slider]!.branches, String(slider)).toEqual(['lossless', 'quantized'])
    expect(result[slider]!.minimum, String(slider)).toBeGreaterThanOrEqual(70)
  }
})
