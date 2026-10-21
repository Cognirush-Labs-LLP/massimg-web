import { defineConfig, devices } from '@playwright/test'

// T51. The public routes and the generated SEO files (sitemap.xml, robots.txt, llms.txt) are
// production-build artifacts: `vite-ssg` writes one HTML file per route and
// scripts/generate-seo-files.mjs reads those files back, so none of it exists on the dev server
// playwright.config.ts uses. This config pays for one `pnpm build` and checks the built output
// as it would be served, the same trade playwright.pwa.config.ts makes for the service worker.
//
// All three engines, unlike the PWA config: nothing here goes offline, so Playwright's WebKit
// driver limitation recorded there does not apply.
export default defineConfig({
  testDir: './tests/e2e-site',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4175',
    trace: 'on-first-retry',
    // The production build registers a service worker, and Playwright cannot route a request that
    // the worker itself makes. These tests are about the pages and files, not about offline
    // behavior (tests/e2e-pwa), so the worker is kept out of the way.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm build && vite preview --port 4175 --strictPort',
    url: 'http://localhost:4175',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    timeout: 120_000,
  },
})
