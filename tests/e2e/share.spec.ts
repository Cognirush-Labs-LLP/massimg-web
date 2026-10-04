import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firefox, test, expect, type Page } from '@playwright/test'

// T40 — platform/share.ts. Same DOM/dynamic-import constraint as capability.spec.ts (tests/e2e/**
// has no DOM lib and can't statically import src/platform/*.ts): the module is loaded inside the
// page via a dynamic import of its served path.
const SHARE_MODULE_PATH = '/src/platform/share.ts'

async function probe(page: Page, formats: string[]): Promise<boolean> {
  await page.goto('/')
  return page.evaluate(
    ({ path, formats: f }) =>
      import(/* @vite-ignore */ path).then((m) => m.probeFileShareForRun(f)),
    { path: SHARE_MODULE_PATH, formats },
  )
}

test('is false with no formats, regardless of platform support', async ({ page }) => {
  expect(await probe(page, [])).toBe(false)
})

test('is always false on Firefox: no navigator.share support for files at all', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'firefox', 'Firefox-only: T39-A found hasShare: false')

  expect(await probe(page, ['jpeg'])).toBe(false)
  expect(await probe(page, ['jpeg', 'png', 'webp', 'avif', 'gif'])).toBe(false)
})

test('is true on WebKit for a real resolved format, matching real desktop Safari (T39-A)', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit',
    'WebKit-only: the one engine whose bundled build reports fileShare: true',
  )

  expect(await probe(page, ['jpeg'])).toBe(true)
  expect(await probe(page, ['jpeg', 'png', 'webp', 'avif', 'gif'])).toBe(true)
})

test("is false on Chromium: Playwright's bundled build has no OS-level share target (unlike real Chrome)", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'Chromium-only: see capability.spec.ts for the same finding',
  )

  expect(await probe(page, ['jpeg'])).toBe(false)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires literal `{}` here; no fixtures needed.
test('does not throw in real Firefox private browsing, where OPFS is absent', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'firefox', 'Firefox-only: exercises the fallback via B3')

  const userDataDir = await mkdtemp(join(tmpdir(), 'icompress-e2e-share-firefox-private-'))
  try {
    const context = await firefox.launchPersistentContext(userDataDir, {
      firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true },
    })
    try {
      const page = await context.newPage()
      // probeFileShareForRun does not itself touch OPFS, but it shares a module with capability.ts's
      // cached detection — this just proves the probe degrades to false rather than throwing when
      // the generic Capabilities.fileShare flag is unavailable.
      await expect(probe(page, ['jpeg'])).resolves.toBe(false)
    } finally {
      await context.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
