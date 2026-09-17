// T27 — the PNG path (docs/assumptions.md D8; Functional Design R-Q11, R-Q13, R-Q14; Technical
// Design §7.3, §7.6).
//
// Everything below runs against the modules that ship — src/pipeline/stages/png.ts and png-plan.ts —
// served by a Vite server rooted at the repository with its own config, in Chromium, Firefox and
// WebKit. Nothing here reimplements a decision the pipeline makes.
//
// What it measures:
//
//   D8  "ImageMagick's own quantizer is good enough for PNG." Ten representative PNGs — screenshots,
//       logos with alpha, flat illustrations, gradients, a photograph — quantized by libimagequant
//       and by ImageMagick's own quantizer at the same colour count, compared on output size, encode
//       time, palette size and two perceptual metrics against the pre-quantization pixels.
//
//   R-Q13  The 70 floor. For every image, the highest `minimum` libimagequant can actually meet is
//       found by binary search, which is the number that decides whether the floor is reachable at
//       all; and at the lowest reachable slider value (10 → mapped 70) the output is checked for
//       banding with a step metric the source itself calibrates.
//
//   R-Q14  How often the quantized candidate loses to the lossless one, and by how much.
//
//   §7.3  libimagequant's `speed` (1 is maximum effort here, 10 the least, 4 the library default)
//       and `target` (the mapped value against 100), swept across the same set; and oxipng's `level`
//       curve and its `optimiseAlpha` option, on one representative frame each.
//
//   The oxipng build that actually initialises inside a Worker, on each engine, by reproducing
//   `@jsquash/oxipng`'s own `init()` predicate.
//
// The ten images are generated in the page from committed code and are identical on every engine.
// Real photographs and real PNGs are added when PHOTO_FIXTURES_DIR is set and that half reports
// `skipped` with its reason when it is not. No filename, path or image content from that directory
// reaches results.json — files are handed to the page through a numbered route, and only dimensions,
// counts, sizes, times and metrics are recorded.
//
// This project has no dependencies of its own: it uses the repository's installed Vite, Playwright
// and codec packages, so what it measures is exactly the build the app ships.
//
// Run from this directory: pnpm test. T27_QUICK=1 runs Chromium only and skips the sweeps and the
// real-file set.

import { chromium, firefox, webkit } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { installGenerators } from './generators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const QUICK = Boolean(process.env.T27_QUICK)
const PORT = 5187
const BASE = `http://localhost:${PORT}`
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** The ten D8 categories. Long edge kept modest so three engines finish in a few minutes. */
const GENERATED = [
  'screenshot-light',
  'screenshot-dark',
  'logo-hard-alpha',
  'logo-soft-alpha',
  'illustration-flat',
  'illustration-shaded',
  'gradient-sky',
  'gradient-mono',
  'diagram',
  'photo-synthetic',
]

const IMAGE_WIDTH = 1000
const IMAGE_HEIGHT = 750

/** Slider values measured per image. 10 is R-Q13's lowest reachable setting; 84 is R-Q12's edge. */
const SLIDERS = [10, 40, 70, 84]

/** How many real files of each kind to sample, when PHOTO_FIXTURES_DIR is set. */
const REAL_JPEGS = 6
const REAL_PNGS = 8

function readEnvVar(name) {
  let content
  try {
    content = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim() || null
  }
  return null
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** Files are served to the page by number only, so no path reaches the browser. */
async function serveFiles(page, files) {
  await page.route(`${BASE}/__t27/*`, async (route) => {
    const index = Number(route.request().url().split('/').pop())
    await route.fulfill({
      body: readFileSync(files[index]),
      contentType: 'application/octet-stream',
    })
  })
}

/** Evenly spaced picks from a list sorted by size, so the sample spans detail rather than clustering. */
function spread(files, count) {
  if (files.length <= count) return files
  const sorted = [...files].sort((a, b) => statSync(a).size - statSync(b).size)
  return Array.from({ length: count }, (_, index) =>
    sorted[Math.floor(((index + 0.5) * sorted.length) / count)],
  )
}

// ---------------------------------------------------------------------------------------------
// In-page measurement.
// ---------------------------------------------------------------------------------------------

async function inPageMeasure({ kind, url, sliders, width, height }) {
  const { decodeFrame } = await import('/src/pipeline/stages/decode.ts')
  const { applyResize } = await import('/src/pipeline/stages/resize.ts')
  const { encodePng } = await import('/src/pipeline/stages/png.ts')
  const plan = await import('/src/pipeline/stages/png-plan.ts')
  const loader = await import('/src/pipeline/codecs/loader.ts')
  const magick = await loader.ensureImageMagick()
  const quantizer = await loader.ensureQuantizer()
  const oxipng = await loader.ensureOxipng()
  const {
    AlphaAction,
    ColorSpace,
    DitherMethod,
    ErrorMetric,
    ImageMagick,
    MagickFormat,
    MagickReadSettings,
    QuantizeSettings,
  } = magick

  let frame
  if (url) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    frame = await decodeFrame(bytes)
    frame = await applyResize(frame, { kind: 'fit-long-edge', pixels: 1600 })
  } else {
    frame = window.t27Generate(kind, width, height)
  }

  const { isOpaque } = await import('/src/pipeline/stages/encode-plan.ts')
  const source = frame.pixels.slice()
  const opaque = isOpaque(frame.pixels)

  const readSettings = () =>
    new MagickReadSettings({
      format: MagickFormat.Rgba,
      width: frame.width,
      height: frame.height,
      depth: 8,
    })

  const oxi = async (png) =>
    new Uint8Array(
      await oxipng.default(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        plan.oxipngOptions(),
      ),
    )

  const decodePixels = (png) =>
    ImageMagick.read(png, (image) =>
      image.getPixels((c) => c.toByteArray(0, 0, image.width, image.height, 'RGBA')),
    )

  /**
   * SSIM (1 - ImageMagick's distortion, higher is better), normalised RMSE, and peak 0-255 errors.
   *
   * `peak` is over every pixel and is only meaningful on an opaque image: a quantizer is free to
   * move the colour of a pixel nobody can see, so a translucent image scores a large `peak` for a
   * difference that is invisible. `peakOpaque` is the same measure restricted to fully opaque
   * source pixels, and `peakAlpha` is the largest alpha error on its own. ImageMagick's SSIM has
   * the same blind spot in the other direction: it reads the colour *under* fully transparent
   * pixels, which is why the hard-alpha logo scores 0.69 against a pixel-identical output.
   */
  const metrics = (png) => {
    const decoded = decodePixels(png)
    let peak = 0
    let peakOpaque = 0
    let peakAlpha = 0
    for (let i = 0; i < source.length; i += 4) {
      const alphaDelta = Math.abs(source[i + 3] - decoded[i + 3])
      if (alphaDelta > peakAlpha) peakAlpha = alphaDelta
      if (source[i + 3] === 0 && decoded[i + 3] === 0) continue
      for (let band = 0; band < 4; band += 1) {
        const delta = Math.abs(source[i + band] - decoded[i + band])
        if (delta > peak) peak = delta
        if (source[i + 3] === 255 && band < 3 && delta > peakOpaque) peakOpaque = delta
      }
    }

    let ssim = null
    let rmse = null
    ImageMagick.read(source, readSettings(), (original) => {
      ImageMagick.read(png, (other) => {
        ssim = 1 - original.compare(other, ErrorMetric.StructuralSimilarity)
        rmse = original.compare(other, ErrorMetric.RootMeanSquared)
      })
    })

    // Banding: the largest step the output introduced across a horizontal pair whose source step was
    // at most one unit. On a smooth ramp this is exactly the height of a visible band edge.
    let banding = 0
    const stride = frame.width * 4
    for (let y = 0; y < frame.height; y += 4) {
      for (let x = 1; x < frame.width; x += 1) {
        const i = y * stride + x * 4
        for (let band = 0; band < 3; band += 1) {
          const sourceStep = Math.abs(source[i + band] - source[i - 4 + band])
          if (sourceStep > 1) continue
          const outStep = Math.abs(decoded[i + band] - decoded[i - 4 + band])
          if (outStep > banding) banding = outStep
        }
      }
    }

    return { ssim, rmse, peak, peakOpaque, peakAlpha, banding }
  }

  /** The pipeline's own lossless candidate, so every row is against the same reference. */
  const losslessBytes = await (async () => {
    const t0 = performance.now()
    const written = ImageMagick.read(frame.pixels, readSettings(), (image) => {
      if (opaque) image.alpha(AlphaAction.Off)
      return image.write(MagickFormat.Png, (d) => d.slice())
    })
    const optimised = await oxi(plan.rewritePngChunks(written, { kind: 'drop' }))
    return { bytes: optimised.length, ms: Math.round(performance.now() - t0), file: optimised }
  })()

  /** The highest `minimum` libimagequant can actually meet, by binary search. R-Q13's real number. */
  const achievedQuality = (speed) => {
    const attempt = (minimum) => {
      const instance = new quantizer.Imagequant()
      try {
        instance.set_speed(speed)
        instance.set_quality(minimum, plan.QUANTIZER_TARGET_QUALITY)
        instance.process(
          new quantizer.ImagequantImage(frame.pixels, frame.width, frame.height, 0),
        )
        return true
      } catch (error) {
        if (plan.isQuantizerAbort(error)) return false
        throw error
      } finally {
        instance.free()
      }
    }
    if (!attempt(0)) return null
    let low = 0
    let high = 100
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (attempt(mid)) low = mid
      else high = mid - 1
    }
    return low
  }

  /** One libimagequant run at an explicit minimum/target/speed, finished the way the stage finishes. */
  const runQuantizer = async ({ minimum, target, speed }) => {
    const instance = new quantizer.Imagequant()
    const t0 = performance.now()
    let raw
    try {
      instance.set_speed(speed)
      instance.set_quality(minimum, target)
      raw = instance.process(new quantizer.ImagequantImage(frame.pixels, frame.width, frame.height, 0))
    } catch (error) {
      if (plan.isQuantizerAbort(error)) return { aborted: true }
      throw error
    } finally {
      instance.free()
    }
    const quantMs = Math.round(performance.now() - t0)
    const finished = await oxi(plan.rewritePngChunks(raw, { kind: 'drop' }))
    return {
      aborted: false,
      bytes: finished.length,
      rawBytes: raw.length,
      ms: quantMs,
      totalMs: Math.round(performance.now() - t0),
      palette: plan.readPaletteSize(finished),
      ...metrics(finished),
    }
  }

  /** ImageMagick's own quantizer at a given colour count, finished identically. D8's comparison. */
  const runImageMagickQuantizer = async (colors) => {
    const t0 = performance.now()
    const written = ImageMagick.read(frame.pixels, readSettings(), (image) => {
      if (opaque) image.alpha(AlphaAction.Off)
      const settings = new QuantizeSettings()
      settings.colors = colors
      settings.colorSpace = ColorSpace.sRGB
      settings.ditherMethod = DitherMethod.FloydSteinberg
      image.quantize(settings)
      return image.write(MagickFormat.Png, (d) => d.slice())
    })
    const quantMs = Math.round(performance.now() - t0)
    const finished = await oxi(plan.rewritePngChunks(written, { kind: 'drop' }))
    return {
      colors,
      bytes: finished.length,
      ms: quantMs,
      totalMs: Math.round(performance.now() - t0),
      palette: plan.readPaletteSize(finished),
      ...metrics(finished),
    }
  }

  const out = {
    kind: kind ?? 'real',
    width: frame.width,
    height: frame.height,
    opaque,
    sourceBytes: frame.pixels.length,
    lossless: { bytes: losslessBytes.bytes, ms: losslessBytes.ms },
    achievedQuality: {
      atShippedSpeed: achievedQuality(plan.QUANTIZER_SPEED),
      atSpeed1: achievedQuality(1),
      atSpeed4: achievedQuality(4),
    },
    sliders: {},
  }

  for (const slider of sliders) {
    const mapped = 70 + ((slider - 10) * 30) / 90
    const quality = { kind: 'quality', value: mapped, lossless: mapped >= 95 }
    const settings = plan.quantizerSettings(quality)

    const t0 = performance.now()
    const staged = await encodePng(frame, quality)
    const stageMs = Math.round(performance.now() - t0)

    const row = {
      mapped: settings.minimum,
      stage: {
        branch: staged.branch,
        branches: staged.branches,
        aborted: staged.quantizeAborted,
        bytes: staged.bytes.length,
        sizes: staged.sizes,
        palette: staged.paletteColors,
        caveats: staged.caveats.map((caveat) => caveat.kind),
        ms: stageMs,
      },
    }

    // D8's head-to-head runs at the lowest reachable setting only — the point R-Q13 is about, and
    // the one where a weak quantizer shows. The other sliders record what the pipeline actually did.
    if (slider === sliders[0]) {
      row.libimagequant = await runQuantizer(settings)
      const colors =
        row.libimagequant.aborted || row.libimagequant.palette === null
          ? 256
          : row.libimagequant.palette
      row.imagemagick = await runImageMagickQuantizer(colors)
    }

    out.sliders[slider] = row
  }

  return out
}

/** §7.3's two sweeps, on the generated set only. Content decides these, not the engine. */
async function inPageSweeps({ kind, width, height }) {
  const plan = await import('/src/pipeline/stages/png-plan.ts')
  const loader = await import('/src/pipeline/codecs/loader.ts')
  const magick = await loader.ensureImageMagick()
  const quantizer = await loader.ensureQuantizer()
  const oxipng = await loader.ensureOxipng()
  const { ErrorMetric, ImageMagick, MagickFormat, MagickReadSettings } = magick

  const frame = window.t27Generate(kind, width, height)
  const source = frame.pixels.slice()
  const readSettings = () =>
    new MagickReadSettings({
      format: MagickFormat.Rgba,
      width: frame.width,
      height: frame.height,
      depth: 8,
    })

  const oxi = async (png) =>
    new Uint8Array(
      await oxipng.default(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        plan.oxipngOptions(),
      ),
    )

  const ssimOf = (png) => {
    let ssim = null
    ImageMagick.read(source, readSettings(), (original) => {
      ImageMagick.read(png, (other) => {
        ssim = 1 - original.compare(other, ErrorMetric.StructuralSimilarity)
      })
    })
    return ssim
  }

  const run = async (minimum, target, speed) => {
    const instance = new quantizer.Imagequant()
    const t0 = performance.now()
    let raw
    try {
      instance.set_speed(speed)
      instance.set_quality(minimum, target)
      raw = instance.process(new quantizer.ImagequantImage(frame.pixels, frame.width, frame.height, 0))
    } catch (error) {
      if (plan.isQuantizerAbort(error)) return { aborted: true }
      throw error
    } finally {
      instance.free()
    }
    const ms = Math.round(performance.now() - t0)
    const finished = await oxi(plan.rewritePngChunks(raw, { kind: 'drop' }))
    return {
      aborted: false,
      bytes: finished.length,
      ms,
      palette: plan.readPaletteSize(finished),
      ssim: ssimOf(finished),
    }
  }

  const speeds = {}
  for (const speed of [1, 2, 3, 4, 5, 6, 8, 10]) {
    speeds[speed] = await run(70, plan.QUANTIZER_TARGET_QUALITY, speed)
  }

  const targets = {}
  for (const slider of [10, 40, 70, 84]) {
    const mapped = Math.round(70 + ((slider - 10) * 30) / 90)
    targets[slider] = {
      mapped,
      targetMapped: await run(mapped, mapped, plan.QUANTIZER_SPEED),
      target100: await run(mapped, 100, plan.QUANTIZER_SPEED),
    }
  }

  return { kind, speeds, targets }
}

/**
 * §7.3's two remaining settings, on one representative frame: oxipng's level curve, and whether
 * `optimiseAlpha` is worth having on either branch.
 *
 * Both are measured on the file the pipeline actually produces — ImageMagick's PNG with its metadata
 * already stripped — because ImageMagick's own `tEXt`, `tIME`, `cHRM` and duplicate `zTXt` profile
 * are incompressible and would flatten the level curve by dominating the file.
 *
 * `optimiseAlpha` is measured on a frame whose fully transparent region holds noise, which is its
 * best case, and the accompanying `exact` figures are the largest pixel difference the option causes
 * against the source — the reason it stays off on a branch that promises losslessness.
 */
async function inPageEffort({ width, height }) {
  const plan = await import('/src/pipeline/stages/png-plan.ts')
  const loader = await import('/src/pipeline/codecs/loader.ts')
  const magick = await loader.ensureImageMagick()
  const quantizer = await loader.ensureQuantizer()
  const oxipng = await loader.ensureOxipng()
  const { AlphaAction, ImageMagick, MagickFormat, MagickReadSettings } = magick

  const write = (frame, opaque) =>
    ImageMagick.read(
      frame.pixels,
      new MagickReadSettings({ format: MagickFormat.Rgba, width: frame.width, height: frame.height, depth: 8 }),
      (image) => {
        if (opaque) image.alpha(AlphaAction.Off)
        return image.write(MagickFormat.Png, (data) => data.slice())
      },
    )

  const oxi = async (png, options) =>
    new Uint8Array(
      await oxipng.default(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), options),
    )

  const decoded = (png) =>
    ImageMagick.read(png, (image) =>
      image.getPixels((c) => c.toByteArray(0, 0, image.width, image.height, 'RGBA')),
    )

  /** Largest difference against the source, split by whether the source pixel was visible at all. */
  const drift = (frame, png) => {
    const out = decoded(png)
    let visible = 0
    let underTransparent = 0
    for (let i = 0; i < frame.pixels.length; i += 4) {
      for (let band = 0; band < 3; band += 1) {
        const delta = Math.abs(frame.pixels[i + band] - out[i + band])
        if (frame.pixels[i + 3] === 0) underTransparent = Math.max(underTransparent, delta)
        else visible = Math.max(visible, delta)
      }
      const alpha = Math.abs(frame.pixels[i + 3] - out[i + 3])
      if (alpha > visible) visible = alpha
    }
    return { visible, underTransparent }
  }

  // The level curve, on a photographic frame: enough entropy that deflate has real work to do.
  const photo = window.t27Generate('photo-synthetic', width, height)
  const stripped = plan.rewritePngChunks(write(photo, true), { kind: 'drop' })
  const levels = {}
  for (const level of [0, 1, 2, 3, 4, 6]) {
    const t0 = performance.now()
    const out = await oxi(stripped, { level, interlace: false, optimiseAlpha: false })
    levels[level] = { bytes: out.length, ms: Math.round(performance.now() - t0) }
  }

  // A frame whose transparent region holds noise: `optimiseAlpha`'s best case by construction.
  const noisyAlpha = (() => {
    let seed = 7
    const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0), seed / 4294967296)
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (height / 3) ** 2
        pixels[i] = inside ? 220 : Math.floor(next() * 256)
        pixels[i + 1] = inside ? 60 : Math.floor(next() * 256)
        pixels[i + 2] = inside ? 40 : Math.floor(next() * 256)
        pixels[i + 3] = inside ? 255 : 0
      }
    }
    return { width, height, pixels, colour: { kind: 'untagged' }, sourceOrientation: { kind: 'absent' } }
  })()

  const losslessAlpha = plan.rewritePngChunks(write(noisyAlpha, false), { kind: 'drop' })
  const alphaOff = await oxi(losslessAlpha, { level: plan.OXIPNG_LEVEL, interlace: false, optimiseAlpha: false })
  const alphaOn = await oxi(losslessAlpha, { level: plan.OXIPNG_LEVEL, interlace: false, optimiseAlpha: true })

  // The same frame down the quantized branch, where libimagequant has already collapsed every fully
  // transparent pixel onto one palette entry.
  let quantizedAlpha = null
  const instance = new quantizer.Imagequant()
  try {
    instance.set_speed(plan.QUANTIZER_SPEED)
    instance.set_quality(70, plan.QUANTIZER_TARGET_QUALITY)
    const raw = instance.process(
      new quantizer.ImagequantImage(noisyAlpha.pixels, width, height, 0),
    )
    const cleaned = plan.rewritePngChunks(raw, { kind: 'drop' })
    quantizedAlpha = {
      off: (await oxi(cleaned, { level: plan.OXIPNG_LEVEL, interlace: false, optimiseAlpha: false })).length,
      on: (await oxi(cleaned, { level: plan.OXIPNG_LEVEL, interlace: false, optimiseAlpha: true })).length,
    }
  } catch (error) {
    if (!plan.isQuantizerAbort(error)) throw error
    quantizedAlpha = { aborted: true }
  } finally {
    instance.free()
  }

  return {
    oxipngLevels: { subject: 'photo-synthetic', width, height, strippedBytes: stripped.length, levels },
    optimiseAlpha: {
      subject: 'noise under a fully transparent field',
      width,
      height,
      lossless: {
        off: alphaOff.length,
        on: alphaOn.length,
        driftOff: drift(noisyAlpha, alphaOff),
        driftOn: drift(noisyAlpha, alphaOn),
      },
      quantized: quantizedAlpha,
    },
  }
}

/**
 * `@jsquash/oxipng`'s `init()` picks its multi-threaded build only inside a Worker, with
 * `hardwareConcurrency > 1`, and when `wasm-feature-detect`'s `threads()` passes. This reproduces
 * that predicate — including the `SharedArrayBuffer` postMessage `threads()` actually performs —
 * inside a real Worker, which is where the pipeline runs.
 */
async function inPageThreads() {
  const source = `self.addEventListener('message', () => {
    let constructs = false
    let postable = false
    try { new SharedArrayBuffer(1); constructs = true } catch {}
    try { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); postable = true } catch {}
    const threadedModule = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11])
    let validates = false
    try { validates = WebAssembly.validate(threadedModule) } catch {}
    self.postMessage({
      isWorker: typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope,
      hardwareConcurrency: navigator.hardwareConcurrency,
      sharedArrayBufferConstructs: constructs,
      sharedArrayBufferPostable: postable,
      threadedWasmValidates: validates,
      threadsPredicate: postable && validates,
      crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
    })
  })`
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const worker = new Worker(url)
  const result = await new Promise((resolve) => {
    worker.addEventListener('message', (event) => resolve(event.data))
    worker.postMessage('go')
  })
  worker.terminate()
  URL.revokeObjectURL(url)

  return {
    worker: result,
    page: { crossOriginIsolated: globalThis.crossOriginIsolated ?? null },
    build: result.isWorker && result.hardwareConcurrency > 1 && result.threadsPredicate
      ? 'multi-threaded'
      : 'single-threaded',
  }
}

// ---------------------------------------------------------------------------------------------

function summarise(images) {
  const rows = images.filter((image) => image.sliders)
  const atSlider = (slider) => rows.map((image) => image.sliders[slider]).filter(Boolean)

  const summary = {}
  for (const slider of SLIDERS) {
    const entries = atSlider(slider)
    const aborted = entries.filter((entry) => entry.stage.aborted)
    const quantizedKept = entries.filter((entry) => entry.stage.branch === 'quantized')
    const bothRan = entries.filter((entry) => entry.stage.sizes.quantized !== null)
    const losslessWon = bothRan.filter((entry) => entry.stage.branch === 'lossless')

    summary[slider] = {
      images: entries.length,
      quantizerAborted: aborted.length,
      quantizedKept: quantizedKept.length,
      losslessKeptDespiteBothRunning: losslessWon.length,
      meanQuantizedSaving:
        quantizedKept.length === 0
          ? null
          : Number(
              (
                quantizedKept.reduce(
                  (sum, entry) => sum + 1 - entry.stage.bytes / entry.stage.sizes.lossless,
                  0,
                ) / quantizedKept.length
              ).toFixed(4),
            ),
      worstLosslessWinMargin:
        losslessWon.length === 0
          ? null
          : Math.max(
              ...losslessWon.map(
                (entry) => entry.stage.sizes.quantized - entry.stage.sizes.lossless,
              ),
            ),
    }
  }

  // D8: libimagequant against ImageMagick's own quantizer at the same colour count, slider 10.
  const d8 = atSlider(10)
    .filter((entry) => entry.libimagequant && !entry.libimagequant.aborted)
    .map((entry) => ({
      sizeRatio: Number((entry.libimagequant.bytes / entry.imagemagick.bytes).toFixed(4)),
      ssimGain: Number((entry.libimagequant.ssim - entry.imagemagick.ssim).toFixed(5)),
      rmseRatio: Number((entry.libimagequant.rmse / (entry.imagemagick.rmse || 1e-9)).toFixed(4)),
    }))

  const mean = (values) =>
    values.length === 0 ? null : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(5))

  return {
    bySlider: summary,
    d8: {
      comparable: d8.length,
      meanSizeRatioLibimagequantOverImageMagick: mean(d8.map((r) => r.sizeRatio)),
      meanSsimGainForLibimagequant: mean(d8.map((r) => r.ssimGain)),
      meanRmseRatioLibimagequantOverImageMagick: mean(d8.map((r) => r.rmseRatio)),
      libimagequantSmallerOnCount: d8.filter((r) => r.sizeRatio < 1).length,
      libimagequantHigherSsimOnCount: d8.filter((r) => r.ssimGain > 0).length,
    },
    achievedQuality: {
      atShippedSpeed: rows.map((image) => image.achievedQuality.atShippedSpeed),
      belowSeventyCount: rows.filter(
        (image) =>
          image.achievedQuality.atShippedSpeed !== null &&
          image.achievedQuality.atShippedSpeed < 70,
      ).length,
    },
  }
}

async function main() {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, 'vite.config.ts'),
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  })
  await server.listen()

  const shipped = await server.ssrLoadModule('/src/pipeline/stages/png-plan.ts')

  const fixturesDir = readEnvVar('PHOTO_FIXTURES_DIR')
  const all = fixturesDir ? walk(fixturesDir) : []
  const sampledJpegs = QUICK ? [] : spread(all.filter((file) => /\.jpe?g$/i.test(file)), REAL_JPEGS)
  const sampledPngs = QUICK ? [] : spread(all.filter((file) => /\.png$/i.test(file)), REAL_PNGS)
  const realFiles = [...sampledJpegs, ...sampledPngs]

  const results = {
    generatedAt: new Date().toISOString(),
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? null },
    shippedSettings: {
      oxipngLevel: shipped.OXIPNG_LEVEL,
      quantizerSpeed: shipped.QUANTIZER_SPEED,
      quantizerTarget: shipped.QUANTIZER_TARGET_QUALITY,
      oxipngOptions: shipped.oxipngOptions(),
    },
    generated: { count: GENERATED.length, width: IMAGE_WIDTH, height: IMAGE_HEIGHT },
    realFiles: QUICK
      ? { skipped: 'T27_QUICK' }
      : fixturesDir
        ? { jpegs: sampledJpegs.length, pngs: sampledPngs.length }
        : { skipped: 'PHOTO_FIXTURES_DIR unset' },
    oxipngBuild: {},
    engines: {},
    sweeps: null,
    effort: null,
    summary: {},
  }

  try {
    for (const [name, engine] of Object.entries(ENGINES)) {
      const browser = await engine.launch()
      const page = await browser.newPage()
      await page.addInitScript(installGenerators)
      await serveFiles(page, realFiles)
      await page.goto(`${BASE}/`, { waitUntil: 'load' })

      results.oxipngBuild[name] = await page.evaluate(inPageThreads)
      console.log(name, 'oxipng build', JSON.stringify(results.oxipngBuild[name].build))

      const images = []
      for (const kind of GENERATED) {
        const measured = await page.evaluate(inPageMeasure, {
          kind,
          sliders: SLIDERS,
          width: IMAGE_WIDTH,
          height: IMAGE_HEIGHT,
        })
        images.push(measured)
        console.log(
          name,
          kind,
          `Q*=${measured.achievedQuality.atShippedSpeed}`,
          `lossless=${measured.lossless.bytes}`,
          `s10=${measured.sliders[10].stage.branch}/${measured.sliders[10].stage.bytes}`,
        )
      }

      for (let index = 0; index < realFiles.length; index += 1) {
        try {
          const measured = await page.evaluate(inPageMeasure, {
            url: `${BASE}/__t27/${index}`,
            sliders: SLIDERS,
          })
          images.push({ ...measured, kind: index < sampledJpegs.length ? 'real-jpeg' : 'real-png' })
          console.log(
            name,
            `real ${index + 1}/${realFiles.length}`,
            `Q*=${measured.achievedQuality.atShippedSpeed}`,
            `s10=${measured.sliders[10].stage.branch}`,
          )
        } catch (error) {
          images.push({ kind: 'real', failed: String(error).slice(0, 160) })
        }
      }

      results.engines[name] = { images }
      results.summary[name] = summarise(images)
      console.log(name, 'summary', JSON.stringify(results.summary[name], null, 2))
      await browser.close()
    }

    if (QUICK) {
      results.sweeps = { skipped: 'T27_QUICK' }
      results.effort = { skipped: 'T27_QUICK' }
    } else {
      const browser = await chromium.launch()
      const page = await browser.newPage()
      await page.addInitScript(installGenerators)
      await page.goto(`${BASE}/`, { waitUntil: 'load' })
      const sweeps = []
      for (const kind of GENERATED) {
        sweeps.push(
          await page.evaluate(inPageSweeps, { kind, width: IMAGE_WIDTH, height: IMAGE_HEIGHT }),
        )
        console.log('sweep', kind, 'done')
      }
      results.sweeps = { engine: 'chromium', images: sweeps }

      results.effort = {
        engine: 'chromium',
        ...(await page.evaluate(inPageEffort, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT })),
      }
      console.log('effort', JSON.stringify(results.effort, null, 2))
      await browser.close()
    }
  } finally {
    await server.close()
  }

  writeFileSync(join(__dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log('wrote results.json')
}

await main()
