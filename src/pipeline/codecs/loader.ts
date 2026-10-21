// Lazy codec loading (Technical Design §5.2, §12.1; Assumption C8).
//
// ImageMagick alone is 14.8 MB uncompressed (A1) and the landing page has an SEO job (§12.1), so
// nothing here may run at module-evaluation time: every codec is fetched only from inside one of the
// `ensure*` functions below, each memoised so a second call is free. This module runs on both sides
// of the `postMessage` boundary — `pipeline/execute.ts` calls `ensureCodecsForJob` from inside a
// worker, and `app/ToolPage.vue` calls `scheduleImageMagickPreload` from the main thread — so nothing
// here assumes `window` exists.
//
//   | Module               | Loaded when                                    |
//   | --------------------- | ----------------------------------------------- |
//   | ImageMagick           | First image added, or idle after first paint    |
//   | gifsicle               | First job resolves to GIF output                |
//   | oxipng, quantizer      | First job resolves to still PNG output          |
//   | UPNG, apng-optimizer, oxipng | First job resolves to animated PNG output  |
//
// §7.1's package choices: `@imagemagick/magick-wasm` (A1), `gifsicle-wasm-browser`, oxipng through
// jSquash's WASM wrapper,
// `imagequant` (the libimagequant wrapper — GPL v3, matching §7.2's licensing analysis exactly),
// `upng-js` (pure JS, no WASM) and `apng-optimizer`. See docs/task-notes/T22.md, "Decisions made", for
// why each was chosen over its alternatives.

import { codecsForSettings } from './routing'
import type { CodecName } from './routing'
import { resolveCodecLimits, type CodecLimits } from '@/config/limits'
import type { ResolvedSettings } from '@/domain/types'

export type { CodecName } from './routing'
export { codecsForSettings } from './routing'

// ---------------------------------------------------------------------------------------------
// Per-module loaders. Each is a module-scope memoised promise: the first caller pays the fetch and
// init cost, every later caller (including a later job in the same worker) gets the same instance.
// ---------------------------------------------------------------------------------------------

let imageMagickPromise: Promise<typeof import('@imagemagick/magick-wasm')> | null = null
let codecLimits: CodecLimits = resolveCodecLimits(undefined)

/**
 * Sets the budget `ensureImageMagick` applies. Must run before the first call: the limits are
 * written once, as ImageMagick initialises. A worker never learns whether it is on a phone by
 * itself, so its pool tells it (`protocol.ts` `configure`).
 */
export function configureCodecLimits(limits: CodecLimits): void {
  codecLimits = limits
}

/**
 * Without `disk = 0` the other limits are decoration. ImageMagick answers an over-budget pixel cache
 * by spilling it to "disk", which in this build is the same WASM heap, so a 324 MP decode under a
 * 100 MP `area` and a 1 GiB `memory` limit still succeeded (T50). With the spill refused the same
 * decode fails in milliseconds with a catchable `CacheResourcesExhausted` and the instance stays
 * usable. `memory` also bounds the sum over an animation's frames, which `area` (per image) cannot;
 * and `listLength` stops a frame bomb that would otherwise end in an `exit(1)` that leaves the
 * instance dead. Its margin covers the coalesced list ImageMagick holds beside the original.
 */
function applyResourceLimits(
  { ResourceLimits }: typeof import('@imagemagick/magick-wasm'),
  limits: CodecLimits,
): void {
  ResourceLimits.disk = 0n
  ResourceLimits.memory = BigInt(limits.cacheBytes)
  ResourceLimits.maxMemoryRequest = BigInt(limits.cacheBytes)
  // ImageMagick refuses an image whose area equals this limit, so the limit sits one above the
  // largest image the selection-time check admits; otherwise an image exactly at the cap passes
  // selection and fails here (measured on the Android phone: 8192 x 6400 against a 52,428,800 cap).
  ResourceLimits.area = BigInt(limits.maximumImagePixels) + 1n
  ResourceLimits.listLength = BigInt(Math.ceil(limits.maximumAnimationFrames * 1.25) + 16)
}

/**
 * The x86/wasm32 build, not x64 — B7 is only 80% confident memory64 is usable, and T20's harness and
 * A1's build-identity assumption both already commit to x86. `initializeImageMagick` accepts a `URL`
 * directly and fetches it itself, so there is no separate manual `fetch()` step here.
 */
export function ensureImageMagick(): Promise<typeof import('@imagemagick/magick-wasm')> {
  if (!imageMagickPromise) {
    imageMagickPromise = (async () => {
      const magick = await import('@imagemagick/magick-wasm')
      const wasmUrl = new URL('@imagemagick/magick-wasm/magick.wasm', import.meta.url)
      await magick.initializeImageMagick(wasmUrl)
      applyResourceLimits(magick, codecLimits)
      return magick
    })()
  }
  return imageMagickPromise
}

let gifsiclePromise: Promise<typeof import('gifsicle-wasm-browser').default> | null = null

/**
 * `gifsicle-wasm-browser`'s default export manages its own internal Worker and instantiates its WASM
 * only when `.run()` is called — the package exposes no separate init step. "Loaded" here means the
 * dynamic `import()` has resolved, i.e. its code-split chunk has been fetched; `stages/gif.ts` (T28)
 * is what calls `.run()`. See docs/task-notes/T22.md, Surprises.
 *
 * Every `.run()` builds a fresh Worker from a blob URL, instantiates the WASM inside it and
 * terminates it on completion, so nothing accumulates between jobs and nothing is warm between them
 * either: the measured 22-40 ms of a small GIF run is mostly that spin-up (T28).
 */
export function ensureGifsicle(): Promise<typeof import('gifsicle-wasm-browser').default> {
  if (!gifsiclePromise) {
    gifsiclePromise = import('gifsicle-wasm-browser').then((module) => {
      defineElementForGifsicle()
      return module.default
    })
  }
  return gifsiclePromise
}

/**
 * Gives the Worker an `Element` binding, because `gifsicle-wasm-browser` cannot run without one and
 * fails in the worst available way when it is missing.
 *
 * Its argument type-check starts `A instanceof Element`, and `Element` is a DOM interface that does
 * not exist in a Worker. So the check raises `ReferenceError: Element is not defined` for *every*
 * input — and the wrapper runs it inside `new Promise(async (resolve, reject) => …)`, where a throw
 * in the async executor becomes an unhandled rejection of the executor rather than a rejection of
 * the promise. The promise is then never settled at all, so `run()` never returns, so the job never
 * completes and never fails. Measured (T28): a GIF job through the real pipeline worker hung on
 * Chromium, Firefox and WebKit alike until this existed.
 *
 * Declaring the class makes `instanceof` evaluate to `false`, which is the answer the check wants
 * for every input this codebase passes it — an `ArrayBuffer` — and lets it fall through to the
 * `Object.prototype.toString` branch it uses for everything else.
 *
 * Two things keep the blast radius small. It only defines the name where it is genuinely absent, so
 * the main thread's real `Element` is never shadowed; and it is reached only from `ensureGifsicle`,
 * which runs only for a job that resolved to GIF output. It is still a global in a shared worker
 * scope, and a library that decided it was in a document because `typeof Element !== 'undefined'`
 * would be misled by it — nothing in `ENSURE_BY_NAME` does, checked, but it is the risk to weigh if
 * this ever has to move earlier.
 */
function defineElementForGifsicle(): void {
  const scope = globalThis as { Element?: unknown }

  if (typeof scope.Element === 'undefined') {
    scope.Element = class Element {}
  }
}

let oxipngPromise: Promise<typeof import('./oxipng')> | null = null

/**
 * `oxipng.ts`'s exported init does the real WASM fetch and instantiation. The generated glue stays
 * isolated next to it and is excluded from lint/format passes as a generated third-party file.
 *
 * The package's published WASM resolves oxipng 9.1.1. APNG support arrived in 9.0, but 9.1.2 fixed
 * an upstream compatibility bug in files it produced. The local binary is the same jSquash wrapper
 * rebuilt against oxipng 9.1.5, the final 9.x maintenance release, so APNG output never uses the
 * affected core while the wrapper API and measured level-2 behaviour stay unchanged.
 */
export function ensureOxipng(): Promise<typeof import('./oxipng')> {
  if (!oxipngPromise) {
    oxipngPromise = import('./oxipng').then(async (module) => {
      await module.initOxipng()
      return module
    })
  }
  return oxipngPromise
}

let quantizerPromise: Promise<typeof import('imagequant')> | null = null

/**
 * `imagequant`'s glue module does a bare `import * as wasm from './imagequant_bg.wasm'`
 * (wasm-bindgen's "bundler" target) — Vite resolves this to a real streaming fetch as part of
 * evaluating the module, so the dynamic `import()` alone is a genuine, full initialisation.
 */
export function ensureQuantizer(): Promise<typeof import('imagequant')> {
  if (!quantizerPromise) {
    quantizerPromise = import('imagequant')
  }
  return quantizerPromise
}

let upngPromise: Promise<typeof import('upng-js').default> | null = null

/**
 * Pure JS (§7.1) — no WASM, so "loading" is just the dynamic import resolving.
 *
 * Typed against `src/upng-js.d.ts` since T29, because UPNG is no longer only the APNG *writer*: it
 * is the APNG **reader** too. ImageMagick's WASM build returns one frame from a six-frame APNG
 * without raising anything (measured, T29; D6 predicted it of the still reader), so `decodeAnimation`
 * takes the UPNG branch for an APNG source whatever the output format is.
 *
 * It bundles `pako` and reaches it through Vite's CommonJS interop rather than through `window.pako`;
 * verified by decoding a real APNG in the browser build, not assumed from the import resolving.
 */
export function ensureUpng(): Promise<typeof import('upng-js').default> {
  if (!upngPromise) {
    upngPromise = import('upng-js').then((module) => module.default)
  }
  return upngPromise
}

let apngOptimizerPromise: Promise<import('apng-optimizer').APNGOptimizer> | null = null

export function ensureApngOptimizer(): Promise<import('apng-optimizer').APNGOptimizer> {
  if (!apngOptimizerPromise) {
    apngOptimizerPromise = import('apng-optimizer').then(({ APNGOptimizer }) => {
      const wasmUrl = new URL('apng-optimizer/apng-optimizer.wasm', import.meta.url)
      return APNGOptimizer.createOptimizer(wasmUrl.href)
    })
  }
  return apngOptimizerPromise
}

const ENSURE_BY_NAME: Record<CodecName, () => Promise<unknown>> = {
  imagemagick: ensureImageMagick,
  gifsicle: ensureGifsicle,
  oxipng: ensureOxipng,
  quantizer: ensureQuantizer,
  upng: ensureUpng,
  apngOptimizer: ensureApngOptimizer,
}

/**
 * Worker-side entry point: `pipeline/execute.ts` calls this before running any stage. §5.2's "a
 * worker that needs a module it has not loaded loads it and then proceeds" — a fresh worker (or one
 * whose main-thread preload has not finished yet) pays the cost here instead of failing.
 */
export async function ensureCodecsForJob(
  settings: Pick<ResolvedSettings, 'format' | 'isAnimated' | 'sourceFormat'>,
): Promise<void> {
  await Promise.all(codecsForSettings(settings).map((name) => ENSURE_BY_NAME[name]()))
}

// ---------------------------------------------------------------------------------------------
// Main-thread preload (§12.1: "ImageMagick's WASM fetched on idle after first paint, or on first
// interaction, whichever comes first"). Guarded by `typeof window` so importing this module from a
// worker — which every `ensure*` above must also work from — does nothing extra.
// ---------------------------------------------------------------------------------------------

/** `requestIdleCallback`'s own timeout: fires the preload anyway if the page never truly goes idle. */
const IDLE_TIMEOUT_MS = 2000
/** WebKit has no `requestIdleCallback` (capability.ts's rule: feature detection, not UA sniffing). */
const IDLE_FALLBACK_MS = 200

let preloadScheduled = false

/**
 * What the idle preload (and `notifyImageAdded()`) actually runs. Defaults to this module's own
 * `ensureImageMagick()` — the main-thread load that §5.2's "two separate realms" problem warns
 * against on its own — but the one real caller, `app/ToolPage.vue`, always overrides this via
 * `scheduleImageMagickPreload`'s required `action` parameter to warm the real pipeline worker
 * instead, so the load happens once, in the realm that actually uses it. This module cannot default
 * to that itself: it is imported from inside a worker too (see the header comment), and must not
 * import UI-layer code like `ui/preview/preview-pool.ts`.
 */
let preloadAction: () => void = () => void ensureImageMagick()

function runWhenIdle(callback: () => void): void {
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
  }

  if (typeof win.requestIdleCallback === 'function') {
    win.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS })
  } else {
    setTimeout(callback, IDLE_FALLBACK_MS)
  }
}

/**
 * Call once from the app's entry point. Idempotent. Schedules `action` for idle time after the page
 * has finished loading — never before, which is what keeps first paint unblocked. `notifyImageAdded()`
 * below pre-empts this the moment there is real work to do, reusing whichever `action` was registered
 * here.
 */
export function scheduleImageMagickPreload(action: () => void): void {
  preloadAction = action

  if (typeof window === 'undefined' || preloadScheduled) {
    return
  }
  preloadScheduled = true

  const start = (): void => {
    preloadAction()
  }

  if (document.readyState === 'complete') {
    runWhenIdle(start)
  } else {
    window.addEventListener('load', () => runWhenIdle(start), { once: true })
  }
}

/**
 * The "first image is added" trigger from §5.2's table. Left unwired deliberately — there is no
 * Gallery yet to call it from (T30+), the same seam shape T20 left for `fallbackDecoder`. Idempotent
 * and safe to call before or after `scheduleImageMagickPreload()`; whichever `action` was last
 * registered is what runs, so this stays consistent with it rather than falling back to a
 * main-thread `ensureImageMagick()` of its own.
 */
export function notifyImageAdded(): void {
  preloadScheduled = true
  preloadAction()
}
