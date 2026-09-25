// T28 — A7: "gifsicle-wasm-browser scope and licence" (docs/assumptions.md A7; Functional Design
// R-Q8; Technical Design §7.3, §7.4).
//
// A7's own Method to close: "Run it in a Playwright-driven page against a real animated GIF and
// compare output size against ImageMagick's own GIF writer." That is exactly what this does, in
// three browsers, through the shipped `stages/gif.ts` rather than a reimplementation — the stage
// already reports both candidates' sizes, so the comparison A7 asks for is a field of its result.
//
// Three things are measured, and each one settles a decision that is otherwise a guess:
//
//   1. **gifsicle against ImageMagick alone**, per subject, per slider position. This is R-Q8's
//      claim ("substantially smaller") and A7's Method, and it is the only number the Done-when
//      needs.
//   2. **The `--lossy` curve**, swept over gifsicle's whole 1-200 range on each subject, with the
//      mean channel error against the source at each point. `gif-plan.ts` maps the slider onto
//      20..200 geometrically, and every part of that — where the band starts, why the scale
//      multiplies, where it ends — is read off this curve. One subject settles none of it, which is
//      why the sweep runs over nine.
//
//      The error pass decodes the written GIF and compares every channel, which on a 24-megapixel
//      still costs more than the encode it is measuring. On subjects above 4 megapixels it is
//      therefore taken only at the points the argument rests on, and the rest report
//      `errorSkipped`.
//   3. **`-O1` against `-O2` against `-O3`**, which is §7.3's row for gifsicle.
//
// Subjects. Four are content generated here as raw `Animation` frames and handed straight to the
// stage — flat, scene, photographic and large — because an animated GIF that ffmpeg or ImageMagick
// wrote is an animated GIF *someone already optimised*, and measuring an optimiser against a
// pre-optimised input understates it. Three are the committed fixtures, which is the reproducible
// half. Real photographs are added as **still** GIF subjects when PHOTO_FIXTURES_DIR is set, and
// skipped with a reason when it is not; only dimensions, byte counts and times are ever recorded.
//
// Run from this directory: pnpm install && pnpm test. T28_QUICK=1 runs Chromium only.

import { chromium, firefox, webkit } from '@playwright/test'
import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'animated')
const QUICK = Boolean(process.env.T28_QUICK)
const PORT = 5187
const BASE = `http://localhost:${PORT}`
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** The slider positions the app can actually be in, ends and middle. */
const SLIDERS = [100, 95, 80, 60, 40, 10]
/** gifsicle's whole documented range, for the two decisions `gifLossyLevel` makes. */
const LOSSY_SWEEP = [1, 5, 10, 20, 30, 40, 60, 80, 100, 120, 150, 200]
/** §7.3's row. */
const OPTIMIZE_LEVELS = [1, 2, 3]

const GIF_MODULE = '/src/pipeline/stages/gif.ts'
const GIF_PLAN_MODULE = '/src/pipeline/stages/gif-plan.ts'
const ANIMATION_MODULE = '/src/pipeline/stages/animation.ts'
const DECODE_MODULE = '/src/pipeline/stages/decode.ts'
const FRAME_MODULE = '/src/pipeline/stages/frame.ts'
const LOADER_MODULE = '/src/pipeline/codecs/loader.ts'
const JOB_MODULE = '/src/domain/job.ts'

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

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length
}

// ---------------------------------------------------------------------------------------------
// The generated subjects, as plain descriptions the page turns into frames. Kept as parameters
// rather than pixels so nothing megabyte-sized crosses into the browser.
// ---------------------------------------------------------------------------------------------

const GENERATED = [
  // Flat colour per frame: the worst case for both of gifsicle's levers, kept so the report shows
  // where it does *not* help rather than only where it does.
  { id: 'flat', kind: 'flat', frames: 10, width: 128, height: 96, delayMs: 40, loops: 4 },
  // A fixed detailed background with one moving block — the shape `-O2` was written for.
  { id: 'scene', kind: 'scene', frames: 10, width: 128, height: 96, delayMs: 40, loops: 4 },
  // Photographic: every frame differs everywhere, which leaves `--lossy` doing the work alone.
  { id: 'photo-like', kind: 'photo', frames: 12, width: 320, height: 240, delayMs: 40, loops: 0 },
  // Big enough that the time figures mean something.
  { id: 'scene-large', kind: 'scene', frames: 16, width: 480, height: 360, delayMs: 60, loops: 1 },
]

const FIXTURE_SUBJECTS = [
  { id: 'anim-scene.gif', file: 'anim-scene.gif', sourceFormat: 'gif' },
  { id: 'anim-6f.gif', file: 'anim-6f.gif', sourceFormat: 'gif' },
  { id: 'anim-disposal.gif', file: 'anim-disposal.gif', sourceFormat: 'gif' },
  { id: 'anim-16f-400.webp', file: 'anim-16f-400.webp', sourceFormat: 'webp' },
]

/**
 * Everything that happens in the page, for one subject: build or decode the animation once, then
 * run the shipped encoder at every slider, the raw optimiser at every lossy level, and the three
 * optimisation levels.
 *
 * The raw sweeps call gifsicle directly, which is the one place this harness is not the shipped
 * path — the stage has no way to be asked for `--lossy=137`, and the point of the sweep is to
 * justify the band the stage does use.
 */
const MEASURE = async ({ modules, subject, sliders, lossySweep, optimizeLevels }) => {
  const gif = await import(/* @vite-ignore */ modules.gif)
  const plan = await import(/* @vite-ignore */ modules.gifPlan)
  const animationStage = await import(/* @vite-ignore */ modules.animation)
  const decodeStage = await import(/* @vite-ignore */ modules.decode)
  const frame = await import(/* @vite-ignore */ modules.frame)
  const loader = await import(/* @vite-ignore */ modules.loader)
  const job = await import(/* @vite-ignore */ modules.job)

  const magick = await loader.ensureImageMagick()
  const gifsicle = await loader.ensureGifsicle()

  // --- the subject, as an Animation ------------------------------------------------------------

  const noiseAt = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0
    h = (h ^ (h >>> 13)) * 1274126177
    return (h ^ (h >>> 16)) & 0xff
  }

  const clamp = (value) => Math.max(0, Math.min(255, value))

  function generatedFrame(kind, index, width, height, frames) {
    const pixels = new Uint8Array(width * height * 4)
    const palette = [
      [230, 25, 25],
      [25, 200, 25],
      [25, 60, 230],
      [235, 215, 30],
      [30, 210, 215],
      [220, 40, 210],
    ]
    const block = Math.round(Math.min(width, height) / 4)
    const originX = Math.round((index * (width - block)) / Math.max(1, frames - 1))
    const originY = Math.round((index * (height - block)) / Math.max(1, frames - 1))

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        let r
        let g
        let b

        if (kind === 'flat') {
          const colour = palette[index % palette.length]
          r = colour[0]
          g = colour[1]
          b = colour[2]
        } else if (kind === 'scene') {
          const grain = (noiseAt(x, y) % 21) - 10
          const inBlock =
            x >= originX && x < originX + block && y >= originY && y < originY + block
          r = inBlock ? 250 - (x - originX) * 3 : 40 + Math.round((x * 180) / width) + grain
          g = inBlock ? 180 - (y - originY) * 2 : 30 + Math.round((y * 150) / height) + grain
          b = inBlock ? 40 : 120 - Math.round((x * 60) / width) + grain
        } else {
          // Photographic: smooth shading, fine grain, and the whole field moves every frame.
          const u = (x + index * 7) / width
          const v = (y + index * 3) / height
          const shade = 0.55 + 0.45 * Math.sin(u * 6.1) * Math.cos(v * 4.3)
          const grain = (noiseAt(x + index, y) % 25) - 12
          r = 190 * shade + grain + 30 * Math.sin(v * 9)
          g = 150 * shade + grain + 40 * Math.cos(u * 5)
          b = 120 * shade + grain
        }

        pixels[i] = clamp(Math.round(r))
        pixels[i + 1] = clamp(Math.round(g))
        pixels[i + 2] = clamp(Math.round(b))
        pixels[i + 3] = 255
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

  let animation
  if (subject.kind === 'generated') {
    const { frames, width, height, delayMs, loops, shape } = subject
    animation = {
      frames: Array.from({ length: frames }, (_, index) =>
        generatedFrame(shape, index, width, height, frames),
      ),
      delaysMs: new Array(frames).fill(delayMs),
      loops,
    }
  } else if (subject.kind === 'still') {
    animation = frame.singleFrameAnimation(
      await decodeStage.decodeFrame(new Uint8Array(subject.bytes)),
    )
  } else {
    animation = await animationStage.decodeAnimation(new Uint8Array(subject.bytes))
  }

  const frameCount = animation.frames.length
  const width = animation.frames[0].width
  const height = animation.frames[0].height

  // --- the shipped path, at every slider --------------------------------------------------------

  const quality = (slider) => {
    const resolution = job.resolveSettings(
      {
        sourceFormat: subject.sourceFormat ?? 'gif',
        isAnimated: frameCount > 1,
        edit: null,
      },
      {
        quality: { kind: 'quality', value: slider },
        dimension: { kind: 'original' },
        format: 'gif',
      },
    )
    return resolution.settings.quality
  }

  // The source pixels, for the error measure. Held as one flat array rather than re-decoding.
  const reference = animation.frames.map((f) => f.pixels.slice())

  const errorAgainstSource = async (bytes) => {
    try {
      const decoded =
        frameCount > 1
          ? await animationStage.decodeAnimation(bytes)
          : frame.singleFrameAnimation(await decodeStage.decodeFrame(bytes))
      let sum = 0
      let worst = 0
      let count = 0

      decoded.frames.forEach((f, index) => {
        const original = reference[index]
        if (!original) return
        for (let i = 0; i < f.pixels.length; i += 4) {
          for (let c = 0; c < 3; c += 1) {
            const d = Math.abs(f.pixels[i + c] - original[i + c])
            sum += d
            count += 1
            if (d > worst) worst = d
          }
        }
      })

      return { meanError: count === 0 ? null : Number((sum / count).toFixed(4)), worstError: worst }
    } catch (error) {
      return { meanError: null, worstError: null, errorMessage: String(error) }
    }
  }

  // Above this the comparison costs more than the encode, so it is taken only where it is load
  // bearing — see the header.
  const heavy = width * height > 4_000_000
  const maybeError = async (bytes, loadBearing) =>
    heavy && !loadBearing
      ? { meanError: null, worstError: null, errorSkipped: true }
      : errorAgainstSource(bytes)

  // A failed point is recorded and the run carries on. A harness that throws away twenty minutes of
  // measurements because one of two hundred gifsicle invocations did not come back is a harness that
  // reports nothing about the failure either.
  const sliderResults = []
  for (const slider of sliders) {
    const started = performance.now()

    try {
      const encoded = await gif.encodeGif(animation, quality(slider))
      const ms = performance.now() - started

      sliderResults.push({
        slider,
        lossy: encoded.lossy,
        branch: encoded.branch,
        imagemagickBytes: encoded.sizes.imagemagick,
        gifsicleBytes: encoded.sizes.gifsicle,
        keptBytes: encoded.bytes.byteLength,
        ms: Math.round(ms),
        ...(await maybeError(encoded.bytes, slider === 100 || slider === 10)),
      })
    } catch (error) {
      sliderResults.push({
        slider,
        failed: String(error && error.message ? error.message : error),
        ms: Math.round(performance.now() - started),
      })
    }
  }

  // --- the raw sweeps ---------------------------------------------------------------------------
  //
  // One ImageMagick write, reused for every gifsicle invocation below, so the sweep measures
  // gifsicle rather than the writer.

  const baseline = (() => {
    const { MagickFormat, MagickImage, MagickImageCollection, MagickReadSettings } = magick
    const delays = plan.gifFrameDelays(animation.delaysMs)
    return MagickImageCollection.use((collection) => {
      animation.frames.forEach((f, index) => {
        const settings = new MagickReadSettings({
          format: MagickFormat.Rgba,
          width: f.width,
          height: f.height,
          depth: 8,
        })
        const image = MagickImage.create(f.pixels, settings)
        image.animationTicksPerSecond = plan.GIF_TICKS_PER_SECOND
        image.animationDelay = delays.centiseconds[index]
        collection.push(image)
      })
      collection[0].animationIterations = animation.loops
      return collection.write(MagickFormat.Gif, (data) => data.slice())
    })
  })()

  const runGifsicle = async (command) => {
    const started = performance.now()
    let files

    try {
      files = await gifsicle.run({
        input: [{ file: baseline.slice().buffer, name: 'in.gif' }],
        command: [`${command} in.gif -o /out/out.gif`],
      })
    } catch (error) {
      // The wrapper rejects with a string, or with `undefined` when gifsicle produced no output.
      return {
        error: `gifsicle rejected: ${String(error ?? 'undefined')}`,
        ms: Math.round(performance.now() - started),
      }
    }

    const ms = performance.now() - started
    if (!files || files.length === 0) return { error: 'gifsicle returned nothing', ms }
    const out = new Uint8Array(await files[0].arrayBuffer())
    return { bytes: out.byteLength, ms: Math.round(ms), result: out }
  }

  const lossyCurve = []
  const noLossy = await runGifsicle('-O2')
  lossyCurve.push({
    lossy: null,
    bytes: noLossy.bytes,
    ms: noLossy.ms,
    ...(await maybeError(noLossy.result, true)),
  })

  for (const level of lossySweep) {
    const run = await runGifsicle(`-O2 --lossy=${level}`)
    lossyCurve.push({
      lossy: level,
      bytes: run.bytes,
      ms: run.ms,
      ...(await maybeError(run.result, level === 20 || level === 100 || level === 200)),
    })
  }

  const optimizeCurve = []
  for (const level of optimizeLevels) {
    const run = await runGifsicle(`-O${level}`)
    optimizeCurve.push({ level, bytes: run.bytes, ms: run.ms })
  }

  return {
    id: subject.id,
    frameCount,
    width,
    height,
    decodedBytes: frameCount * width * height * 4,
    sourceBytes: subject.bytes ? subject.bytes.length : null,
    imagemagickBaselineBytes: baseline.byteLength,
    sliders: sliderResults,
    lossyCurve,
    optimizeCurve,
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const subjects = []

  for (const spec of GENERATED) {
    subjects.push({
      id: spec.id,
      kind: 'generated',
      shape: spec.kind,
      frames: spec.frames,
      width: spec.width,
      height: spec.height,
      delayMs: spec.delayMs,
      loops: spec.loops,
      sourceFormat: 'gif',
    })
  }

  for (const spec of FIXTURE_SUBJECTS) {
    subjects.push({
      id: spec.id,
      kind: 'animated',
      sourceFormat: spec.sourceFormat,
      bytes: Array.from(readFileSync(join(FIXTURES, spec.file))),
    })
  }

  // Real photographs, as still GIF subjects. Deterministic selection by size, as T02 and T26 do.
  const fixturesDir = readEnvVar('PHOTO_FIXTURES_DIR')
  let photoNote = null

  if (fixturesDir) {
    const jpegs = walk(fixturesDir)
      .filter((file) => /\.jpe?g$/i.test(file))
      .sort((a, b) => statSync(a).size - statSync(b).size)

    if (jpegs.length >= 4) {
      const chosen = QUICK
        ? [jpegs[Math.floor(0.5 * jpegs.length)]]
        : [0.1, 0.5].map((q) => jpegs[Math.floor(q * jpegs.length)])

      chosen.forEach((file, index) => {
        subjects.push({
          // Never the file's name: only its index in the deterministic selection and its size.
          id: `photo-${index + 1}`,
          kind: 'still',
          sourceFormat: 'jpeg',
          bytes: Array.from(readFileSync(file)),
        })
      })
      photoNote = `${chosen.length} still photographs, selected by size rank from ${jpegs.length}`
    } else {
      photoNote = 'PHOTO_FIXTURES_DIR has fewer than four JPEGs'
    }
  } else {
    photoNote = 'PHOTO_FIXTURES_DIR unset — the real-photograph subjects were skipped'
  }

  console.log(`Subjects: ${subjects.map((s) => s.id).join(', ')}`)
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
    plan: { sliders: SLIDERS, lossySweep: LOSSY_SWEEP, optimizeLevels: OPTIMIZE_LEVELS },
    photographs: photoNote,
    engines: {},
  }

  try {
    for (const [engineName, engine] of Object.entries(ENGINES)) {
      console.log(`\n=== ${engineName} ===`)
      const browser = await engine.launch({ headless: true })
      const page = await browser.newPage()
      await page.goto(`${BASE}/`)
      const measured = []

      for (const subject of subjects) {
        process.stdout.write(`  ${subject.id} ... `)
        let measurement

        try {
          measurement = await page.evaluate(MEASURE, {
            modules: {
              gif: GIF_MODULE,
              gifPlan: GIF_PLAN_MODULE,
              animation: ANIMATION_MODULE,
              decode: DECODE_MODULE,
              frame: FRAME_MODULE,
              loader: LOADER_MODULE,
              job: JOB_MODULE,
            },
            subject,
            sliders: SLIDERS,
            lossySweep: LOSSY_SWEEP,
            optimizeLevels: OPTIMIZE_LEVELS,
          })
        } catch (error) {
          console.log(`FAILED — ${String(error && error.message ? error.message : error)}`)
          measured.push({ id: subject.id, failed: String(error) })
          continue
        }

        const best = measurement.sliders.find((row) => row.slider === 100)
        const ratio = best ? best.gifsicleBytes / best.imagemagickBytes : null
        console.log(
          `${measurement.frameCount}f ${measurement.width}x${measurement.height}: ` +
            `ImageMagick ${measurement.imagemagickBaselineBytes} B, ` +
            `gifsicle ${best ? best.gifsicleBytes : '?'} B` +
            (ratio ? ` (${((1 - ratio) * 100).toFixed(1)}% smaller)` : ''),
        )
        measured.push(measurement)
      }

      results.engines[engineName] = measured
      await browser.close()
    }
  } finally {
    await server.close()
  }

  // --- the two summaries A7 and §7.3 need ---------------------------------------------------------

  // Only the subjects that produced measurements; a failed one has no `sliders` to read.
  const chromium = (results.engines.chromium ?? []).filter((subject) => subject.sliders)
  results.summary = {
    // A7's Method, as one number per subject: how much smaller than ImageMagick alone, losslessly.
    losslessReduction: chromium.map((subject) => {
      const row = subject.sliders.find((entry) => entry.slider === 100)
      return {
        id: subject.id,
        frames: subject.frameCount,
        imagemagickBytes: row?.imagemagickBytes ?? null,
        gifsicleBytes: row?.gifsicleBytes ?? null,
        reduction:
          row && row.imagemagickBytes > 0
            ? Number((1 - row.gifsicleBytes / row.imagemagickBytes).toFixed(4))
            : null,
        meanError: row?.meanError ?? null,
      }
    }),
    // Where the lossy band's ends come from: the level at which `--lossy` first beats no lossy at
    // all, and what the last third of the range buys.
    lossyBandEvidence: chromium.map((subject) => {
      const curve = subject.lossyCurve
      const none = curve.find((entry) => entry.lossy === null)
      const firstImprovement = curve.find(
        (entry) => entry.lossy !== null && none && entry.bytes < none.bytes,
      )
      const at100 = curve.find((entry) => entry.lossy === 100)
      const at200 = curve.find((entry) => entry.lossy === 200)
      return {
        id: subject.id,
        noLossyBytes: none?.bytes ?? null,
        firstImprovingLevel: firstImprovement?.lossy ?? null,
        at100: at100 ? { bytes: at100.bytes, meanError: at100.meanError } : null,
        at200: at200 ? { bytes: at200.bytes, meanError: at200.meanError } : null,
        tailGain:
          at100 && at200 && at100.bytes > 0
            ? Number((1 - at200.bytes / at100.bytes).toFixed(4))
            : null,
      }
    }),
    // §7.3's row: is -O3 worth its time over -O2?
    optimizeLevels: chromium.map((subject) => ({
      id: subject.id,
      levels: subject.optimizeCurve,
      o3SmallerThanO2:
        subject.optimizeCurve.length === 3
          ? subject.optimizeCurve[2].bytes < subject.optimizeCurve[1].bytes
          : null,
    })),
    meanLosslessReduction: Number(
      (
        mean(
          chromium
            .map((subject) => {
              const row = subject.sliders.find((entry) => entry.slider === 100)
              return row && row.imagemagickBytes > 0
                ? 1 - row.gifsicleBytes / row.imagemagickBytes
                : null
            })
            .filter((value) => value !== null),
        ) ?? 0
      ).toFixed(4),
    ),
  }

  writeFileSync(join(__dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(`\nWrote results.json`)
  console.log(
    `Mean lossless reduction against ImageMagick alone: ` +
      `${(results.summary.meanLosslessReduction * 100).toFixed(1)}%`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
