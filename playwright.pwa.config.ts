import { defineConfig, devices } from '@playwright/test'

// T46, Technical Design §12.6, assumption F2 (docs/assumptions.md). Separate from
// playwright.config.ts on purpose: that config deliberately runs every spec against the
// plain `vite` dev server (T05's recorded decision, to avoid paying for a full production
// build on every e2e run), but `vite-plugin-pwa`'s generated service worker is a
// production-build artifact — the dev server has no real precache manifest, so F2's test
// ("a page load served entirely from the service worker's cache") cannot be verified
// against it. This config pays for one `pnpm build` and runs only the PWA/offline spec
// against the real built output via `vite preview`.
export default defineConfig({
  testDir: './tests/e2e-pwa',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'on-first-retry',
  },
  // No webkit project: `context.setOffline(true)` followed by any navigation at all —
  // confirmed with a minimal repro with no service worker involved — throws "WebKit
  // encountered an internal error" in Playwright 1.63's WebKit driver. Real Safari's own
  // offline/service-worker support is not in question; this is specifically Playwright's
  // WebKit automation that can't drive this scenario. Tracked as a tooling gap in
  // docs/task-notes/T46.md rather than worked around with a weaker assertion.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: 'pnpm build && vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    timeout: 120_000,
  },
})
