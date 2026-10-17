import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

// Ambient, minimal, and local to this file: tsconfig.node.json (which covers
// tests/**/*.ts) sets `lib: ["ES2022"]` with no `"DOM"`, so `CacheStorage`/`Cache` are
// not otherwise declared — same reason png.spec.ts declares its own `makeFrame`/
// `drawPng` ambients rather than pulling in the DOM lib for the whole test tree.
declare const caches: {
  open(cacheName: string): Promise<{ keys(): Promise<{ url: string }[]> }>
}

// T46, Technical Design §12.6. The F2 test (pwa.spec.ts) only proves the shell plus
// ImageMagick (fetched via its own idle-after-first-paint preload, T22) still work
// offline — it never exercises oxipng/imagequant/apng-optimizer, whose WASM is fetched
// only on first use of PNG/APNG output (T22). This test proves the `CacheFirst`
// runtime-caching rule (vite.config.ts) catches every codec's `.wasm` file, not just the
// one F2 happens to touch, by fetching each one directly against the live service
// worker rather than driving each codec's real trigger condition through the UI.
//
// Discovers the real filenames from the built `dist/assets/` directory rather than
// hardcoding content hashes, which change on every dependency/build update.
function wasmAssetPaths(): string[] {
  const distAssets = fileURLToPath(new URL('../../dist/assets/', import.meta.url))
  return readdirSync(distAssets)
    .filter((name) => name.endsWith('.wasm'))
    .map((name) => `/assets/${name}`)
}

test('every codec .wasm file is caught by the CacheFirst runtime rule, not just ImageMagick', async ({
  page,
}) => {
  const wasmPaths = wasmAssetPaths()
  // Four at the time of writing (ImageMagick, imagequant, oxipng, apng-optimizer) —
  // gifsicle ships its WASM inlined inside an already-precached JS chunk, so it never
  // makes a separate `.wasm` request at all. A count assertion catches a future codec
  // quietly landing without this test noticing it exists.
  expect(wasmPaths.length).toBeGreaterThanOrEqual(4)

  await page.goto('/')
  await page.waitForFunction('navigator.serviceWorker.controller !== null')

  const directFetchResults = await page.evaluate(async (paths: string[]) => {
    const results: Record<string, boolean> = {}
    for (const path of paths) {
      results[path] = (await fetch(path)).ok
    }
    return results
  }, wasmPaths)
  for (const path of wasmPaths) {
    expect(directFetchResults[path]).toBe(true)
  }

  // Workbox's strategies write to Cache Storage via the SW's own `event.waitUntil()`, a
  // background task decoupled from when the page's `fetch()` call resolves — for
  // ImageMagick's 14.8MB file that write can still be in flight a moment after the
  // fetch returns. Poll rather than checking once immediately, to avoid a false
  // negative on exactly the file size variation this test wants to cover.
  const cachedUrls = await page.evaluate(
    async ({ paths, timeoutMs }: { paths: string[]; timeoutMs: number }) => {
      const deadline = Date.now() + timeoutMs
      let urls: string[] = []
      while (Date.now() < deadline) {
        urls = (await (await caches.open('codec-wasm')).keys()).map((request) => request.url)
        if (paths.every((path) => urls.some((url) => url.endsWith(path)))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return urls
    },
    { paths: wasmPaths, timeoutMs: 10_000 },
  )
  for (const path of wasmPaths) {
    expect(cachedUrls.some((url) => url.endsWith(path))).toBe(true)
  }

  // CacheFirst never revalidates against the origin's ETag/Last-Modified — a fully
  // offline re-fetch of every URL must still succeed, proving nothing short of going
  // fully offline is needed to exercise the cached path (the content hash in each
  // filename is what invalidates a stale entry, not a conditional request).
  await page.context().setOffline(true)
  const offlineFetchResults = await page.evaluate(async (paths: string[]) => {
    const results: Record<string, boolean> = {}
    for (const path of paths) {
      try {
        results[path] = (await fetch(path)).ok
      } catch {
        results[path] = false
      }
    }
    return results
  }, wasmPaths)
  for (const path of wasmPaths) {
    expect(offlineFetchResults[path]).toBe(true)
  }
})
