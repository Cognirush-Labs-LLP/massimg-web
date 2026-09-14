import { defineConfig, devices } from '@playwright/test'

// Permanent browser/e2e suite (AGENTS.md repository layout: tests/ from T05
// onward), distinct from the throwaway verification/ harnesses of Phase 0.
// Technical Design §13 "Browser" row: Playwright, Chromium/Firefox/WebKit.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Vite's dev server, not a preview of a production build: `check` (vue-tsc
  // + ESLint + Prettier) already runs as its own CI step, and `build` is not
  // otherwise required for this task, so the webServer command stays to just
  // the dev server rather than paying for a full `vite build` on every e2e
  // run. See docs/task-notes/T05.md, Decisions made.
  webServer: {
    command: 'vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
  },
})
