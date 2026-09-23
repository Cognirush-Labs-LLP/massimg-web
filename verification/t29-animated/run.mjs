// T29 — C7: "Animated sources can be processed without holding every frame"
// (docs/assumptions.md C7; Functional Design R-B6; Technical Design §4.2, §8.1).
//
// C7's own Method: "Process animations of increasing frame count and measure peak memory against
// frames." This harness does that, and separates the two factors the way the entry asks — frame
// count at a fixed frame size, and frame size at a fixed frame count — because a single sweep that
// moves both cannot tell a per-frame cost from a per-pixel one.
//
// What is measured, per sweep point, in its own fresh browser profile:
//
//   - **peak process-tree RSS over that profile's own post-codec baseline.** The baseline is taken
//     *after* ImageMagick has initialised, so the 14.8 MB of WASM (A1) does not swamp the signal.
//   - **ImageMagick's WASM heap growth**, read from the `WebAssembly.Memory` captured by an init
//     script (T03's technique). WebAssembly linear memory only ever grows, so this is "how big did
//     the codec heap have to get", which is exactly the half of C7 that is about the collection
//     model.
//   - **wall time**, and the arithmetic floor `frames x width x height x 4` — the size of the
//     coalesced representation itself, which is what any measurement has to be read against.
//
// Both decoders are swept: GIF and WebP go through `ImageMagick.readCollection` + `coalesce()`,
// which is the model C7's "reads all frames into a collection" is about, and APNG goes through UPNG
// because ImageMagick's build cannot decode one (measured in T29; D6 predicted it).
//
// The sweep points import `src/pipeline/stages/animation.ts` as it ships, served by a Vite server
// rooted at the repository with the repository's own config, so no pipeline decision is
// reimplemented there. **The dispose comparison at the end is the exception and has to be**: the
// stage has no switch for turning its own per-frame `dispose()` off, so that one measurement runs a
// decode loop written here — the same `readCollection`, `coalesce()`, `getPixels`-per-frame
// sequence, with and without the dispose. It is the only thing in this file that is not the shipped
// module, and C7 says so where it quotes the result.
// Every generated source is checked through the pipeline's own container readers before it is used,
// so a malformed source shows up as a failed run rather than as a flattering number.
//
// Run from this directory: pnpm test. T29_QUICK=1 runs Chromium only, with the short sweeps.

import { chromium, firefox, webkit } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'

import { MemorySampler } from './memory-sampler.mjs'
import { animatedApng, animatedWebp } from './sources.mjs'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const QUICK = Boolean(process.env.T29_QUICK)
const PORT = 5188
const BASE = `http://localhost:${PORT}`
const MB = 1024 * 1024
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** Frame count at a fixed frame size: the axis C7 is written about. */
const FRAME_COUNT_SWEEP = QUICK ? [8, 32, 128] : [8, 16, 32, 64, 128]
const FRAME_COUNT_SIZE = 400

/** Frame size at a fixed frame count: the other factor, so the two can be told apart. */
const FRAME_SIZE_SWEEP = QUICK ? [200, 800] : [200, 400, 800, 1200]
const FRAME_SIZE_COUNT = 16

/** Two APNG points, so the UPNG decoder is not left unmeasured. */
const APNG_POINTS = QUICK ? [{ frames: 16, size: 400 }] : [
  { frames: 16, size: 400 },
  { frames: 64, size: 400 },
]

const ANIMATION_MODULE = '/src/pipeline/stages/animation.ts'
const PLAN_MODULE = '/src/pipeline/stages/animation-plan.ts'
const LOADER_MODULE = '/src/pipeline/codecs/loader.ts'

// ---------------------------------------------------------------------------------------------
// Process-tree RSS. Same technique as t20/t22: `launchPersistentContext` gives a disk-backed profile
// whose directory identifies the process tree, which is the only engine-agnostic way to see a
// browser's real memory (T01).
// ---------------------------------------------------------------------------------------------

async function findRootPid(userDataDir, nodePid) {
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,command='])

  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const [, pid, ppid, cmd] = match
    if (Number(ppid) === nodePid && cmd.includes(userDataDir)) return Number(pid)
  }

  return null
}

/**
 * Samples peak RSS across `fn`, plus a settle window afterwards.
 *
 * The settle window is not padding: t22 measured the process-tree figure still climbing for a beat
 * after the awaited promise resolves, so a peak read the instant `fn` returns is systematically low.
 */
async function samplePeak(rootPid, fn, settleMs = 600) {
  const sampler = new MemorySampler(rootPid, 20)
  sampler.start()
  const result = await fn()
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  const { peakBytes } = sampler.stop()
  return { result, peakBytes }
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

/**
 * Captures the Emscripten module's `WebAssembly.Memory` before any codec loads, so its
 * `buffer.byteLength` can be read afterwards. T03's technique; the memory is defined inside the wasm
 * binary rather than imported, so it arrives as `instance.exports.memory`.
 */
const WASM_CAPTURE = () => {
  const scope = /** @type {Record<string, unknown>} */ (globalThis)
  scope.__wasmMemory = null

  const stash = (instance) => {
    if (!instance || !instance.exports) return
    let memory = instance.exports.memory
    if (!(memory instanceof WebAssembly.Memory)) {
      memory = Object.values(instance.exports).find((value) => value instanceof WebAssembly.Memory)
    }
    // Keep the largest one seen: ImageMagick's heap dwarfs anything else this path loads.
    if (memory instanceof WebAssembly.Memory) {
      const current = scope.__wasmMemory
      if (!current || memory.buffer.byteLength > current.buffer.byteLength) {
        scope.__wasmMemory = memory
      }
    }
  }

  const instantiate = WebAssembly.instantiate.bind(WebAssembly)
  WebAssembly.instantiate = async (...args) => {
    const result = await instantiate(...args)
    stash(result && result.instance ? result.instance : result)
    return result
  }

  if (WebAssembly.instantiateStreaming) {
    const streaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    WebAssembly.instantiateStreaming = async (...args) => {
      const result = await streaming(...args)
      stash(result && result.instance ? result.instance : result)
      return result
    }
  }

  scope.__wasmBytes = () => {
    const memory = scope.__wasmMemory
    return memory ? memory.buffer.byteLength : 0
  }
}

/** Least-squares slope and intercept of y against x, plus R^2. */
function fitLine(points) {
  const n = points.length
  const sumX = points.reduce((sum, [x]) => sum + x, 0)
  const sumY = points.reduce((sum, [, y]) => sum + y, 0)
  const meanX = sumX / n
  const meanY = sumY / n
  let sxx = 0
  let sxy = 0

  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2
    sxy += (x - meanX) * (y - meanY)
  }

  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = meanY - slope * meanX
  let ssTot = 0
  let ssRes = 0

  for (const [x, y] of points) {
    ssTot += (y - meanY) ** 2
    ssRes += (y - (slope * x + intercept)) ** 2
  }

  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`Generating sources (this runs ImageMagick in Node, not in the browser)...`)

  /** Every point the run will measure, with its source bytes. */
  const points = []

  for (const frames of FRAME_COUNT_SWEEP) {
    points.push({
      sweep: 'frameCount',
      decoder: 'collection',
      container: 'webp',
      frames,
      size: FRAME_COUNT_SIZE,
      bytes: await animatedWebp(frames, FRAME_COUNT_SIZE),
    })
  }

  for (const size of FRAME_SIZE_SWEEP) {
    points.push({
      sweep: 'frameSize',
      decoder: 'collection',
      container: 'webp',
      frames: FRAME_SIZE_COUNT,
      size,
      bytes: await animatedWebp(FRAME_SIZE_COUNT, size),
    })
  }

  for (const point of APNG_POINTS) {
    points.push({
      sweep: 'apng',
      decoder: 'upng',
      container: 'png',
      frames: point.frames,
      size: point.size,
      bytes: animatedApng(point.frames, point.size),
    })
  }

  for (const point of points) {
    point.arithmeticBytes = point.frames * point.size * point.size * 4
    point.sourceBytes = point.bytes.length
    console.log(
      `  ${point.container} ${point.frames}f at ${point.size}px: ${point.sourceBytes} B on disk, ` +
        `${(point.arithmeticBytes / MB).toFixed(1)} MB decoded`,
    )
  }

  console.log(`\nStarting Vite on :${PORT} (repository root, repository config)...`)
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
      frameCountSweep: { frames: FRAME_COUNT_SWEEP, size: FRAME_COUNT_SIZE },
      frameSizeSweep: { sizes: FRAME_SIZE_SWEEP, frames: FRAME_SIZE_COUNT },
      apngPoints: APNG_POINTS,
    },
    points: points.map((point) => ({
      sweep: point.sweep,
      decoder: point.decoder,
      container: point.container,
      frames: point.frames,
      size: point.size,
      sourceBytes: point.sourceBytes,
      arithmeticBytes: point.arithmeticBytes,
    })),
    engines: [],
  }

  try {
    for (const [engineName, engine] of Object.entries(ENGINES)) {
      console.log(`\n=== ${engineName} ===`)
      const measurements = []

      for (const point of points) {
        const label = `${point.container} ${point.frames}f@${point.size}px`
        // A fresh, disk-backed profile per point. Sharing one context would let an earlier point's
        // WASM heap — which only ever grows — stand in for a later point's, and the whole question
        // here is how much each one costs on its own.
        const userDataDir = mkdtempSync(join(tmpdir(), 't29-udd-'))
        const context = await engine.launchPersistentContext(userDataDir, { headless: true })

        try {
          await context.addInitScript(WASM_CAPTURE)
          const rootPid = await findRootPid(userDataDir, process.pid)
          if (!rootPid) throw new Error(`${engineName}: could not locate the browser process`)

          const page = context.pages()[0] ?? (await context.newPage())
          const sourceUrl = `${BASE}/__t29/source`
          const body = Buffer.from(point.bytes)
          await page.route(sourceUrl, (route) =>
            route.fulfill({ body, contentType: 'application/octet-stream' }),
          )
          await page.goto(`${BASE}/`, { waitUntil: 'load' })

          // Load the codecs first and take the baseline after, so the 14.8 MB WASM init is not part
          // of what the sweep attributes to frame count.
          await page.evaluate(async (loaderPath) => {
            const loader = await import(/* @vite-ignore */ loaderPath)
            await loader.ensureImageMagick()
            await loader.ensureUpng()
          }, LOADER_MODULE)

          const { peakBytes: baselineBytes } = await samplePeak(rootPid, async () => {
            await new Promise((resolve) => setTimeout(resolve, 800))
          })
          const baselineWasm = await page.evaluate(() => globalThis.__wasmBytes())

          const { result, peakBytes } = await samplePeak(rootPid, () =>
            page.evaluate(
              async ({ animationPath, planPath, url, container }) => {
                const module = await import(/* @vite-ignore */ animationPath)
                const plan = await import(/* @vite-ignore */ planPath)
                const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())

                // Checked by the pipeline's own container reader before the decoder sees it, so a
                // malformed generated source fails the run instead of producing a small number.
                const declared =
                  container === 'png'
                    ? plan.readApngAnimation(bytes)
                    : plan.readWebpAnimation(bytes)

                const started = performance.now()
                const animation = await module.decodeAnimation(bytes)
                const ms = performance.now() - started

                // Held across the settle window so the sampler sees the animation alive, which is
                // the peak the user's tab actually pays.
                globalThis.__held = animation

                const wasmAfter = globalThis.__wasmBytes()
                const frame = animation.frames[0]

                return {
                  declaredFrames: declared.frameCount,
                  declaredWidth: declared.width,
                  declaredHeight: declared.height,
                  frames: animation.frames.length,
                  width: frame.width,
                  height: frame.height,
                  loops: animation.loops,
                  heldBytes: animation.frames.reduce(
                    (sum, each) => sum + each.pixels.byteLength,
                    0,
                  ),
                  ms,
                  wasmAfter,
                }
              },
              {
                animationPath: ANIMATION_MODULE,
                planPath: PLAN_MODULE,
                url: sourceUrl,
                container: point.container,
              },
            ),
          )

          if (result.frames !== point.frames || result.declaredFrames !== point.frames) {
            throw new Error(
              `${label}: decoded ${result.frames} frames, container declares ${result.declaredFrames}, expected ${point.frames}`,
            )
          }

          if (result.width !== point.size || result.declaredWidth !== point.size) {
            throw new Error(`${label}: decoded ${result.width}px, expected ${point.size}px`)
          }

          if (result.heldBytes !== point.arithmeticBytes) {
            throw new Error(
              `${label}: holds ${result.heldBytes} B, arithmetic says ${point.arithmeticBytes} B`,
            )
          }

          const row = {
            sweep: point.sweep,
            decoder: point.decoder,
            container: point.container,
            frames: point.frames,
            size: point.size,
            arithmeticBytes: point.arithmeticBytes,
            baselineRssBytes: baselineBytes,
            peakRssBytes: peakBytes,
            rssOverBaselineBytes: peakBytes - baselineBytes,
            baselineWasmBytes: baselineWasm,
            wasmAfterBytes: result.wasmAfter,
            wasmGrowthBytes: result.wasmAfter - baselineWasm,
            decodeMs: Math.round(result.ms),
          }

          measurements.push(row)
          console.log(
            `  ${label.padEnd(22)} arithmetic ${(row.arithmeticBytes / MB).toFixed(1).padStart(6)} MB  ` +
              `RSS +${(row.rssOverBaselineBytes / MB).toFixed(1).padStart(6)} MB  ` +
              `WASM +${(row.wasmGrowthBytes / MB).toFixed(1).padStart(6)} MB  ` +
              `${String(row.decodeMs).padStart(5)} ms`,
          )
        } finally {
          await context.close()
          rmSync(userDataDir, { recursive: true, force: true })
        }
      }

      // The two fits C7 asks for, stated as numbers rather than as an impression.
      const byCount = measurements.filter((row) => row.sweep === 'frameCount')
      const bySize = measurements.filter((row) => row.sweep === 'frameSize')

      const fits = {
        rssPerFrameAt400: fitLine(byCount.map((row) => [row.frames, row.rssOverBaselineBytes])),
        wasmPerFrameAt400: fitLine(byCount.map((row) => [row.frames, row.wasmGrowthBytes])),
        rssPerPixelAt16Frames: fitLine(
          bySize.map((row) => [row.size * row.size * FRAME_SIZE_COUNT * 4, row.rssOverBaselineBytes]),
        ),
        wasmPerPixelAt16Frames: fitLine(
          bySize.map((row) => [row.size * row.size * FRAME_SIZE_COUNT * 4, row.wasmGrowthBytes]),
        ),
      }

      console.log(
        `  fit: RSS ${(fits.rssPerFrameAt400.slope / MB).toFixed(2)} MB per frame at 400px ` +
          `(R2 ${fits.rssPerFrameAt400.r2.toFixed(3)}); ` +
          `arithmetic is ${((FRAME_COUNT_SIZE * FRAME_COUNT_SIZE * 4) / MB).toFixed(2)} MB per frame`,
      )
      console.log(
        `  fit: RSS ${fits.rssPerPixelAt16Frames.slope.toFixed(3)} B per decoded byte at 16 frames ` +
          `(R2 ${fits.rssPerPixelAt16Frames.r2.toFixed(3)})`,
      )

      // R-B6 asks that frames not all be held at once "wherever the format allows it", and
      // `decodeAnimation` disposes each `MagickImage` as it lifts that frame's pixels. Whether that
      // buys anything is a measurement, not an argument: `coalesce()` materialises every frame
      // inside ImageMagick *before* the first pixel is extracted, so there may be nothing left for
      // the per-frame dispose to save. Two fresh profiles, the same source, the loop run both ways.
      const disposeComparison = []

      for (const dispose of [true, false]) {
        const frames = QUICK ? 32 : 64
        const bytes = await animatedWebp(frames, FRAME_COUNT_SIZE)
        const userDataDir = mkdtempSync(join(tmpdir(), 't29-udd-'))
        const context = await engine.launchPersistentContext(userDataDir, { headless: true })

        try {
          await context.addInitScript(WASM_CAPTURE)
          const rootPid = await findRootPid(userDataDir, process.pid)
          if (!rootPid) throw new Error(`${engineName}: could not locate the browser process`)

          const page = context.pages()[0] ?? (await context.newPage())
          const sourceUrl = `${BASE}/__t29/dispose`
          const body = Buffer.from(bytes)
          await page.route(sourceUrl, (route) =>
            route.fulfill({ body, contentType: 'application/octet-stream' }),
          )
          await page.goto(`${BASE}/`, { waitUntil: 'load' })
          await page.evaluate(async (loaderPath) => {
            const loader = await import(/* @vite-ignore */ loaderPath)
            await loader.ensureImageMagick()
          }, LOADER_MODULE)

          const { peakBytes: baselineBytes } = await samplePeak(rootPid, async () => {
            await new Promise((resolve) => setTimeout(resolve, 800))
          })
          const baselineWasm = await page.evaluate(() => globalThis.__wasmBytes())

          const { result, peakBytes } = await samplePeak(rootPid, () =>
            page.evaluate(
              async ({ loaderPath, url, shouldDispose }) => {
                const loader = await import(/* @vite-ignore */ loaderPath)
                const { ImageMagick } = await loader.ensureImageMagick()
                const source = new Uint8Array(await (await fetch(url)).arrayBuffer())
                const started = performance.now()

                const held = ImageMagick.readCollection(source, (collection) => {
                  collection.coalesce()
                  const out = []

                  for (const image of collection) {
                    const width = image.width
                    const height = image.height
                    out.push(
                      image.getPixels((pixels) => pixels.toByteArray(0, 0, width, height, 'RGBA')),
                    )
                    if (shouldDispose) image.dispose()
                  }

                  return out
                })

                const ms = performance.now() - started
                globalThis.__held = held

                return {
                  frames: held.length,
                  ms,
                  wasmAfter: globalThis.__wasmBytes(),
                }
              },
              { loaderPath: LOADER_MODULE, url: sourceUrl, shouldDispose: dispose },
            ),
          )

          if (result.frames !== frames) {
            throw new Error(`dispose=${dispose}: got ${result.frames} frames, expected ${frames}`)
          }

          disposeComparison.push({
            disposePerFrame: dispose,
            frames,
            size: FRAME_COUNT_SIZE,
            arithmeticBytes: frames * FRAME_COUNT_SIZE * FRAME_COUNT_SIZE * 4,
            rssOverBaselineBytes: peakBytes - baselineBytes,
            wasmGrowthBytes: result.wasmAfter - baselineWasm,
            decodeMs: Math.round(result.ms),
          })
          console.log(
            `  dispose=${String(dispose).padEnd(5)} ${frames}f@${FRAME_COUNT_SIZE}px  ` +
              `RSS +${((peakBytes - baselineBytes) / MB).toFixed(1).padStart(6)} MB  ` +
              `WASM +${((result.wasmAfter - baselineWasm) / MB).toFixed(1).padStart(6)} MB  ` +
              `${String(Math.round(result.ms)).padStart(5)} ms`,
          )
        } finally {
          await context.close()
          rmSync(userDataDir, { recursive: true, force: true })
        }
      }

      results.engines.push({ engine: engineName, measurements, fits, disposeComparison })
    }
  } finally {
    await server.close()
  }

  writeFileSync(join(__dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log('\nWrote results.json')
}

await main()
