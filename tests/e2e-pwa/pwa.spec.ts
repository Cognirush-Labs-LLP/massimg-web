import { test, expect } from '@playwright/test'

// Technical Design §12.6. Runs against a real production build via playwright.pwa.config.ts,
// not the dev server — see that file's comment for why. `clientsClaim`/`skipWaiting` (both
// present in the generated dist/sw.js, confirmed by reading it) mean the very first page is
// claimed by its own service worker without needing a second navigation, but an explicit reload
// while still online is still done first so the precache-served response path is actually
// exercised before the offline assertion, not just "a controller exists".

test('the shell loads from the service worker cache with no network', async ({ page, context }) => {
  await page.goto('/')
  // A string expression, not a typed callback: tsconfig.node.json's `lib` is `["ES2022"]`
  // (no DOM), and `Navigator.serviceWorker` isn't among the ambient browser globals
  // Playwright's own types otherwise provide for `evaluate`/`waitForFunction` callbacks.
  await page.waitForFunction('navigator.serviceWorker.controller !== null')
  await page.reload()
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()

  await context.setOffline(true)
  await page.goto('/')

  // The shell renders with no network available at all — the only way that's possible is
  // if the response came from the service worker's cache.
  await expect(page.getByRole('button', { name: /compress/i })).toBeVisible()
})
