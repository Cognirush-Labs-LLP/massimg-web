// The measurement harness's own copy of pipeline/codecs/loader.ts's `ensure*` functions — kept
// deliberately close to the real ones, not imported, because this project is a standalone Vite
// dev-server page with no path aliases or app source tree of its own. See T20's
// "Harness duplicates the render primitive in plain JS rather than importing the module" for the
// same call made about thumbnail-render.ts. Any drift here from the real loader.ts is a bug in this
// harness, not evidence about C8 — it is re-checked against loader.ts's own logic by eye whenever
// this file changes.

let imageMagickPromise = null
async function ensureImageMagick() {
  if (!imageMagickPromise) {
    imageMagickPromise = (async () => {
      const magick = await import('@imagemagick/magick-wasm')
      const wasmUrl = new URL('@imagemagick/magick-wasm/magick.wasm', import.meta.url)
      await magick.initializeImageMagick(wasmUrl)
      return magick
    })()
  }
  return imageMagickPromise
}

let gifsiclePromise = null
async function ensureGifsicle() {
  if (!gifsiclePromise) {
    gifsiclePromise = import('gifsicle-wasm-browser').then((m) => m.default)
  }
  return gifsiclePromise
}

let oxipngPromise = null
async function ensureOxipng() {
  if (!oxipngPromise) {
    oxipngPromise = import('@jsquash/oxipng/optimise.js').then(async (m) => {
      await m.init()
      return m
    })
  }
  return oxipngPromise
}

let quantizerPromise = null
async function ensureQuantizer() {
  if (!quantizerPromise) {
    quantizerPromise = import('imagequant')
  }
  return quantizerPromise
}

let upngPromise = null
async function ensureUpng() {
  if (!upngPromise) {
    upngPromise = import('upng-js').then((m) => m.default)
  }
  return upngPromise
}

let apngOptimizerPromise = null
async function ensureApngOptimizer() {
  if (!apngOptimizerPromise) {
    apngOptimizerPromise = import('apng-optimizer').then(({ APNGOptimizer }) => {
      const wasmUrl = new URL('apng-optimizer/apng-optimizer.wasm', import.meta.url)
      return APNGOptimizer.createOptimizer(wasmUrl.href)
    })
  }
  return apngOptimizerPromise
}

const LOADERS = {
  imagemagick: ensureImageMagick,
  gifsicle: ensureGifsicle,
  oxipng: ensureOxipng,
  quantizer: ensureQuantizer,
  upng: ensureUpng,
  apngOptimizer: ensureApngOptimizer,
}

const RESOURCE_PATTERNS = {
  imagemagick: ['magick'],
  gifsicle: ['gifsicle'],
  oxipng: ['oxipng', 'squoosh_oxipng'],
  quantizer: ['imagequant'],
  upng: ['upng'],
  apngOptimizer: ['apng-optimizer'],
}

/** Loads one named module, timed. Memoised, same as the real loader — a second call is free. */
window.t22Load = async (name) => {
  const start = performance.now()
  await LOADERS[name]()
  return performance.now() - start
}

/** All six, concurrently — the "eager" scenario: everything loaded before first paint would occur. */
window.t22LoadAll = async () => {
  const start = performance.now()
  const perModule = {}
  await Promise.all(
    Object.keys(LOADERS).map(async (name) => {
      perModule[name] = await window.t22Load(name)
    }),
  )
  return { totalMs: performance.now() - start, perModule }
}

/** Bytes transferred per module, read from the Resource Timing API rather than tracked in Node —
 * this is what the browser itself recorded for each request, compressed-over-the-wire. */
window.t22ResourceBytes = () => {
  const entries = performance.getEntriesByType('resource')
  const out = {}
  for (const [name, patterns] of Object.entries(RESOURCE_PATTERNS)) {
    const matched = entries.filter((entry) => patterns.some((pattern) => entry.name.includes(pattern)))
    out[name] = matched.reduce((sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0), 0)
  }
  return out
}
