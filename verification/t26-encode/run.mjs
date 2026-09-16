// T26 — still encoding (docs/assumptions.md D2; Technical Design §7.3, §7.6).
//
// Two measurements, one run, both against the modules that ship — src/pipeline/stages/encode.ts and
// encode-plan.ts, served by a Vite server rooted at the repository with its own config:
//
//   D2 "WebP lossless wins on graphics and loses on photographs" — 1600x1200 content encoded lossy
//      at q70 and lossless with §7.3's recipe, bytes and wall time, in Chromium, Firefox and WebKit.
//      The generated content (a photographic stand-in, a flat graphic and a canvas-drawn screenshot)
//      needs nothing local; five real photographs are added when PHOTO_FIXTURES_DIR is set. Also the
//      gate's scan time on a 48 MP frame.
//
//   Gate calibration — every JPEG and PNG under PHOTO_FIXTURES_DIR (JPEGs stride-sampled), decoded
//      and fitted to a 1600 px long edge, then counted and encoded both ways, Chromium only. Content
//      decides the winner and the colour count, not the engine: the codec is the same WASM binary.
//      The summary scores candidate thresholds by how many lossless wins each would have skipped
//      and how many losing lossless attempts each would still have run.
//
// No filename, path or image content from the fixtures directory reaches results.json — images are
// numbered, and only dimensions, counts, sizes and times are recorded. Files are handed to the page
// through a numbered route, so no path reaches the browser either.
//
// This project has no dependencies of its own: it uses the repository's installed Vite, Playwright
// and magick-wasm, so what it measures is exactly the build the app ships.
//
// Run from this directory: pnpm test. T26_QUICK=1 runs Chromium only and skips calibration.

import { chromium, firefox, webkit } from '@playwright/test'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { cpus, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const QUICK = Boolean(process.env.T26_QUICK)
const PORT = 5186
const BASE = `http://localhost:${PORT}`
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** Candidate gate limits scored by the calibration summary. */
const CANDIDATE_LIMITS = [4_096, 16_384, 65_536, 131_072, 262_144, 1_048_576]

/** One in N JPEGs from the sorted list: photographs are plentiful and alike in what they show. */
const JPEG_STRIDE = 6

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

/** Files are served to the page by number only. */
async function serveFiles(page, files) {
  await page.route(`${BASE}/__t26/*`, async (route) => {
    const index = Number(route.request().url().split('/').pop())
    await route.fulfill({ body: readFileSync(files[index]), contentType: 'application/octet-stream' })
  })
}

// ---------------------------------------------------------------------------------------------
// In-page measurement. Everything below runs in the browser, importing the shipped modules.
// ---------------------------------------------------------------------------------------------

async function inPageMeasure({ content, url, limit, width, height, exactCount }) {
  const { decodeFrame } = await import('/src/pipeline/stages/decode.ts')
  const { applyResize } = await import('/src/pipeline/stages/resize.ts')
  const { encodeFrame } = await import('/src/pipeline/stages/encode.ts')
  const plan = await import('/src/pipeline/stages/encode-plan.ts')
  const magick = await (await import('/src/pipeline/codecs/loader.ts')).ensureImageMagick()
  const { ImageMagick, MagickFormat, MagickReadSettings, AlphaAction } = magick

  let frame
  if (url) {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    frame = await decodeFrame(bytes)
    frame = await applyResize(frame, { kind: 'fit-long-edge', pixels: 1600 })
  } else {
    frame = window.t26Generate(content, width, height)
  }

  const opaque = plan.isOpaque(frame.pixels)

  // One attempt with the shipped recipe (encoderAttempt), bytes and time.
  const direct = (mode) => {
    const attempt = plan.encoderAttempt('webp', { kind: 'quality', value: 70, lossless: false }, mode)
    const t0 = performance.now()
    const size = ImageMagick.read(
      frame.pixels,
      new MagickReadSettings({
        format: MagickFormat.Rgba,
        width: frame.width,
        height: frame.height,
        depth: 8,
      }),
      (image) => {
        if (opaque) image.alpha(AlphaAction.Off)
        if (attempt.quality !== null) image.quality = attempt.quality
        for (const d of attempt.defines) image.settings.setDefine(MagickFormat[d.format], d.name, d.value)
        return image.write(MagickFormat[attempt.format], (data) => data.byteLength)
      },
    )
    return { bytes: size, ms: Math.round(performance.now() - t0) }
  }

  const t0 = performance.now()
  const gated = plan.countUniqueColors(frame.pixels, limit)
  const gateMs = performance.now() - t0

  let unique = null
  let uniqueMs = null
  if (exactCount) {
    const t1 = performance.now()
    unique = plan.countUniqueColors(frame.pixels, 1 << 26)
    uniqueMs = Math.round(performance.now() - t1)
  }

  const lossy = direct('lossy')
  const lossless = direct('lossless')

  const untagged = { ...frame, colour: { kind: 'untagged' } }
  const t2 = performance.now()
  const stage = await encodeFrame(untagged, 'webp', { kind: 'quality', value: 70, lossless: false })
  const stageMs = Math.round(performance.now() - t2)

  return {
    width: frame.width,
    height: frame.height,
    opaque,
    unique,
    uniqueMs,
    gateCount: gated,
    gateMs: Math.round(gateMs * 10) / 10,
    lossy,
    lossless,
    winner: plan.pickSmaller(lossy.bytes, lossless.bytes),
    stage: { attempts: stage.attempts, kept: stage.mode, bytes: stage.bytes.byteLength, ms: stageMs },
  }
}

async function inPageScan48mp({ limit }) {
  const plan = await import('/src/pipeline/stages/encode-plan.ts')
  const out = {}
  for (const content of ['photo', 'flat']) {
    const frame = window.t26Generate(content, 8000, 6000)
    const t0 = performance.now()
    const count = plan.countUniqueColors(frame.pixels, limit)
    out[content] = { count, ms: Math.round(performance.now() - t0) }
  }
  return out
}

/** Content generators, installed as an init script. Deterministic, so every engine sees the same frames. */
function installGenerators() {
  const random = (seed) => () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }

  window.t26Generate = (content, width, height) => {
    let pixels

    if (content === 'screenshot') {
      // A settings-page-like screenshot: flat panels, a gradient header, anti-aliased text.
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#f4f5f7'
      ctx.fillRect(0, 0, width, height)
      const header = ctx.createLinearGradient(0, 0, width, 0)
      header.addColorStop(0, '#2b4c7e')
      header.addColorStop(1, '#567ebb')
      ctx.fillStyle = header
      ctx.fillRect(0, 0, width, 90)
      ctx.fillStyle = '#ffffff'
      ctx.font = '36px sans-serif'
      ctx.fillText('Compression settings', 40, 58)
      for (let row = 0; row < 18; row += 1) {
        const y = 130 + row * 58
        ctx.fillStyle = row % 2 ? '#ffffff' : '#eceef2'
        ctx.fillRect(40, y, width - 80, 50)
        ctx.fillStyle = '#1d1f24'
        ctx.font = '22px sans-serif'
        ctx.fillText(`Option ${row + 1}: output quality, dimension rule and format`, 60, y + 33)
        ctx.fillStyle = '#3a7bd5'
        ctx.beginPath()
        ctx.arc(width - 90, y + 25, 14, 0, Math.PI * 2)
        ctx.fill()
      }
      pixels = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
    } else {
      pixels = new Uint8Array(width * height * 4)
      const next = random(2026)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4
          if (content === 'flat') {
            const block = Math.floor((x * 4) / width) + 4 * Math.floor((y * 3) / height)
            const border = x < 12 || y < 12 || x >= width - 12 || y >= height - 12
            const shade = border ? 20 : 40 + block * 17
            pixels[i] = shade
            pixels[i + 1] = 255 - shade
            pixels[i + 2] = (shade * 3) & 255
          } else {
            const noise = () => Math.floor((next() - 0.5) * 24)
            const clamp = (v) => Math.max(0, Math.min(255, v))
            pixels[i] = clamp(Math.floor((x * 255) / width) + noise())
            pixels[i + 1] = clamp(Math.floor((y * 255) / height) + noise())
            pixels[i + 2] = clamp(Math.floor(((x + y) * 255) / (width + height)) + noise())
          }
          pixels[i + 3] = 255
        }
      }
    }

    return { width, height, pixels, colour: { kind: 'untagged' }, sourceOrientation: { kind: 'absent' } }
  }
}

// ---------------------------------------------------------------------------------------------

function scoreLimits(images) {
  return CANDIDATE_LIMITS.map((limit) => {
    let missedWins = 0
    let missedBytes = 0
    let wastedAttempts = 0
    let wastedMs = 0
    for (const image of images) {
      const attempted = image.unique <= limit
      if (!attempted && image.winner === 'lossless') {
        missedWins += 1
        missedBytes += image.lossy.bytes - image.lossless.bytes
      }
      if (attempted && image.winner === 'lossy') {
        wastedAttempts += 1
        wastedMs += image.lossless.ms
      }
    }
    return { limit, missedWins, missedBytes, wastedAttempts, wastedMs }
  })
}

async function main() {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, 'vite.config.ts'),
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  })
  await server.listen()

  const { LOSSLESS_GATE_MAX_COLORS: limit } = await server.ssrLoadModule(
    '/src/pipeline/stages/encode-plan.ts',
  )

  const fixturesDir = readEnvVar('PHOTO_FIXTURES_DIR')
  const all = fixturesDir ? walk(fixturesDir).sort() : []
  const jpegs = all.filter((f) => /\.jpe?g$/i.test(f))
  const pngs = all.filter((f) => /\.png$/i.test(f))
  // Five real photographs for D2, spread across file size (a proxy for detail).
  const bySize = [...jpegs].sort((a, b) => statSync(a).size - statSync(b).size)
  const d2Photos = bySize.length >= 5 ? [0.1, 0.3, 0.5, 0.7, 0.9].map((q) => bySize[Math.floor(q * bySize.length)]) : []

  const results = {
    generatedAt: new Date().toISOString(),
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? null },
    gateLimit: limit,
    d2: {},
    scan48mp: {},
    calibration: null,
  }

  try {
    for (const [name, engine] of Object.entries(ENGINES)) {
      const browser = await engine.launch()
      const page = await browser.newPage()
      await page.addInitScript(installGenerators)
      await serveFiles(page, d2Photos)
      await page.goto(`${BASE}/`, { waitUntil: 'load' })

      const d2 = {}
      for (const content of ['photo', 'flat', 'screenshot']) {
        d2[content] = await page.evaluate(inPageMeasure, {
          content,
          limit,
          width: 1600,
          height: 1200,
          exactCount: true,
        })
        console.log(name, content, JSON.stringify(d2[content]))
      }
      if (d2Photos.length === 0) {
        d2.realPhotos = { skipped: 'PHOTO_FIXTURES_DIR unset or has fewer than five JPEGs' }
      } else {
        d2.realPhotos = []
        for (let i = 0; i < d2Photos.length; i += 1) {
          const measured = await page.evaluate(inPageMeasure, {
            url: `${BASE}/__t26/${i}`,
            limit,
            exactCount: true,
          })
          d2.realPhotos.push(measured)
          console.log(name, `real photo ${i + 1}`, JSON.stringify(measured))
        }
      }
      results.d2[name] = d2
      results.scan48mp[name] = await page.evaluate(inPageScan48mp, { limit })
      console.log(name, '48 MP scan', JSON.stringify(results.scan48mp[name]))
      await browser.close()
    }

    if (QUICK) {
      results.calibration = { skipped: 'T26_QUICK' }
    } else if (!fixturesDir) {
      results.calibration = { skipped: 'PHOTO_FIXTURES_DIR unset' }
    } else {
      const sampledJpegs = jpegs.filter((_, index) => index % JPEG_STRIDE === 0)
      const files = [...sampledJpegs, ...pngs]
      const browser = await chromium.launch()
      const images = []
      let failed = 0

      for (let i = 0; i < files.length; i += 1) {
        // A fresh page per image keeps one pathological file from taking the run's heap with it.
        const page = await browser.newPage()
        await serveFiles(page, files)
        await page.goto(`${BASE}/`, { waitUntil: 'load' })
        try {
          const measured = await page.evaluate(inPageMeasure, {
            url: `${BASE}/__t26/${i}`,
            limit,
            exactCount: true,
          })
          images.push({ index: i, kind: i < sampledJpegs.length ? 'jpeg' : 'png', ...measured })
          process.stdout.write(`calibration ${i + 1}/${files.length}\r`)
        } catch {
          failed += 1
        }
        await page.close()
      }
      await browser.close()

      const lossless = images.filter((image) => image.winner === 'lossless')
      const lossy = images.filter((image) => image.winner === 'lossy')
      const bigLossy = lossy.filter((image) => image.width * image.height >= 500_000)

      results.calibration = {
        engine: 'chromium',
        sampled: { jpegs: sampledJpegs.length, pngs: pngs.length, undecodable: failed },
        summary: {
          losslessWins: lossless.length,
          lossyWins: lossy.length,
          maxUniqueWhereLosslessWon: Math.max(0, ...lossless.map((image) => image.unique)),
          minUniqueWhereLossyWonAtHalfMegapixelOrMore: bigLossy.length
            ? Math.min(...bigLossy.map((image) => image.unique))
            : null,
          byLimit: scoreLimits(images),
        },
        images,
      }
      console.log('\ncalibration summary', JSON.stringify(results.calibration.summary, null, 2))
    }
  } finally {
    await server.close()
  }

  writeFileSync(join(__dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log('wrote results.json')
}

await main()
