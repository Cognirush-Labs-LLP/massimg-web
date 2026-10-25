import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const SOURCES_PATH = '/src/platform/source-files.ts'
const COPIES_PATH = '/src/platform/source-copies.ts'
const fixture = fileURLToPath(new URL('../fixtures/decode/orientation-absent.jpg', import.meta.url))

async function countCopies(page: Page): Promise<number> {
  return page.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('icompress-sources', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('sources', 'readonly')
      const count = transaction.objectStore('sources').count()
      count.onsuccess = () => resolve(count.result)
      count.onerror = () => reject(count.error)
      transaction.oncomplete = () => db.close()
    }
  })`)
}

async function storeSource(page: Page): Promise<void> {
  await page.evaluate(async (path) => {
    const { preserveSourceFile } = await import(/* @vite-ignore */ path)
    const bytes = new Uint8Array([0, 17, 255, 4])
    await preserveSourceFile(
      'source-a',
      new File([bytes], 'photo.JPG', { type: 'image/jpeg', lastModified: 1234 }),
      bytes,
    )
  }, SOURCES_PATH)
}

test('source copies preserve bytes and metadata and are released on removal and clear', async ({
  page,
}) => {
  await page.goto('/')
  await storeSource(page)

  const copy = await page.evaluate(async (path) => {
    const { getSourceFile } = await import(/* @vite-ignore */ path)
    const file = await getSourceFile('source-a')
    return {
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    }
  }, SOURCES_PATH)
  expect(copy).toEqual({
    name: 'photo.JPG',
    type: 'image/jpeg',
    lastModified: 1234,
    bytes: [0, 17, 255, 4],
  })
  expect(await countCopies(page)).toBe(1)

  await page.evaluate(async (path) => {
    const { deleteSourceFile } = await import(/* @vite-ignore */ path)
    deleteSourceFile('source-a')
  }, SOURCES_PATH)
  await expect.poll(() => countCopies(page)).toBe(0)

  await storeSource(page)
  await page.evaluate(async (path) => {
    const { clearSourceFiles } = await import(/* @vite-ignore */ path)
    clearSourceFiles()
  }, SOURCES_PATH)
  await expect.poll(() => countCopies(page)).toBe(0)
})

test('cleanup removes abandoned copies while protecting another tab and its sources', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await storeSource(page)
  const second = await context.newPage()
  await second.goto('/')
  await second.evaluate(async (path) => {
    const { cleanupAbandonedSourceCopies } = await import(/* @vite-ignore */ path)
    await cleanupAbandonedSourceCopies()
  }, COPIES_PATH)
  expect(await countCopies(second)).toBe(1)

  await second.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('icompress-sources', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('sources', 'readwrite')
      transaction.objectStore('sources').put({
        session: 'abandoned-session', id: 'old-source', bytes: new Uint8Array([1])
      })
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onabort = () => reject(transaction.error)
    }
  })`)
  expect(await countCopies(second)).toBe(2)
  await second.evaluate(async (path) => {
    const { cleanupAbandonedSourceCopies } = await import(/* @vite-ignore */ path)
    await cleanupAbandonedSourceCopies()
  }, COPIES_PATH)
  expect(await countCopies(second)).toBe(1)
  expect(
    await page.evaluate(async (path) => {
      const { getSourceFile } = await import(/* @vite-ignore */ path)
      return Array.from(new Uint8Array(await (await getSourceFile('source-a')).arrayBuffer()))
    }, SOURCES_PATH),
  ).toEqual([0, 17, 255, 4])

  await page.close()
  await expect
    .poll(async () => {
      await second.evaluate(async (path) => {
        const { cleanupAbandonedSourceCopies } = await import(/* @vite-ignore */ path)
        await cleanupAbandonedSourceCopies()
      }, COPIES_PATH)
      return countCopies(second)
    })
    .toBe(0)
})

test('a source copy completing after Clear is discarded', async ({ page }) => {
  await page.goto('/')
  expect(
    await page.evaluate(async (path) => {
      const { preserveSourceFile, clearSourceFiles, getSourceFile } = await import(
        /* @vite-ignore */ path
      )
      const copying = preserveSourceFile(
        'cancelled-source',
        new File(['a'], 'a.jpg'),
        new Uint8Array([97]),
      )
      clearSourceFiles()
      return {
        discarded: (await copying) === undefined,
        missing: !(await getSourceFile('cancelled-source')),
      }
    }, SOURCES_PATH),
  ).toEqual({ discarded: true, missing: true })
  await expect.poll(() => countCopies(page)).toBe(0)
})

test('Preview, Original, repeated compression, and Gallery survive loss of the picker reference', async ({
  page,
}) => {
  test.slow()
  // Desktop automation cannot create Android's changing photo-provider reference. Fail any
  // second read of the actual picker File so retaining that reference fails this same journey.
  await page.addInitScript(`
    window.pickerSourceReads = 0
    document.addEventListener('change', event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'file') return
      for (const file of event.target.files) {
        const read = file.arrayBuffer.bind(file)
        file.arrayBuffer = async () => {
          window.pickerSourceReads += 1
          if (window.pickerSourceReads > 1) throw new DOMException('Source changed', 'NotReadableError')
          return read()
        }
      }
    }, true)
  `)
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images', exact: true }).click()
  await (await chooser).setFiles(fixture)
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'compressed')
  await page.getByTestId('preview-comparison-toggle').click()
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'original')
  await expect(page.getByTestId('preview-image')).toBeVisible()

  for (let run = 0; run < 2; run += 1) {
    await page.getByRole('button', { name: 'Compress (1)', exact: true }).click()
    await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('1 succeeded')
    await expect(page.getByTestId('processing-figure-failed')).toHaveText('0 failed')
    await page.getByTestId('processing-back').click()
    await page.getByTestId('gallery-tile-open').click()
    await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'compressed')
  }

  expect(await page.evaluate('window.pickerSourceReads')).toBe(1)
  await page.getByTestId('preview-back').click()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect.poll(() => countCopies(page)).toBe(0)
})

test('unavailable source storage rejects the image and selection can be retried after recovery', async ({
  page,
}) => {
  await page.addInitScript(`
    const available = window.indexedDB
    window.sourceStorageAllowed = false
    const blocked = {
      open() { throw new DOMException('Storage blocked', 'SecurityError') }
    }
    Object.defineProperty(window, 'indexedDB', {
      get: () => window.sourceStorageAllowed ? available : blocked
    })
  `)
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images', exact: true }).click()
  await (await chooser).setFiles(fixture)
  await expect(page.getByText(/could not keep a temporary local copy/)).toBeVisible()
  await expect(page.getByTestId('gallery-empty-state')).toBeVisible()
  await expect(page.getByTestId('preview-root')).toHaveCount(0)

  await page.evaluate('window.sourceStorageAllowed = true')
  const retry = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images', exact: true }).click()
  await (await retry).setFiles(fixture)
  await expect(page.getByTestId('preview-image')).toHaveAttribute('data-tab', 'compressed')
})
