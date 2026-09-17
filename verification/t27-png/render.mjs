// T27 — renders the PNG files behind R-Q13's banding judgement, so it can be looked at rather than
// only read as a number.
//
// `run.mjs` reports a banding metric: the largest step the output introduced between two adjacent
// pixels whose source step was at most one unit. That is a good proxy — it is exactly the height of
// a band edge on a smooth ramp — but "no visible banding" is a claim about what a person sees, and
// the only honest way to check it is to look. This writes the files out.
//
// For each subject it writes three PNGs into the output directory:
//
//   <kind>-slider10-<branch>.png   the shipped stage at the lowest reachable setting (R-Q13)
//   <kind>-lossless.png            the same frame at slider 85 and above, for comparison
//   <kind>-imagemagick-<n>.png     ImageMagick's own quantizer at the same colour count (D8)
//
// Usage, from this directory:
//
//   node render.mjs [output-directory]
//
// Nothing here is part of the measurement; results.json does not depend on it, and no file it writes
// is committed. It reads no local fixtures, so it needs no .env.

import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { installGenerators } from './generators.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const OUT = process.argv[2] ?? join(__dirname, 'rendered')
const PORT = 5188
const BASE = `http://localhost:${PORT}`
const WIDTH = 1000
const HEIGHT = 750

/** The subjects banding would show on, with the colour count ImageMagick is given for the D8 pair. */
const SUBJECTS = [
  ['gradient-sky', 256],
  ['gradient-mono', 256],
  ['illustration-shaded', 195],
  ['screenshot-light', 256],
  ['logo-soft-alpha', 122],
  ['photo-synthetic', 256],
]

async function inPageRender({ kind, colors }) {
  const { encodePng } = await import('/src/pipeline/stages/png.ts')
  const plan = await import('/src/pipeline/stages/png-plan.ts')
  const loader = await import('/src/pipeline/codecs/loader.ts')
  const magick = await loader.ensureImageMagick()
  const oxipng = await loader.ensureOxipng()
  const {
    AlphaAction,
    ColorSpace,
    DitherMethod,
    ImageMagick,
    MagickFormat,
    MagickReadSettings,
    QuantizeSettings,
  } = magick

  const width = window.t27RenderWidth
  const height = window.t27RenderHeight

  // Slider 10 and slider 85, as `domain/job.ts` maps them (R-Q11, R-Q12).
  const low = await encodePng(window.t27Generate(kind, width, height), {
    kind: 'quality',
    value: 70,
    lossless: false,
  })
  const high = await encodePng(window.t27Generate(kind, width, height), {
    kind: 'quality',
    value: 95,
    lossless: true,
  })

  const frame = window.t27Generate(kind, width, height)
  const opaque = (await import('/src/pipeline/stages/encode-plan.ts')).isOpaque(frame.pixels)
  const written = ImageMagick.read(
    frame.pixels,
    new MagickReadSettings({ format: MagickFormat.Rgba, width, height, depth: 8 }),
    (image) => {
      if (opaque) image.alpha(AlphaAction.Off)
      const settings = new QuantizeSettings()
      settings.colors = colors
      settings.colorSpace = ColorSpace.sRGB
      settings.ditherMethod = DitherMethod.FloydSteinberg
      image.quantize(settings)
      return image.write(MagickFormat.Png, (data) => data.slice())
    },
  )
  const stripped = plan.rewritePngChunks(written, { kind: 'drop' })
  const imagemagick = new Uint8Array(
    await oxipng.default(
      stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength),
      plan.oxipngOptions(),
    ),
  )

  return {
    low: Array.from(low.bytes),
    lowBranch: low.branch,
    lowPalette: low.paletteColors,
    high: Array.from(high.bytes),
    imagemagick: Array.from(imagemagick),
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  const server = await createServer({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, 'vite.config.ts'),
    server: { port: PORT, strictPort: true },
    logLevel: 'error',
  })
  await server.listen()

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.addInitScript(installGenerators)
  await page.addInitScript(
    ([width, height]) => {
      window.t27RenderWidth = width
      window.t27RenderHeight = height
    },
    [WIDTH, HEIGHT],
  )
  await page.goto(`${BASE}/`, { waitUntil: 'load' })

  try {
    for (const [kind, colors] of SUBJECTS) {
      const rendered = await page.evaluate(inPageRender, { kind, colors })
      writeFileSync(
        join(OUT, `${kind}-slider10-${rendered.lowBranch}.png`),
        Buffer.from(rendered.low),
      )
      writeFileSync(join(OUT, `${kind}-lossless.png`), Buffer.from(rendered.high))
      writeFileSync(join(OUT, `${kind}-imagemagick-${colors}.png`), Buffer.from(rendered.imagemagick))
      console.log(
        kind,
        `slider10=${rendered.lowBranch}/${rendered.low.length} (palette ${rendered.lowPalette})`,
        `lossless=${rendered.high.length}`,
        `imagemagick=${rendered.imagemagick.length}`,
      )
    }
  } finally {
    await browser.close()
    await server.close()
  }

  console.log(`wrote ${SUBJECTS.length * 3} files to ${OUT}`)
}

await main()
