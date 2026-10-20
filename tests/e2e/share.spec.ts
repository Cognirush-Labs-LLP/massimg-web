import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firefox, test, expect, type Page } from '@playwright/test'
import { isSafariLikeWebKit, skipWebKitOutsideMac } from './webkit-platform'

// T40/T42 — platform/share.ts. Same DOM/dynamic-import constraint as capability.spec.ts
// (tests/e2e/** has no DOM lib and can't statically import src/platform/*.ts): the module is
// loaded inside the page via a dynamic import of its served path.
const SHARE_MODULE_PATH = '/src/platform/share.ts'

async function probe(page: Page, formats: string[]): Promise<boolean> {
  await page.goto('/')
  return page.evaluate(
    ({ path, formats: f }) =>
      import(/* @vite-ignore */ path).then((m) => m.probeFileShareForRun(f)),
    { path: SHARE_MODULE_PATH, formats },
  )
}

/**
 * T42's exact completion-time check (R-X48), against real `File`s of the given MIME types built
 * inside the page. `canShare` inspects `File.type` and size, not pixel validity (T39-A), so a
 * small non-empty buffer per entry is a faithful stand-in for a real encoded image here.
 *
 * `share()` itself is deliberately not exercised: it needs a real user activation *and* a real OS
 * share target, and T39-A already measured it on real hardware precisely because a headless
 * engine cannot stand in for one.
 */
async function canShareExact(page: Page, mimeTypes: string[]): Promise<boolean> {
  await page.goto('/')
  return page.evaluate(
    ({ path, mimeTypes: types }) =>
      import(/* @vite-ignore */ path).then((m) =>
        m.canShareExactFiles(
          types.map(
            (type: string, index: number) =>
              new File([new Uint8Array([1, 2, 3])], `output-${index}`, { type }),
          ),
        ),
      ),
    { path: SHARE_MODULE_PATH, mimeTypes },
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
  skipWebKitOutsideMac(testInfo.project.name, 'Linux has no system share sheet to accept files')

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

test('the exact check is false for an empty payload on every engine (T42, R-X48)', async ({
  page,
}) => {
  // Three distinct states, one answer: absent API, empty payload, rejected payload all read as
  // "no Share". This case is the middle one — nothing succeeded, or the byte ceiling already
  // excluded the run — and must never reach the browser as a question.
  expect(await canShareExact(page, [])).toBe(false)
})

test('the exact check agrees with the preliminary probe on this engine (T42)', async ({
  page,
}, testInfo) => {
  // Not a tautology: the two use different payloads (one representative file per format vs. the
  // real completed array) and T39-A found a browser can accept one and reject the other. Where
  // they *do* agree, that agreement is the useful recorded fact per engine.
  // macOS WebKit only: on Linux the same project has no system share sheet and answers `false`
  // to both, which is still an agreement worth asserting — hence an adjusted expectation here
  // rather than a skip.
  const expected = isSafariLikeWebKit(testInfo.project.name)
  expect(await probe(page, ['jpeg'])).toBe(expected)
  expect(await canShareExact(page, ['image/jpeg'])).toBe(expected)
})

test('the exact check accepts a real ten-file mixed-format payload on WebKit (T39-A)', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit',
    'WebKit-only: the one bundled engine that reports fileShare: true',
  )
  skipWebKitOutsideMac(testInfo.project.name, 'Linux has no system share sheet to accept files')

  const mimeTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
  ]
  expect(mimeTypes).toHaveLength(10) // R-X47's product ceiling, exercised at the ceiling
  expect(await canShareExact(page, mimeTypes)).toBe(true)
})

test('the exact check is false on Chromium and Firefox, for different reasons (T40)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'webkit', 'WebKit accepts files; covered above')

  // Firefox has no file sharing at all; Chromium's bundled build has no OS-level share target.
  expect(await canShareExact(page, ['image/jpeg'])).toBe(false)
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
