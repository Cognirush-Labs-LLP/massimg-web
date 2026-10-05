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

      await mod.deleteRunArtifacts()
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

test('writes, reads back and cleans up individual output copies via real OPFS', async ({
  page: fixturePage,
}, testInfo) => {
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    await page.goto('/')
    const result = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)

      await mod.writeOutputCopy(0, new Uint8Array([1, 2, 3]), {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
      })
      await mod.writeOutputCopy(1, new Uint8Array([4, 5]), {
        name: 'photo-1.jpg',
        mimeType: 'image/jpeg',
      })

      const beforeDelete = await mod.readOutputCopies()
      const beforeNamesAndSizes = beforeDelete.map((f: File) => [f.name, f.type, f.size])

      await mod.deleteOutputCopy(0)
      const afterDeleteOne = await mod.readOutputCopies()
      const afterDeleteOneNames = afterDeleteOne.map((f: File) => f.name)

      await mod.deleteRunArtifacts()
      const afterFullCleanup = await mod.readOutputCopies()

      return {
        beforeNamesAndSizes,
        afterDeleteOneNames,
        afterFullCleanupLength: afterFullCleanup.length,
      }
    }, OPFS_MODULE_PATH)

    expect(result.beforeNamesAndSizes).toEqual([
      ['photo.jpg', 'image/jpeg', 3],
      ['photo-1.jpg', 'image/jpeg', 2],
    ])
    expect(result.afterDeleteOneNames).toEqual(['photo-1.jpg'])
    expect(result.afterFullCleanupLength).toBe(0)
  } finally {
    await cleanup()
  }
})

test('deleteRunArtifacts removes the archive and every output copy together', async ({
  page: fixturePage,
}, testInfo) => {
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    await page.goto('/')
    const result = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)

      await mod.writeArchive(new Blob([new Uint8Array([9, 9])]).stream())
      await mod.writeOutputCopy(0, new Uint8Array([1]), { name: 'a.png', mimeType: 'image/png' })
      await mod.deleteRunArtifacts()

      let archiveReadThrew = false
      try {
        await mod.readArchive()
      } catch {
        archiveReadThrew = true
      }

      const copies = await mod.readOutputCopies()
      return { archiveReadThrew, copiesLength: copies.length }
    }, OPFS_MODULE_PATH)

    expect(result.archiveReadThrew).toBe(true)
    expect(result.copiesLength).toBe(0)
  } finally {
    await cleanup()
  }
})

// T42, R-X48: "removes the individual share copies and leaves Download unchanged". The archive
// surviving is the whole point — deleteRunArtifacts would take it with the copies.
test('deleteAllOutputCopies removes every copy and leaves the archive alone', async ({
  page: fixturePage,
}, testInfo) => {
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    await page.goto('/')
    const result = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)

      await mod.writeArchive(new Blob([new Uint8Array([9, 9, 9])]).stream())
      // Sparse, non-zero-based indices: a Share-eligible run writes each copy at its image's grid
      // position, so index 0 need not exist at all.
      await mod.writeOutputCopy(1, new Uint8Array([1]), { name: 'b.png', mimeType: 'image/png' })
      await mod.writeOutputCopy(3, new Uint8Array([2, 2]), {
        name: 'd.png',
        mimeType: 'image/png',
      })

      const before = (await mod.readOutputCopies()).length
      await mod.deleteAllOutputCopies()
      const after = (await mod.readOutputCopies()).length
      const archiveSize = (await mod.readArchive()).size

      // Idempotent, like every other cleanup operation in this module.
      await mod.deleteAllOutputCopies()

      await mod.deleteRunArtifacts()
      return { before, after, archiveSize }
    }, OPFS_MODULE_PATH)

    expect(result.before).toBe(2)
    expect(result.after).toBe(0)
    expect(result.archiveSize).toBe(3)
  } finally {
    await cleanup()
  }
})

test('checkCombinedQuota distinguishes archive failure from share-only failure', async ({
  page: fixturePage,
}, testInfo) => {
  const { page, cleanup } = await getRealOpfsPage(fixturePage, testInfo)
  try {
    await page.goto('/')
    const result = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)
      const { quota, usage } = await mod.estimateQuota()
      const available = quota - usage

      // Small enough to fit alone; combined with a share-copy allowance larger than everything
      // left over, only the combined figure should fail.
      const archiveOnlyFits = await mod.checkCombinedQuota(1024, available)
      // Larger than the whole quota: both figures fail.
      const archiveItselfFails = await mod.checkCombinedQuota(available + quota, 0)

      return { archiveOnlyFits, archiveItselfFails }
    }, OPFS_MODULE_PATH)

    expect(result.archiveOnlyFits.archive.ok).toBe(true)
    expect(result.archiveOnlyFits.combined.ok).toBe(false)
    expect(result.archiveItselfFails.archive.ok).toBe(false)
    expect(result.archiveItselfFails.combined.ok).toBe(false)
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

      const copies = await page.evaluate(async (path) => {
        const mod = await import(/* @vite-ignore */ path)
        await mod.writeOutputCopy(0, new Uint8Array([7]), { name: 'a.png', mimeType: 'image/png' })
        const before = await mod.readOutputCopies()
        await mod.deleteRunArtifacts()
        const after = await mod.readOutputCopies()
        return {
          beforeLength: before.length,
          beforeName: before[0]?.name,
          afterLength: after.length,
        }
      }, OPFS_MODULE_PATH)
      expect(copies).toEqual({ beforeLength: 1, beforeName: 'a.png', afterLength: 0 })

      // T42: `deleteAllOutputCopies` reads its index set from a different place on each backend
      // (`outputMeta` is OPFS-only), so the fallback needs its own proof that it isn't a no-op
      // here (R-X41).
      const shareOnlyCleanup = await page.evaluate(async (path) => {
        const mod = await import(/* @vite-ignore */ path)
        await mod.writeArchive(new Blob([new Uint8Array([9, 9, 9])]).stream())
        await mod.writeOutputCopy(2, new Uint8Array([8]), { name: 'c.png', mimeType: 'image/png' })
        await mod.deleteAllOutputCopies()
        const after = await mod.readOutputCopies()
        const archiveSize = (await mod.readArchive()).size
        await mod.deleteRunArtifacts()
        return { afterLength: after.length, archiveSize }
      }, OPFS_MODULE_PATH)
      expect(shareOnlyCleanup).toEqual({ afterLength: 0, archiveSize: 3 })
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
