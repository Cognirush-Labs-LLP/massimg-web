import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// T23 — pipeline/stages/decode.ts (Functional Design R-I9 to R-I16, R-I35; Technical Design §7.7).
//
// Same DOM/dynamic-import constraint as codecs.spec.ts, pool.spec.ts and thumbnails.spec.ts:
// tests/e2e/** compiles with tsconfig.node.json, which has no DOM lib, so the modules under test are
// loaded inside the page via a dynamic import of their served paths and every result is mapped to a
// plain serializable shape before it crosses back to Node.
//
// Fixtures are read from disk rather than generated in the page, unlike thumbnails.spec.ts. They
// have to be: an EXIF orientation tag and a `colr`/`nclx` box cannot be produced by a canvas, and
// the point of the orientation set is that its eight members were built by *something other than
// the code under test* — see scripts/build-test-fixtures.mjs, which is committed alongside the
// bytes and regenerates them identically.
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const LOADER_MODULE_PATH = '/src/pipeline/codecs/loader.ts'
const COLOUR_MODULE_PATH = '/src/pipeline/stages/colour.ts'
const THUMBNAILS_MODULE_PATH = '/src/platform/thumbnails.ts'
const FALLBACK_MODULE_PATH = '/src/platform/thumbnail-fallback.ts'

// The canonical fixture image: a 3x2 grid of 20px cells, 60x40, six distinct colours, top-left
// first. Mirrored in scripts/build-test-fixtures.mjs — if that changes, this changes with it.
const CELL_COLOURS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
]
const WIDTH = 60
const HEIGHT = 40
const COLS = 3
const ROWS = 2

/** Lossy-codec slack. The fixtures are flat blocks at quality 95-100 with 4:4:4 chroma, and cells
 * are sampled at their centres, so the real error is a few units; this is a wide margin that still
 * cannot confuse any two of the six colours (their channels differ by 170 or more). */
const CHANNEL_TOLERANCE = 30

// The browser API used inside a page callback, declared minimally because tests/e2e has no DOM lib.
declare function createImageBitmap(source: Blob): Promise<{ width: number; height: number }>

/**
 * The slice of magick-wasm's `IMagickImage` these tests touch. Declared locally rather than imported
 * because tests/e2e compiles as Node code with no path alias into src/, and only the shapes used
 * inside `page.evaluate` callbacks need naming.
 */
interface MagickImageLike {
  quality: number
  width: number
  height: number
  readonly profileNames: readonly string[]
  orientation: number
  settings: { setDefine(format: string, name: string, value: string): void }
  write(format: string, callback: (data: Uint8Array) => void): void
}

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

interface DecodedShape {
  width: number
  height: number
  /** Row-major cell centres, RGB only. */
  cells: number[][]
  colour: { kind: string; description?: string | null; cicp?: Record<string, unknown> }
  profileLength: number | null
  sourceOrientation: { kind: string; value?: number }
  pixelBytes: number
  ownsWholeBuffer: boolean
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

/**
 * Decodes one fixture through the real `decodeFrame` and maps the result to a serializable shape.
 *
 * The dynamic import lives inside `page.evaluate` rather than in an `addInitScript` helper, as in
 * thumbnails.spec.ts and codecs.spec.ts: WebKit refuses a module import issued from init-script
 * scope ("Importing a module script failed"), because that scope's base URL is not the page's.
 * Chromium and Firefox resolve it either way, so this is a WebKit-only constraint that the other
 * two engines would never have shown.
 */
async function decode(page: Page, name: string): Promise<DecodedShape> {
  return page.evaluate(
    async ({ decodePath, bytes, cols, rows }) => {
      const module = await import(/* @vite-ignore */ decodePath)
      const frame = await module.decodeFrame(new Uint8Array(bytes))

      const cells: number[][] = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = Math.floor(((col + 0.5) * frame.width) / cols)
          const y = Math.floor(((row + 0.5) * frame.height) / rows)
          const i = (y * frame.width + x) * 4
          cells.push([frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]])
        }
      }

      return {
        width: frame.width,
        height: frame.height,
        cells,
        colour: {
          kind: frame.colour.kind,
          description: frame.colour.description ?? null,
          cicp: frame.colour.cicp ?? null,
        },
        profileLength: frame.colour.profile ? frame.colour.profile.length : null,
        sourceOrientation: frame.sourceOrientation,
        pixelBytes: frame.pixels.length,
        ownsWholeBuffer:
          frame.pixels.byteOffset === 0 &&
          frame.pixels.byteLength === frame.pixels.buffer.byteLength,
      }
    },
    { decodePath: DECODE_MODULE_PATH, bytes: fixture(name), cols: COLS, rows: ROWS },
  )
}

function expectUpright(decoded: DecodedShape): void {
  expect(decoded.width).toBe(WIDTH)
  expect(decoded.height).toBe(HEIGHT)
  expect(decoded.cells).toHaveLength(CELL_COLOURS.length)

  decoded.cells.forEach((cell, index) => {
    const expected = CELL_COLOURS[index]
    expect(expected).toBeDefined()
    cell.forEach((channel, band) => {
      expect(
        Math.abs(channel - (expected as number[])[band]!),
        `cell ${index} band ${band}: got ${channel}, expected ~${(expected as number[])[band]}`,
      ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// R-I9 / D4 — EXIF orientation applied to the pixels.
//
// One test per value, not one test over eight, so a failure names the value that broke. The four
// mirrored orientations (2, 4, 5, 7) are the whole reason this is an enumeration: a transform that
// is right for the four rotations can be wrong for every flip, and a flip is invisible in the
// output dimensions — 2 and 4 keep the source's dimensions exactly as 1 and 3 do, and 5 and 7 swap
// them exactly as 6 and 8 do. Uprightness is therefore asserted by pixel content.
// ---------------------------------------------------------------------------------------------

const MIRRORED = new Set([2, 4, 5, 7])

for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const kind = MIRRORED.has(value) ? 'mirrored' : 'rotation'
  test(`orientation ${value} (${kind}) decodes upright`, async ({ page }) => {
    const decoded = await decode(page, `orientation-${value}.jpg`)
    expectUpright(decoded)
    expect(decoded.sourceOrientation).toEqual({ kind: 'present', value })
  })
}

// ---------------------------------------------------------------------------------------------
// The three orientation states. Absent, present-and-default and present-and-unusual are different
// things and the pipeline distinguishes them.
// ---------------------------------------------------------------------------------------------

test('a source with no EXIF orientation tag is absent, not orientation 1', async ({ page }) => {
  const decoded = await decode(page, 'orientation-absent.jpg')
  expectUpright(decoded)
  expect(decoded.sourceOrientation).toEqual({ kind: 'absent' })
})

test('a source whose tag says upright is present, not absent', async ({ page }) => {
  const decoded = await decode(page, 'orientation-1.jpg')
  expect(decoded.sourceOrientation).toEqual({ kind: 'present', value: 1 })
})

test('a source whose tag asks for a transform records the value it asked for', async ({ page }) => {
  const decoded = await decode(page, 'orientation-6.jpg')
  expect(decoded.sourceOrientation).toEqual({ kind: 'present', value: 6 })
})

// ---------------------------------------------------------------------------------------------
// R-I10 — the output carries no orientation tag.
//
// The frame has nowhere to put one, so this demonstrates the consequence: encoding the decoded
// frame back out produces a file with no EXIF profile and no orientation asking to be rotated
// again. The encode here is the test's own — pipeline/stages/encode.ts is T26's — so this proves
// that nothing survives *decode* to be written, which is the half T23 owns.
// ---------------------------------------------------------------------------------------------

test('nothing survives decode that could put an orientation tag on the output', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ decodePath, loaderPath, bytes }) => {
      const [decodeModule, loader] = await Promise.all([
        import(/* @vite-ignore */ decodePath),
        import(/* @vite-ignore */ loaderPath),
      ])
      const frame = await decodeModule.decodeFrame(new Uint8Array(bytes))
      const { ImageMagick, MagickFormat, MagickReadSettings } = await loader.ensureImageMagick()

      const settings = new MagickReadSettings({
        format: MagickFormat.Rgba,
        width: frame.width,
        height: frame.height,
        depth: 8,
      })

      const encoded: Uint8Array = ImageMagick.read(
        frame.pixels,
        settings,
        (image: MagickImageLike) => {
          let out: Uint8Array | null = null
          image.write(MagickFormat.Jpeg, (data: Uint8Array) => {
            out = new Uint8Array(data)
          })
          return out
        },
      )

      return ImageMagick.read(encoded, (image: MagickImageLike) => ({
        profiles: [...image.profileNames],
        orientation: image.orientation,
        width: image.width,
        height: image.height,
      }))
    },
    {
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      bytes: fixture('orientation-6.jpg'),
    },
  )

  expect(result.profiles).not.toContain('exif')
  // Undefined (0) or TopLeft (1): either way no conforming viewer rotates it a second time. What
  // must never appear is the source's own 6.
  expect([0, 1]).toContain(result.orientation)
  expect(result.width).toBe(WIDTH)
  expect(result.height).toBe(HEIGHT)
})

// ---------------------------------------------------------------------------------------------
// R-I12 to R-I16, R-I35 — colour as an ICC profile, or as CICP, or as neither.
// ---------------------------------------------------------------------------------------------

test('an embedded ICC profile is carried verbatim', async ({ page }) => {
  const decoded = await decode(page, 'icc-p3.jpg')
  expect(decoded.colour.kind).toBe('icc')
  expect(decoded.colour.description).toBe('Display P3 test fixture')
  expect(decoded.profileLength).toBe(fixture('icc-profile.bin').length)
})

test('the ICC profile bytes are identical to the ones the fixture embedded', async ({ page }) => {
  const bytes = await page.evaluate(
    async ({ decodePath, source }) => {
      const module = await import(/* @vite-ignore */ decodePath)
      const frame = await module.decodeFrame(new Uint8Array(source))
      return Array.from(frame.colour.profile as Uint8Array)
    },
    { decodePath: DECODE_MODULE_PATH, source: fixture('icc-p3.jpg') },
  )
  expect(bytes).toEqual(fixture('icc-profile.bin'))
})

test('an ICC profile in a HEIF-family container is read the same way', async ({ page }) => {
  const decoded = await decode(page, 'icc-p3.avif')
  expect(decoded.colour.kind).toBe('icc')
  expect(decoded.colour.description).toBe('Display P3 test fixture')
})

// The clause this task turns on. ImageMagick reports no profile for this file and no attribute
// carrying its colour, so a pipeline that only asks ImageMagick sees an untagged image and treats
// it as sRGB — shifting a Display P3 photograph's colour with nothing to show for it.
test('a source whose colour is signalled only by CICP is not reported as untagged', async ({
  page,
}) => {
  const decoded = await decode(page, 'cicp-p3.avif')
  expect(decoded.colour.kind).toBe('cicp')
  expect(decoded.colour.cicp).toEqual({
    primaries: 12,
    transfer: 13,
    matrix: 6,
    fullRange: false,
  })
})

test('a CICP-signalled source decodes to the colours it was built from', async ({ page }) => {
  expectUpright(await decode(page, 'cicp-p3.avif'))
})

test('a source with neither signal is untagged, and no profile is invented', async ({ page }) => {
  const decoded = await decode(page, 'untagged.avif')
  expect(decoded.colour.kind).toBe('untagged')
  expect(decoded.profileLength).toBeNull()
})

test('a JPEG carrying EXIF but no profile is untagged, not mistaken for tagged', async ({
  page,
}) => {
  const decoded = await decode(page, 'orientation-1.jpg')
  expect(decoded.colour.kind).toBe('untagged')
})

// R-I35's "carried to the output where the format can express it": the values the decoder read are
// written back into a HEIF container and read out again unchanged. The encode is the test's own
// (T26 owns the encode stage) — what this proves is that decode carries values an encoder can use,
// rather than values that have already lost their meaning.
test('CICP values round-trip through a HEIF-family container unchanged', async ({ page }) => {
  const result = await page.evaluate(
    async ({ decodePath, loaderPath, colourPath, bytes }) => {
      const [decodeModule, loader] = await Promise.all([
        import(/* @vite-ignore */ decodePath),
        import(/* @vite-ignore */ loaderPath),
      ])
      const frame = await decodeModule.decodeFrame(new Uint8Array(bytes))
      const cicp = frame.colour.cicp
      const { ImageMagick, MagickFormat, MagickReadSettings } = await loader.ensureImageMagick()

      const settings = new MagickReadSettings({
        format: MagickFormat.Rgba,
        width: frame.width,
        height: frame.height,
        depth: 8,
      })

      const encoded: Uint8Array = ImageMagick.read(
        frame.pixels,
        settings,
        (image: MagickImageLike) => {
          image.quality = 95
          // The namespace is `heic:` even for AVIF output: one coder serves the HEIF family.
          image.settings.setDefine(
            MagickFormat.Heic,
            'cicp',
            `${cicp.primaries},${cicp.transfer},${cicp.matrix}`,
          )
          image.settings.setDefine(MagickFormat.Heic, 'preserve-cicp', 'true')
          let out: Uint8Array | null = null
          image.write(MagickFormat.Avif, (data: Uint8Array) => {
            out = new Uint8Array(data)
          })
          return out
        },
      )

      // Read back with the shipped reader, so the round trip is closed by the same code the
      // pipeline uses rather than by a second implementation written to agree with it.
      const colour = await import(/* @vite-ignore */ colourPath)
      return { carried: cicp, readBack: colour.readCicp(encoded) }
    },
    {
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      colourPath: COLOUR_MODULE_PATH,
      bytes: fixture('cicp-p3.avif'),
    },
  )

  const expected = { primaries: 12, transfer: 13, matrix: 6, fullRange: false }
  expect(result.carried).toEqual(expected)
  expect(result.readBack).toEqual(expected)
})

// ---------------------------------------------------------------------------------------------
// §10.3 — HEIC is ordinary input. No capability branch, no format switch.
// ---------------------------------------------------------------------------------------------

test('unrelated container formats all go through the one decode call', async ({ page }) => {
  // JPEG, AVIF (HEIF family, the container HEIC also uses) and TIFF, decoded by the same function
  // with no argument distinguishing them. A real HEIC is not committable — the build has no HEVC
  // encoder to generate one (A11) and a real photograph cannot be checked in — so decode of a real
  // HEIC, including one whose colour is signalled only by CICP, is proven in
  // verification/t23-decode/ against the machine-local fixture directory instead.
  for (const name of ['orientation-absent.jpg', 'untagged.avif', 'plain.tif']) {
    const decoded = await decode(page, name)
    expectUpright(decoded)
  }
})

// ---------------------------------------------------------------------------------------------
// The transfer-list hazard T21's review flagged for the first stage to land.
// ---------------------------------------------------------------------------------------------

test('a decoded frame owns its buffer', async ({ page }) => {
  const decoded = await decode(page, 'orientation-1.jpg')
  expect(decoded.ownsWholeBuffer).toBe(true)
  expect(decoded.pixelBytes).toBe(WIDTH * HEIGHT * 4)
})

test('transferring a frame buffer does not detach the codec heap', async ({ page }) => {
  // The hazard, concretely: `pipeline/worker.ts` puts result bytes' `.buffer` in its postMessage
  // transfer list. If a stage returned a view onto ImageMagick's memory, transferring it would
  // detach the entire WASM heap and every later job in that worker would fail. So: decode, transfer
  // the buffer away, then decode again in the same context and check the second result is correct.
  const result = await page.evaluate(
    async ({ decodePath, first, second }) => {
      const module = await import(/* @vite-ignore */ decodePath)

      const one = await module.decodeFrame(new Uint8Array(first))
      const buffer = one.pixels.buffer as ArrayBuffer
      structuredClone(buffer, { transfer: [buffer] })
      const detached = buffer.byteLength === 0

      const two = await module.decodeFrame(new Uint8Array(second))
      const sample = [two.pixels[0], two.pixels[1], two.pixels[2]]
      return { detached, width: two.width, height: two.height, sample }
    },
    {
      decodePath: DECODE_MODULE_PATH,
      first: fixture('orientation-1.jpg'),
      second: fixture('orientation-3.jpg'),
    },
  )

  expect(result.detached).toBe(true)
  expect(result.width).toBe(WIDTH)
  expect(result.height).toBe(HEIGHT)
  // Top-left cell of the canonical image, decoded after the first frame's buffer was transferred.
  result.sample.forEach((channel, band) => {
    expect(Math.abs(channel - CELL_COLOURS[0]![band]!)).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
  })
})

// ---------------------------------------------------------------------------------------------
// Technical Design §10.4 — the thumbnail fallback, now wired (T20's seam, handed on by T22).
// ---------------------------------------------------------------------------------------------

test('the ImageMagick fallback decoder produces a bounded thumbnail', async ({ page }) => {
  const result = await page.evaluate(
    async ({ fallbackPath, bytes }) => {
      const module = await import(/* @vite-ignore */ fallbackPath)
      const decoder = module.createImageMagickFallbackDecoder()
      const blob = await decoder({
        blob: new Blob([new Uint8Array(bytes)], { type: 'image/jp2' }),
        source: { width: 60, height: 40 },
        edit: null,
        maxEdge: 24,
        format: 'image/webp',
        quality: 0.75,
      })
      const bitmap = await createImageBitmap(blob)
      return { type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height }
    },
    { fallbackPath: FALLBACK_MODULE_PATH, bytes: fixture('plain.jp2') },
  )

  expect(result.type).toBe('image/webp')
  expect(result.size).toBeGreaterThan(0)
  // Both axes bounded, not width alone (R-G3): 60x40 fitted inside 24 is 24x16.
  expect(result.width).toBe(24)
  expect(result.height).toBe(16)
})

// JPEG 2000 rather than TIFF: measured undecodable by `createImageBitmap` on all three engines,
// where WebKit decodes TIFF natively through ImageIO. With a TIFF these two tests would exercise
// the fallback on two engines and quietly prove something weaker on the third.
test('the thumbnail service falls back to ImageMagick for an input no engine can decode', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ thumbnailsPath, bytes }) => {
      const module = await import(/* @vite-ignore */ thumbnailsPath)
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jp2' })

      let nativelyDecodable = true
      try {
        await createImageBitmap(blob)
      } catch {
        nativelyDecodable = false
      }

      const service = module.createThumbnailService({ maxEdge: 32 })
      service.setVisible([{ id: 'jp2', blob, source: { width: 60, height: 40 }, edit: null }])
      await service.whenIdle()
      const cached = service.urlFor('jp2') !== null
      const stats = service.stats()
      service.clear()
      return { nativelyDecodable, cached, retained: stats.retained }
    },
    { thumbnailsPath: THUMBNAILS_MODULE_PATH, bytes: fixture('plain.jp2') },
  )

  // The premise of the test, asserted rather than assumed: if an engine ever gains a JP2 decoder
  // this stops proving what it claims, and should fail loudly rather than pass for a new reason.
  expect(result.nativelyDecodable).toBe(false)
  expect(result.cached).toBe(true)
  expect(result.retained).toBe(1)
})

// R-G12, for the path T23 added. The requirement is that leaving Gallery *stops* generation, not
// that a late result is discarded — and ImageMagick's decode is a synchronous WASM call with no
// abort, so the only way to stop it is to terminate the context running it. That is why the
// fallback lives in the worker rather than in `thumbnails.ts`.
//
// `slow.jp2` is 4000x3000 and takes roughly half a second of synchronous decode, so `stop()` lands
// while the work is genuinely in flight. With the 60x40 fixture the decode finishes faster than the
// test can react, and the assertion would hold whether the work was stopped or merely completed and
// discarded.
test('stop() during a fallback decode terminates it and nothing lands afterwards', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ thumbnailsPath, bytes }) => {
      const module = await import(/* @vite-ignore */ thumbnailsPath)
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jp2' })

      const service = module.createThumbnailService({ maxEdge: 32 })
      service.setVisible([{ id: 'jp2', blob, source: { width: 4000, height: 3000 }, edit: null }])

      // Wait until the job is really in flight, then give the native decode time to fail and the
      // fallback time to start. Stopping before either would test nothing.
      const deadline = Date.now() + 5000
      while (!service.stats().running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const runningBeforeStop = service.stats().running
      await new Promise((resolve) => setTimeout(resolve, 300))

      // If this is already true the window was missed and the test proves nothing, so it is
      // asserted rather than assumed.
      const cachedBeforeStop = service.urlFor('jp2') !== null

      service.stop()
      const afterStop = service.stats()

      // Comfortably longer than loading ImageMagick and decoding this image, so a fallback that was
      // merely un-awaited rather than terminated would have landed by now.
      await new Promise((resolve) => setTimeout(resolve, 6000))

      const finished = service.stats()
      const cached = service.urlFor('jp2') !== null
      service.clear()
      return {
        runningBeforeStop,
        cachedBeforeStop,
        workerAliveAfterStop: afterStop.workerAlive,
        runningAfterStop: afterStop.running,
        cached,
        retained: finished.retained,
      }
    },
    { thumbnailsPath: THUMBNAILS_MODULE_PATH, bytes: fixture('slow.jp2') },
  )

  expect(result.runningBeforeStop).toBe(true)
  expect(result.cachedBeforeStop).toBe(false)
  // The mechanism, not just the outcome: the context doing the un-abortable work is gone.
  expect(result.workerAliveAfterStop).toBe(false)
  expect(result.runningAfterStop).toBe(false)
  expect(result.cached).toBe(false)
  expect(result.retained).toBe(0)
})

// The other half of the same guarantee, and the one that actually distinguishes a worker fallback
// from a main-thread one: `ImageMagick.read` is synchronous, so on the main thread it would stall
// the event loop for the whole decode.
//
// This asserts *which thread* does the decode instead of timing how long the page stays responsive.
// A responsiveness bound cannot tell "decode ran on the main thread" from "the main thread was
// briefly starved of CPU": the fallback's 14.8 MB module is being compiled on other threads at the
// moment it would matter, and on a two-core machine (a CI runner) WebKit on Linux showed 270 to
// 560 ms gaps against a 250 ms bound, with 80 to 180 ms gaps even for a plain PNG and an idle page.
// The worker has its own WebAssembly, so a WebAssembly call in the page's own realm can only come
// from the main thread — deterministic, and no tighter on a faster machine than on a slower one.
test('the fallback decode runs in a worker, not on the main thread', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(
    async ({ thumbnailsPath, fallbackPath, bytes }) => {
      const wasmCalls: string[] = []
      const workerScripts: string[] = []

      const scope = globalThis as unknown as {
        WebAssembly: Record<string, unknown>
        Worker: new (url: string | URL, options?: object) => object
      }
      const originals: Record<string, unknown> = {}
      for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) {
        const original = scope.WebAssembly[name] as ((...args: unknown[]) => unknown) | undefined
        if (typeof original !== 'function') continue
        originals[name] = original
        scope.WebAssembly[name] = function (...args: unknown[]) {
          wasmCalls.push(name)
          return original.apply(scope.WebAssembly, args)
        }
      }
      for (const name of ['Module', 'Instance']) {
        const original = scope.WebAssembly[name] as object | undefined
        if (typeof original !== 'function') continue
        originals[name] = original
        scope.WebAssembly[name] = new Proxy(original, {
          construct(target, args, newTarget) {
            wasmCalls.push(`new ${name}`)
            return Reflect.construct(target, args, newTarget)
          },
        })
      }
      const OriginalWorker = scope.Worker
      scope.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: object) {
          workerScripts.push(String(url))
          super(url, options)
        }
      }

      try {
        const module = await import(/* @vite-ignore */ thumbnailsPath)
        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jp2' })

        const service = module.createThumbnailService({ maxEdge: 32 })
        service.setVisible([{ id: 'jp2', blob, source: { width: 4000, height: 3000 }, edit: null }])
        await service.whenIdle()
        const cached = service.urlFor('jp2') !== null
        service.clear()
        const mainThreadCallsDuringService = [...wasmCalls]

        // Control, so the check above cannot pass by observing nothing: the same decode called
        // directly, which is exactly the main-thread run the service must never do.
        wasmCalls.length = 0
        const fallback = await import(/* @vite-ignore */ fallbackPath)
        const decode = fallback.createImageMagickFallbackDecoder()
        await decode({
          blob,
          source: { width: 4000, height: 3000 },
          edit: null,
          maxEdge: 32,
          format: 'image/webp',
          quality: 0.8,
        })
        const mainThreadCallsWhenCalledDirectly = [...wasmCalls]

        return {
          cached,
          mainThreadCallsDuringService,
          mainThreadCallsWhenCalledDirectly,
          workerScripts,
        }
      } finally {
        scope.Worker = OriginalWorker
        for (const [name, original] of Object.entries(originals)) {
          scope.WebAssembly[name] = original
        }
      }
    },
    {
      thumbnailsPath: THUMBNAILS_MODULE_PATH,
      fallbackPath: FALLBACK_MODULE_PATH,
      bytes: fixture('slow.jp2'),
    },
  )

  // The fallback really did run and produce a tile — without this the checks below would be
  // satisfied by doing nothing at all.
  expect(result.cached).toBe(true)
  expect(result.workerScripts.length).toBeGreaterThan(0)
  expect(result.mainThreadCallsDuringService).toEqual([])
  expect(result.mainThreadCallsWhenCalledDirectly.length).toBeGreaterThan(0)
})
