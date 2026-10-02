// T30 — D1: "Size-target search cost" (docs/assumptions.md D1; Functional Design R-Q2, R-Q3, R-Q4;
// Technical Design §7.5).
//
// D1's own note says what this has to settle: "AVIF at default speed is prohibitive, but see D7: at
// speed 9 the same search would be roughly 3 seconds, which changes the conclusion. R-Q4 should be
// decided after re-measuring with the speed define applied." So the headline measurement is the
// shipped search, at §7.3's effort settings, on a 1600x1200 photograph — the same shape D1 used —
// with the iteration count and wall time per format. R-Q4's exclusion list is read off that table.
//
// Five original T30 things are measured, plus T36-A's optional recovery-only pass:
//
//   1. **`d1`** — the shipped search to a 150 KB target on a 1600x1200 photographic subject, for
//      every output format. Directly comparable to D1's row, and the table §7.5 carries.
//   2. **`searchCost`** — iterations and wall time across a range of targets and content: an
//      interior target, an unreachable one (R-Q3) and a generous one (R-Q2). This is what says
//      whether the iteration *count* is content-dependent as well as the time.
//   3. **`avifSpeed`** — the same search run against ImageMagick directly at its default AVIF speed,
//      so that the "roughly 3 seconds" in D1 is replaced by a measured pair rather than an estimate.
//      Chromium only: it is the one measurement here that is about the codec rather than the search.
//   4. **`pngTargetAxis`** — §7.5 says "a PNG size search wants `target` as its variable". That is a
//      recommendation nothing had tested, so it is tested here: libimagequant's `minimum` pinned at
//      R-Q11's floor of 70 and its `target` swept, recorded as bytes per target. A binary search
//      needs the axis to be monotone; this says whether it is.
//   5. **`animated`** — the same search over animations, where one iteration re-encodes every frame.
//      R-Q10 forbids the other lever, so this is the whole cost of an animated size target.
//   6. **`dimensionRecovery`** — with `T36A_RECOVERY_ONLY=1`, the bounded quality-floor recovery
//      planner plus its final quality search, on the same still corpus in all engines.
//
// Subjects are generated in the page from parameters, so nothing megabyte-sized crosses into the
// browser, plus the committed animated fixtures and — when PHOTO_FIXTURES_DIR is set — real
// photographs fitted to 1600 px through the shipped resize stage. Only dimensions, byte counts and
// times are ever recorded.
//
// Run from this directory: pnpm install && pnpm test. T30_QUICK=1 runs Chromium only.

import { chromium, firefox, webkit } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'animated')
const QUICK = Boolean(process.env.T30_QUICK)
const RECOVERY_ONLY = Boolean(process.env.T36A_RECOVERY_ONLY)
const PORT = 5188
const BASE = `http://localhost:${PORT}`
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** D1's own target, in bytes, on D1's own image size. */
const D1_TARGET_BYTES = 150 * 1024

const MODULES = {
  size: '/src/pipeline/stages/size.ts',
  sizePlan: '/src/pipeline/stages/size-plan.ts',
  dimensionRecovery: '/src/pipeline/stages/dimension-recovery-plan.ts',
  encode: '/src/pipeline/stages/encode.ts',
  png: '/src/pipeline/stages/png.ts',
  pngPlan: '/src/pipeline/stages/png-plan.ts',
  gif: '/src/pipeline/stages/gif.ts',
  frame: '/src/pipeline/stages/frame.ts',
  decode: '/src/pipeline/stages/decode.ts',
  resize: '/src/pipeline/stages/resize.ts',
  animation: '/src/pipeline/stages/animation.ts',
  loader: '/src/pipeline/codecs/loader.ts',
  job: '/src/domain/job.ts',
}

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
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(() => resolve())
        .catch((error) => {
          if (Date.now() > deadline) reject(error)
          else setTimeout(attempt, 150)
        })
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------------------------
// Subjects, as parameters the page turns into pixels.
// ---------------------------------------------------------------------------------------------

const STILL_SUBJECTS = [
  // D1's shape: a photographic 1600x1200. The row every figure in §7.5 is quoted from.
  { id: 'photo-1600', kind: 'photo', width: 1600, height: 1200 },
  // Content a palette holds: this is where PNG's axis has two values rather than a curve, and where
  // WebP's lossless attempt wins (R-Q6).
  { id: 'shaded-1600', kind: 'shaded', width: 1600, height: 1200 },
  // Flat colour: the inert end of every axis. Small, because the point is the iteration count.
  { id: 'flat-600', kind: 'flat', width: 600, height: 450 },
]

const ANIMATED_SUBJECTS = [
  { id: 'anim-6f.gif', file: 'anim-6f.gif', sourceFormat: 'gif' },
  { id: 'anim-scene.gif', file: 'anim-scene.gif', sourceFormat: 'gif' },
  { id: 'anim-16f-400.webp', file: 'anim-16f-400.webp', sourceFormat: 'webp' },
]

const STILL_FORMATS = ['jpeg', 'webp', 'avif', 'png', 'gif']
const ANIMATED_FORMATS = ['webp', 'png', 'gif']

/**
 * libimagequant's `target`, swept with `minimum` pinned at R-Q11's floor of 70 (measurement 4).
 *
 * The sweep starts at 70 and not lower because it cannot: `set_quality(minimum, target)` raises
 * `VALUE_OUT_OF_RANGE` for a target below the minimum, so with R-Q11's floor in place the whole of
 * the axis §7.5 proposed searching is the 31 points from 70 to 100.
 */
const PNG_TARGET_SWEEP = [70, 75, 80, 85, 90, 95, 100]

/**
 * Everything that happens in the page for one still subject: build the frame once, then run the
 * shipped search at several targets for every format, and record what each one cost.
 */
const MEASURE_STILL = async ({
  modules,
  subject,
  formats,
  d1TargetBytes,
  withPngAxis,
  pngTargetSweep,
  recoveryOnly,
}) => {
  const size = await import(/* @vite-ignore */ modules.size)
  const dimensionRecoveryPlan = await import(/* @vite-ignore */ modules.dimensionRecovery)
  const encode = await import(/* @vite-ignore */ modules.encode)
  const pngStage = await import(/* @vite-ignore */ modules.png)
  const pngPlan = await import(/* @vite-ignore */ modules.pngPlan)
  const decode = await import(/* @vite-ignore */ modules.decode)
  const resizeStage = await import(/* @vite-ignore */ modules.resize)
  const loader = await import(/* @vite-ignore */ modules.loader)
  const job = await import(/* @vite-ignore */ modules.job)

  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)))
  const noiseAt = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0
    h = (h ^ (h >>> 13)) * 1274126177
    return (h ^ (h >>> 16)) & 0xff
  }

  function generatedFrame(kind, width, height) {
    const pixels = new Uint8Array(width * height * 4)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        let rgba

        if (kind === 'flat') {
          const block = Math.floor((x * 3) / width) + 3 * Math.floor((y * 2) / height)
          const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8
          rgba = border
            ? [20, 20, 20, 255]
            : [30 + block * 30, 200 - block * 20, (block * 57) & 255, 255]
        } else if (kind === 'shaded') {
          const u = x / width
          const v = y / height
          const shade = 0.55 + 0.45 * Math.sin(u * 3.1) * Math.cos(v * 2.3)
          const base = v > 0.55 + 0.1 * Math.sin(u * 7) ? [76, 122, 84] : [140, 196, 230]
          rgba = [clamp(base[0] * shade), clamp(base[1] * shade), clamp(base[2] * shade), 255]
        } else {
          const noise = ((noiseAt(x, y) % 41) - 20) * 1.0
          rgba = [
            clamp((x * 255) / width + noise),
            clamp((y * 255) / height + noise),
            clamp(((x + y) * 255) / (width + height) + noise),
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

  let frame
  if (subject.kind === 'file') {
    // A real photograph, fitted to 1600 px through the shipped resize stage, as T26 and T28 do.
    const decoded = await decode.decodeFrame(new Uint8Array(subject.bytes))
    frame = await resizeStage.applyResize(decoded, { kind: 'fit-long-edge', pixels: 1600 })
  } else {
    frame = generatedFrame(subject.kind, subject.width, subject.height)
  }

  const quality = (slider, format) => job.qualityForSlider(slider, format)

  const encodeAt = async (format, slider) => {
    if (format === 'png') return (await pngStage.encodePng(frame, quality(slider, 'png'))).bytes
    if (format === 'gif') {
      const gifStage = await import(/* @vite-ignore */ modules.gif)
      const frameModule = await import(/* @vite-ignore */ modules.frame)
      return (
        await gifStage.encodeGif(frameModule.singleFrameAnimation(frame), quality(slider, 'gif'))
      ).bytes
    }
    return (await encode.encodeFrame(frame, format, quality(slider, format))).bytes
  }

  const results = []

  for (const format of formats) {
    // The two ends of the axis, which every target below is expressed against and which are the
    // plateau evidence in their own right.
    const endsStarted = performance.now()
    let low
    let high
    try {
      low = (await encodeAt(format, 10)).byteLength
      high = recoveryOnly ? low : (await encodeAt(format, 100)).byteLength
    } catch (error) {
      results.push({ format, failed: String(error && error.message ? error.message : error) })
      continue
    }
    const endsMs = Math.round(performance.now() - endsStarted)

    // Interior, unreachable (R-Q3) and generous (R-Q2), plus D1's own absolute target.
    const targets = recoveryOnly
      ? []
      : [
          { id: 'interior', targetBytes: Math.round(Math.sqrt(low * high)) },
          { id: 'near-low', targetBytes: Math.round(low * 1.2) },
          { id: 'unreachable', targetBytes: Math.max(1, Math.round(low / 2)) },
          { id: 'generous', targetBytes: Math.round(high * 2) },
          { id: 'd1-150kb', targetBytes: d1TargetBytes },
        ]

    const runs = []
    for (const target of targets) {
      const started = performance.now()
      try {
        const searched = await size.encodeStillToSize(frame, format, target.targetBytes)
        runs.push({
          id: target.id,
          targetBytes: target.targetBytes,
          iterations: searched.probes.length,
          ms: Math.round(performance.now() - started),
          keptBytes: searched.bytes.byteLength,
          slider: searched.slider,
          outcome: searched.kind,
          probes: searched.probes,
          caveats: searched.caveats.map((caveat) => caveat.kind),
        })
      } catch (error) {
        runs.push({
          id: target.id,
          targetBytes: target.targetBytes,
          failed: String(error && error.message ? error.message : error),
          ms: Math.round(performance.now() - started),
        })
      }
    }

    const recoveryStarted = performance.now()
    const recoveryTargetBytes = Math.max(1, Math.round(low / 2))
    let dimensionRecovery
    try {
      const fit = await dimensionRecoveryPlan.searchSmallerDimensions(
        {
          current: { width: frame.width, height: frame.height },
          targetBytes: recoveryTargetBytes,
          achievedBytes: low,
        },
        async (candidate) => {
          const resized = await resizeStage.applyResize(frame, { kind: 'exact', ...candidate })
          const encoded = await size.encodeStillAtSlider(
            resized,
            format,
            dimensionRecoveryPlan.DIMENSION_RECOVERY_MIN_SLIDER,
          )
          return encoded.bytes.byteLength
        },
      )

      if (fit === null) {
        dimensionRecovery = {
          targetBytes: recoveryTargetBytes,
          dimensionProbes: 0,
          qualityProbes: 0,
          fit: false,
          ms: Math.round(performance.now() - recoveryStarted),
        }
      } else {
        const resized = await resizeStage.applyResize(frame, {
          kind: 'exact',
          width: fit.width,
          height: fit.height,
        })
        const final = await size.encodeStillToSize(
          resized,
          format,
          recoveryTargetBytes,
          dimensionRecoveryPlan.DIMENSION_RECOVERY_MIN_SLIDER,
        )
        dimensionRecovery = {
          targetBytes: recoveryTargetBytes,
          width: fit.width,
          height: fit.height,
          outputBytes: final.bytes.byteLength,
          dimensionProbes: fit.probes.length,
          qualityProbes: final.probes.length,
          fit: final.kind === 'fit',
          ms: Math.round(performance.now() - recoveryStarted),
        }
      }
    } catch (error) {
      dimensionRecovery = {
        targetBytes: recoveryTargetBytes,
        failed: String(error && error.message ? error.message : error),
        ms: Math.round(performance.now() - recoveryStarted),
      }
    }

    results.push({ format, endBytes: { low, high }, endsMs, runs, dimensionRecovery })
  }

  // §7.5's PNG recommendation, tested rather than repeated. `minimum` is pinned at R-Q11's floor and
  // `target` is swept; a binary search over this axis needs it to be monotone in the level.
  let pngAxis = null
  if (withPngAxis) {
    try {
    const quantizer = await loader.ensureQuantizer()
    const oxipng = await loader.ensureOxipng()
    const options = pngPlan.oxipngOptions()
    const points = []

    for (const target of pngTargetSweep) {
      const started = performance.now()
      let bytes = null
      let palette = null
      let aborted = false

      const instance = new quantizer.Imagequant()
      try {
        instance.set_speed(pngPlan.QUANTIZER_SPEED)
        instance.set_quality(70, target)
        const image = new quantizer.ImagequantImage(
          frame.pixels,
          frame.width,
          frame.height,
          0,
        )
        const raw = instance.process(image)
        const optimised = new Uint8Array(
          await oxipng.default(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
            options,
          ),
        )
        bytes = optimised.byteLength
        palette = pngPlan.readPaletteSize(optimised)
      } catch (error) {
        if (pngPlan.isQuantizerAbort(error)) aborted = true
        else throw error
      } finally {
        instance.free()
      }

      points.push({ target, bytes, palette, aborted, ms: Math.round(performance.now() - started) })
    }

      pngAxis = { minimum: 70, points }
    } catch (error) {
      // A harness that loses a subject's whole measurement because one sweep point raised is a
      // harness that reports nothing about the failure either (T28).
      pngAxis = { minimum: 70, failed: String(error && error.message ? error.message : error) }
    }
  }

  return {
    id: subject.id,
    width: frame.width,
    height: frame.height,
    sourceBytes: subject.bytes ? subject.bytes.length : null,
    formats: results,
    pngAxis,
  }
}

/** The AVIF comparison D1 asked for: the shipped search against the same search at default speed. */
const MEASURE_AVIF_SPEED = async ({ modules, subject, targetBytes }) => {
  const size = await import(/* @vite-ignore */ modules.size)
  const sizePlan = await import(/* @vite-ignore */ modules.sizePlan)
  const loader = await import(/* @vite-ignore */ modules.loader)
  const job = await import(/* @vite-ignore */ modules.job)
  const encodePlan = await import(/* @vite-ignore */ '/src/pipeline/stages/encode-plan.ts')

  const magick = await loader.ensureImageMagick()
  const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)))
  const noiseAt = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0
    h = (h ^ (h >>> 13)) * 1274126177
    return (h ^ (h >>> 16)) & 0xff
  }

  const { width, height } = subject
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const noise = (noiseAt(x, y) % 41) - 20
      pixels.set(
        [
          clamp((x * 255) / width + noise),
          clamp((y * 255) / height + noise),
          clamp(((x + y) * 255) / (width + height) + noise),
          255,
        ],
        i,
      )
    }
  }
  const frame = {
    width,
    height,
    pixels,
    colour: { kind: 'untagged' },
    sourceOrientation: { kind: 'absent' },
  }

  // The shipped path: §7.3's speed 9.
  const shippedStarted = performance.now()
  const shipped = await size.encodeStillToSize(frame, 'avif', targetBytes)
  const shippedMs = Math.round(performance.now() - shippedStarted)

  // The same search, with ImageMagick's own default speed — the one define changed. Not the shipped
  // stage, deliberately: `encode-plan.ts` has no switch for it, and the point is what the define is
  // worth, which is D7's claim applied to D1's measurement.
  const { ImageMagick, MagickFormat, MagickReadSettings } = magick
  const encodeDefault = async (slider) => {
    const quality = job.qualityForSlider(slider, 'avif')
    const settings = new MagickReadSettings({
      format: MagickFormat.Rgba,
      width,
      height,
      depth: 8,
    })
    const bytes = ImageMagick.read(pixels, settings, (image) => {
      image.quality = Math.min(quality.value, encodePlan.AVIF_MAX_QUALITY)
      if (quality.value > 95) image.settings.setDefine(MagickFormat.Heic, 'chroma', '444')
      return image.write(MagickFormat.Avif, (data) => data.slice())
    })
    return { bytes, caveats: [] }
  }

  const defaultStarted = performance.now()
  const atDefault = await sizePlan.runSizeSearch(
    { targetBytes, band: sizePlan.sizeSearchBand('avif', false) },
    encodeDefault,
  )
  const defaultMs = Math.round(performance.now() - defaultStarted)

  return {
    width,
    height,
    targetBytes,
    speed9: {
      ms: shippedMs,
      iterations: shipped.probes.length,
      keptBytes: shipped.bytes.byteLength,
      slider: shipped.slider,
      outcome: shipped.kind,
    },
    libraryDefault: {
      ms: defaultMs,
      iterations: atDefault.probes.length,
      keptBytes: atDefault.bytes.byteLength,
      slider: atDefault.slider,
      outcome: atDefault.kind,
    },
  }
}

/** The animated search: one iteration is the whole animation, every frame (R-Q10). */
const MEASURE_ANIMATED = async ({ modules, subject, formats }) => {
  const size = await import(/* @vite-ignore */ modules.size)
  const animationStage = await import(/* @vite-ignore */ modules.animation)

  const animation = await animationStage.decodeAnimation(new Uint8Array(subject.bytes))
  const frameCount = animation.frames.length
  const width = animation.frames[0].width
  const height = animation.frames[0].height
  const results = []

  for (const format of formats) {
    const ends = []
    try {
      // The two ends first, so the targets below sit where they are meant to.
      const low = await size.encodeAnimatedToSize(animation, format, 1)
      ends.push(low.bytes.byteLength)
    } catch (error) {
      results.push({ format, failed: String(error && error.message ? error.message : error) })
      continue
    }

    const smallest = ends[0]
    const targets = [
      { id: 'interior', targetBytes: Math.round(smallest * 1.5) },
      { id: 'unreachable', targetBytes: Math.max(1, Math.round(smallest / 2)) },
      { id: 'generous', targetBytes: smallest * 20 },
    ]

    const runs = []
    for (const target of targets) {
      const started = performance.now()
      try {
        const searched = await size.encodeAnimatedToSize(animation, format, target.targetBytes)
        runs.push({
          id: target.id,
          targetBytes: target.targetBytes,
          iterations: searched.probes.length,
          ms: Math.round(performance.now() - started),
          msPerIteration: Math.round(
            (performance.now() - started) / Math.max(1, searched.probes.length),
          ),
          keptBytes: searched.bytes.byteLength,
          slider: searched.slider,
          outcome: searched.kind,
          probes: searched.probes,
        })
      } catch (error) {
        runs.push({
          id: target.id,
          targetBytes: target.targetBytes,
          failed: String(error && error.message ? error.message : error),
          ms: Math.round(performance.now() - started),
        })
      }
    }

    results.push({ format, smallestBytes: smallest, runs })
  }

  return {
    id: subject.id,
    frameCount,
    width,
    height,
    decodedBytes: frameCount * width * height * 4,
    sourceBytes: subject.bytes.length,
    formats: results,
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const stillSubjects = STILL_SUBJECTS.map((spec) => ({ ...spec }))
  const animatedSubjects = ANIMATED_SUBJECTS.map((spec) => ({
    id: spec.id,
    sourceFormat: spec.sourceFormat,
    bytes: Array.from(readFileSync(join(FIXTURES, spec.file))),
  }))

  // Real photographs, fitted to 1600 px in the page. Deterministic selection by size, as T02, T26
  // and T28 do; never the file's name.
  const fixturesDir = readEnvVar('PHOTO_FIXTURES_DIR')
  let photoNote

  if (fixturesDir) {
    const jpegs = walk(fixturesDir)
      .filter((file) => /\.jpe?g$/i.test(file))
      .sort((a, b) => statSync(a).size - statSync(b).size)

    if (jpegs.length >= 4) {
      const quantiles = QUICK ? [0.5] : [0.25, 0.75]
      const chosen = quantiles.map((q) => jpegs[Math.floor(q * jpegs.length)])

      chosen.forEach((file, index) => {
        stillSubjects.push({
          id: `photo-real-${index + 1}`,
          kind: 'file',
          bytes: Array.from(readFileSync(file)),
        })
      })
      photoNote = `${chosen.length} real photographs, fitted to 1600 px, selected by size rank from ${jpegs.length}`
    } else {
      photoNote = 'PHOTO_FIXTURES_DIR has fewer than four JPEGs'
    }
  } else {
    photoNote = 'PHOTO_FIXTURES_DIR unset — the real-photograph subjects were skipped'
  }

  console.log(`Still subjects: ${stillSubjects.map((s) => s.id).join(', ')}`)
  console.log(`Animated subjects: ${animatedSubjects.map((s) => s.id).join(', ')}`)
  console.log(`Photographs: ${photoNote}\n`)

  console.log(`Starting Vite on :${PORT} (repository root, repository config)...`)
  const server = await createServer({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, 'vite.config.ts'),
    server: { port: PORT, strictPort: true },
    logLevel: 'warn',
  })
  await server.listen()
  await waitForServer(`${BASE}/`)

  const results = {
    measuredAt: new Date().toISOString(),
    quick: QUICK,
    machine: {
      platform: platform(),
      release: release(),
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    plan: {
      stillFormats: STILL_FORMATS,
      animatedFormats: ANIMATED_FORMATS,
      d1TargetBytes: D1_TARGET_BYTES,
      pngTargetSweep: PNG_TARGET_SWEEP,
    },
    photographs: photoNote,
    engines: {},
    avifSpeed: null,
  }

  try {
    for (const [engineName, engine] of Object.entries(ENGINES)) {
      console.log(`\n=== ${engineName} ===`)
      const browser = await engine.launch({ headless: true })

      /**
       * A fresh page per subject, closed afterwards.
       *
       * Not tidiness: on the first run of this harness Firefox's content process died partway
       * through the fourth subject ("Execution context was destroyed"), having by then accumulated
       * ImageMagick's, oxipng's, libimagequant's and gifsicle's heaps plus several full-resolution
       * decodes in one document. One page per subject is also closer to what the app does, where
       * §8.2 recycles a worker on a pixel budget.
       */
      const withPage = async (run) => {
        const page = await browser.newPage()
        page.setDefaultTimeout(0)
        try {
          await page.goto(`${BASE}/`)
          return await run(page)
        } finally {
          await page.close()
        }
      }

      const still = []
      for (const subject of stillSubjects) {
        process.stdout.write(`  still ${subject.id} ... `)
        const started = Date.now()
        try {
          const measurement = await withPage((page) =>
            page.evaluate(MEASURE_STILL, {
              modules: MODULES,
              subject,
              formats: STILL_FORMATS,
              d1TargetBytes: D1_TARGET_BYTES,
              withPngAxis: !RECOVERY_ONLY && engineName === 'chromium',
              pngTargetSweep: PNG_TARGET_SWEEP,
              recoveryOnly: RECOVERY_ONLY,
            }),
          )
          still.push(measurement)
          const jpeg = measurement.formats.find((row) => row.format === 'jpeg')
          const d1 = jpeg?.runs.find((run) => run.id === 'd1-150kb')
          const detail = RECOVERY_ONLY
            ? `recovery corpus (${Math.round((Date.now() - started) / 1000)} s total)`
            : `JPEG 150 KB in ${d1 ? `${d1.iterations} iterations / ${d1.ms} ms` : 'n/a'} (${Math.round((Date.now() - started) / 1000)} s total)`
          console.log(`${measurement.width}x${measurement.height}, ${detail}`)
        } catch (error) {
          console.log(`FAILED — ${String(error && error.message ? error.message : error)}`)
          still.push({ id: subject.id, failed: String(error) })
        }
      }

      const animated = []
      for (const subject of RECOVERY_ONLY ? [] : animatedSubjects) {
        process.stdout.write(`  animated ${subject.id} ... `)
        try {
          const measurement = await withPage((page) =>
            page.evaluate(MEASURE_ANIMATED, {
              modules: MODULES,
              subject,
              formats: ANIMATED_FORMATS,
            }),
          )
          animated.push(measurement)
          const webp = measurement.formats.find((row) => row.format === 'webp')
          const interior = webp?.runs.find((run) => run.id === 'interior')
          console.log(
            `${measurement.frameCount}f ${measurement.width}x${measurement.height}: ` +
              `WebP ${interior ? `${interior.iterations} iterations / ${interior.ms} ms` : 'n/a'}`,
          )
        } catch (error) {
          console.log(`FAILED — ${String(error && error.message ? error.message : error)}`)
          animated.push({ id: subject.id, failed: String(error) })
        }
      }

      results.engines[engineName] = { still, animated }

      if (engineName === 'chromium' && !RECOVERY_ONLY) {
        process.stdout.write('  avif speed comparison ... ')
        try {
          results.avifSpeed = await withPage((page) =>
            page.evaluate(MEASURE_AVIF_SPEED, {
              modules: MODULES,
              subject: { width: 1600, height: 1200 },
              targetBytes: D1_TARGET_BYTES,
            }),
          )
          console.log(
            `speed 9 ${results.avifSpeed.speed9.ms} ms, ` +
              `library default ${results.avifSpeed.libraryDefault.ms} ms`,
          )
        } catch (error) {
          console.log(`FAILED — ${String(error && error.message ? error.message : error)}`)
          results.avifSpeed = { failed: String(error) }
        }
      }

      await browser.close()
    }
  } finally {
    await server.close()
  }

  // --- the summaries D1, §7.5 and R-Q4 need -----------------------------------------------------

  const chromium = results.engines.chromium?.still?.filter((subject) => subject.formats) ?? []

  results.summary = {
    // §7.5's table: iterations and wall time per format, at D1's own target and image size.
    d1: chromium.flatMap((subject) =>
      subject.formats
        .filter((row) => row.runs)
        .map((row) => {
          const run = row.runs.find((entry) => entry.id === 'd1-150kb')
          return {
            subject: subject.id,
            format: row.format,
            iterations: run?.iterations ?? null,
            ms: run?.ms ?? null,
            keptBytes: run?.keptBytes ?? null,
            slider: run?.slider ?? null,
            outcome: run?.outcome ?? null,
          }
        }),
    ),
    // R-Q4's question: the worst wall time any one image cost, per format, over every target and
    // every engine. The exclusion list is read off this.
    worstCase: Object.fromEntries(
      STILL_FORMATS.map((format) => {
        let worst = null
        for (const [engineName, engine] of Object.entries(results.engines)) {
          for (const subject of engine.still ?? []) {
            for (const row of subject.formats ?? []) {
              if (row.format !== format) continue
              for (const run of row.runs ?? []) {
                if (typeof run.ms !== 'number') continue
                if (worst === null || run.ms > worst.ms) {
                  worst = {
                    ms: run.ms,
                    iterations: run.iterations,
                    engine: engineName,
                    subject: subject.id,
                    target: run.id,
                  }
                }
              }
            }
          }
        }
        return [format, worst]
      }),
    ),
    // Iteration counts, per format, over everything measured. The claim §7.5 makes about the cap.
    iterationCounts: Object.fromEntries(
      STILL_FORMATS.map((format) => {
        const counts = {}
        for (const engine of Object.values(results.engines)) {
          for (const subject of engine.still ?? []) {
            for (const row of subject.formats ?? []) {
              if (row.format !== format) continue
              for (const run of row.runs ?? []) {
                if (typeof run.iterations !== 'number') continue
                counts[run.iterations] = (counts[run.iterations] ?? 0) + 1
              }
            }
          }
        }
        return [format, counts]
      }),
    ),
    dimensionRecovery: Object.fromEntries(
      STILL_FORMATS.map((format) => {
        const rows = []
        for (const [engineName, engine] of Object.entries(results.engines)) {
          for (const subject of engine.still ?? []) {
            const recovery = subject.formats?.find((row) => row.format === format)?.dimensionRecovery
            if (recovery && !recovery.failed) rows.push({ engine: engineName, subject: subject.id, ...recovery })
          }
        }
        const worst = rows.reduce((current, row) =>
          current === null || row.ms > current.ms ? row : current, null)
        return [format, { measurements: rows.length, worst }]
      }),
    ),
    // §7.5's PNG recommendation, answered: is `target` a monotone axis?
    pngTargetAxis: chromium
      .filter((subject) => subject.pngAxis?.points)
      .map((subject) => {
        const points = subject.pngAxis.points.filter((point) => typeof point.bytes === 'number')
        const monotone = points.every(
          (point, index) => index === 0 || point.bytes >= points[index - 1].bytes,
        )
        return {
          subject: subject.id,
          points: subject.pngAxis.points,
          monotoneInTarget: monotone,
        }
      }),
    // The animated cost, per frame, which is what decides whether R-Q4 has to exclude anything for
    // animated output.
    animatedCost: (results.engines.chromium?.animated ?? [])
      .filter((subject) => subject.formats)
      .flatMap((subject) =>
        subject.formats
          .filter((row) => row.runs)
          .map((row) => {
            const interior = row.runs.find((run) => run.id === 'interior')
            return {
              subject: subject.id,
              frames: subject.frameCount,
              format: row.format,
              iterations: interior?.iterations ?? null,
              ms: interior?.ms ?? null,
              msPerIteration: interior?.msPerIteration ?? null,
            }
          }),
      ),
  }

  const resultName = RECOVERY_ONLY ? 'recovery-results.json' : 'results.json'
  writeFileSync(join(__dirname, resultName), `${JSON.stringify(results, null, 2)}\n`)
  console.log(`\nWrote ${resultName}`)

  console.log('\n--- §7.5, at D1’s 150 KB target ---')
  for (const row of results.summary.d1) {
    console.log(
      `  ${row.subject.padEnd(16)} ${String(row.format).padEnd(5)} ` +
        `${String(row.iterations).padStart(2)} iterations  ${String(row.ms).padStart(6)} ms  ` +
        `${String(row.keptBytes).padStart(8)} B  slider ${row.slider}` +
        `${row.outcome === 'fit' ? '' : '  (target not reached)'}`,
    )
  }

  console.log('\n--- worst wall time per format, every engine and target ---')
  for (const [format, worst] of Object.entries(results.summary.worstCase)) {
    console.log(
      `  ${format.padEnd(5)} ${worst ? `${String(worst.ms).padStart(6)} ms over ${worst.iterations} iterations (${worst.engine}, ${worst.subject}, ${worst.target})` : 'n/a'}`,
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
