import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firefox, webkit, test, expect, type Page } from '@playwright/test'

// T17 — platform/capability.ts. tests/e2e/** is type-checked by tsconfig.node.json (lib: ES2022,
// no DOM, not project-referenced to tsconfig.app.json), so this file can neither statically import
// src/platform/capability.ts nor reference DOM globals itself. Instead it calls the module inside
// the page via a dynamic import of its served path, run through Vite's dev server (same
// webServer/baseURL as tests/e2e/app.spec.ts). The path must be passed as a function parameter, not
// a string literal — `tsc --strict` only attempts (and fails) static resolution of `import()` when
// given an analyzable literal; a parameter compiles cleanly and still resolves fine at runtime.
const CAPABILITY_MODULE_PATH = '/src/platform/capability.ts'

// Duplicated from src/platform/capability.ts's `Capabilities` — kept in sync by hand, see above for
// why this file can't import the real type.
interface Capabilities {
  opfs: boolean
  folderPicker: boolean
  crossOriginIsolated: boolean
}

async function detect(page: Page): Promise<Capabilities> {
  await page.goto('/')
  return page.evaluate<Capabilities, string>(
    (path) => import(/* @vite-ignore */ path).then((m) => m.detectCapabilities()),
    CAPABILITY_MODULE_PATH,
  )
}

test('detects capabilities in the standard fixture context', async ({ page }, testInfo) => {
  const capabilities = await detect(page)

  expect(capabilities.folderPicker).toBe(true)
  // No COOP/COEP headers until T48 — see docs/assumptions.md B6, B9.
  expect(capabilities.crossOriginIsolated).toBe(false)

  // WebKit's default Playwright context is ephemeral and has no working OPFS at all (T01,
  // docs/task-notes/T01.md) — the same failure mode Safari private windows produce (B3). It stands
  // in here for "private window" on WebKit; the real, working-OPFS case is proven separately below
  // via a persistent-context launch.
  const expectedOpfs = testInfo.project.name !== 'webkit'
  expect(capabilities.opfs).toBe(expectedOpfs)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires literal `{}` here; no fixtures needed.
test('detects OPFS as available on WebKit with a real persistent profile', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'webkit', 'WebKit-only: proves the positive OPFS case')

  const userDataDir = await mkdtemp(join(tmpdir(), 'icompress-e2e-webkit-'))
  try {
    const context = await webkit.launchPersistentContext(userDataDir, {})
    try {
      const page = await context.newPage()
      const capabilities = await detect(page)
      expect(capabilities.opfs).toBe(true)
    } finally {
      await context.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires literal `{}` here; no fixtures needed.
test('detects OPFS as unavailable in real Firefox private browsing', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'firefox', 'Firefox-only: exercises B3 directly')

  const userDataDir = await mkdtemp(join(tmpdir(), 'icompress-e2e-firefox-private-'))
  try {
    const context = await firefox.launchPersistentContext(userDataDir, {
      firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true },
    })
    try {
      const page = await context.newPage()
      const capabilities = await detect(page)
      // B3: "Firefox disables it in private mode." If this ever comes back true, that's a real
      // finding for B3's confidence, not a test bug — see docs/task-notes/T17.md.
      expect(capabilities.opfs).toBe(false)
      expect(capabilities.folderPicker).toBe(true)
      expect(capabilities.crossOriginIsolated).toBe(false)
    } finally {
      await context.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires literal `{}` here; no fixtures needed.
test('has no way to test a real private window on Chromium', ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Only meaningful once, on the chromium project')
  test.skip(
    true,
    'Playwright has no supported API for a genuine Chrome Incognito profile, and B3 does not ' +
      'claim Chromium restricts OPFS in private/incognito browsing — nothing to assert here.',
  )
})
