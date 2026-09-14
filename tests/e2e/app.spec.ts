import { test, expect } from '@playwright/test'

// Placeholder browser test (T05). Proves the app boots end-to-end in a real
// browser — Vite dev server serving index.html, which loads src/app/main.ts,
// which mounts src/app/App.vue with Pinia installed — on all three engines
// configured in playwright.config.ts. App.vue is still T04's throwaway
// placeholder (real shell/routing lands in T31+), so this only asserts its
// placeholder text renders; it is not a stand-in for real feature coverage.
test('boots the app and renders the placeholder root component', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('icompress scaffold OK')).toBeVisible()
})
