import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firefox, webkit, test, expect, type Page, type TestInfo } from '@playwright/test'

// T19 — platform/opfs.ts. Same DOM/dynamic-import constraint as capability.spec.ts, picker.spec.ts
// and folder.spec.ts (see their header comments): tests/e2e/** has no DOM lib and can't statically
// import src/platform/*.ts, so the module is loaded inside the page via a dynamic import of its
// served path, path passed as a function parameter. Results are mapped to plain, JSON-serializable
// shapes inside page.evaluate before returning — a Blob's own data never crosses back to Node (only
// values read out of it, like .size and sampled bytes, do).
const OPFS_MODULE_PATH = '/src/platform/opfs.ts'

const REAL_CHUNK_SIZE = 32 * 1024 * 1024
const REAL_CHUNK_COUNT = 10 // 320 MiB total — "multi-hundred-MB" per T19's done-when.

const FALLBACK_CHUNK_SIZE = 1024 * 1024
const FALLBACK_CHUNK_COUNT = 5 // 5 MiB — the fallback test proves the code path, not memory scale.

// WebKit's default Playwright context has no working OPFS at all (T01, docs/task-notes/T01.md);
// only a real, disk-backed profile via launchPersistentContext does. Chromium and Firefox both work
// in the default fixture. This gets a page backed by real OPFS regardless of engine.
async function getRealOpfsPage(
  fixturePage: Page,
  testInfo: TestInfo,
): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  if (testInfo.project.name !== 'webkit') {
    return { page: fixturePage, cleanup: async () => {} }
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'icompress-e2e-opfs-webkit-'))
  const context = await webkit.launchPersistentContext(userDataDir, {})
  const page = await context.newPage()
  return {
    page,
    cleanup: async () => {
      await context.close()
      await rm(userDataDir, { recursive: true, force: true })
    },
  }
}

interface RoundTripResult {
  size: number
  firstByte: number
  lastByte: number
  readAfterDeleteThrew: boolean
}

async function runRoundTrip(
  page: Page,
  chunkSize: number,
  chunkCount: number,
): Promise<RoundTripResult> {
  await page.goto('/')
  return page.evaluate(
    async ({ path, chunkSize: size, chunkCount: count }) => {
      const mod = await import(/* @vite-ignore */ path)

      function buildStream(): ReadableStream<Uint8Array> {
        let i = 0
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i >= count) {
              controller.close()
              return
            }
            const chunk = new Uint8Array(size)
            chunk.fill(i % 256)
            controller.enqueue(chunk)
            i++
          },
        })
      }

      await mod.writeArchive(buildStream())
      const blob: Blob = await mod.readArchive()
      const blobSize = blob.size
      const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer())
      const last = new Uint8Array(await blob.slice(blobSize - 1, blobSize).arrayBuffer())

      await mod.deleteArchive()
      let readAfterDeleteThrew = false
      try {
        await mod.readArchive()
      } catch {
        readAfterDeleteThrew = true
      }

      return {
        size: blobSize,
        firstByte: first[0] as number,
        lastByte: last[0] as number,
        readAfterDeleteThrew,
      }
    },
    { path: OPFS_MODULE_PATH, chunkSize, chunkCount },
  )
}

test('writes, reads back and deletes a multi-hundred-MB archive via real OPFS', async ({
  page: fixturePage,
}, testInfo) => {
  test.setTimeout(180_000)
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    const result = await runRoundTrip(page, REAL_CHUNK_SIZE, REAL_CHUNK_COUNT)

    expect(result.size).toBe(REAL_CHUNK_SIZE * REAL_CHUNK_COUNT)
    expect(result.firstByte).toBe(0)
    expect(result.lastByte).toBe((REAL_CHUNK_COUNT - 1) % 256)
    expect(result.readAfterDeleteThrew).toBe(true)
  } finally {
    await cleanup()
  }
})

test('quota preflight reflects real OPFS quota', async ({ page: fixturePage }, testInfo) => {
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    await page.goto('/')
    const result = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)
      const { usage, quota } = await mod.estimateQuota()
      const rejectHuge = await mod.checkQuota(Number.MAX_SAFE_INTEGER)
      const acceptSmall = await mod.checkQuota(1024)
      return { usage, quota, rejectHuge, acceptSmall }
    }, OPFS_MODULE_PATH)

    expect(result.quota).toBeGreaterThan(0)
    expect(result.rejectHuge.ok).toBe(false)
    expect(result.rejectHuge.required).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.rejectHuge.available).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(result.acceptSmall.ok).toBe(true)
    expect(result.acceptSmall.available).toBeGreaterThanOrEqual(0)
  } finally {
    await cleanup()
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires literal `{}` here; no fixtures needed.
test('falls back to in-memory storage in real Firefox private browsing', async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'firefox',
    'Firefox-only: exercises the fallback via B3 directly',
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'icompress-e2e-opfs-firefox-private-'))
  try {
    const context = await firefox.launchPersistentContext(userDataDir, {
      firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true },
    })
    try {
      const page = await context.newPage()
      const result = await runRoundTrip(page, FALLBACK_CHUNK_SIZE, FALLBACK_CHUNK_COUNT)

      expect(result.size).toBe(FALLBACK_CHUNK_SIZE * FALLBACK_CHUNK_COUNT)
      expect(result.firstByte).toBe(0)
      expect(result.lastByte).toBe(FALLBACK_CHUNK_COUNT - 1)
      expect(result.readAfterDeleteThrew).toBe(true)

      const quota = await page.evaluate(async (path) => {
        const mod = await import(/* @vite-ignore */ path)
        return mod.checkQuota(Number.MAX_SAFE_INTEGER)
      }, OPFS_MODULE_PATH)
      expect(quota.ok).toBe(true)
      expect(quota.available).toBe(Infinity)
    } finally {
      await context.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test("falls back to in-memory storage in WebKit's default ephemeral context", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit',
    'WebKit-only: default context has no OPFS at all (T01)',
  )

  const result = await runRoundTrip(page, FALLBACK_CHUNK_SIZE, FALLBACK_CHUNK_COUNT)

  expect(result.size).toBe(FALLBACK_CHUNK_SIZE * FALLBACK_CHUNK_COUNT)
  expect(result.firstByte).toBe(0)
  expect(result.lastByte).toBe(FALLBACK_CHUNK_COUNT - 1)
  expect(result.readAfterDeleteThrew).toBe(true)

  const quota = await page.evaluate(async (path) => {
    const mod = await import(/* @vite-ignore */ path)
    return mod.checkQuota(Number.MAX_SAFE_INTEGER)
  }, OPFS_MODULE_PATH)
  expect(quota.ok).toBe(true)
  expect(quota.available).toBe(Infinity)
})
