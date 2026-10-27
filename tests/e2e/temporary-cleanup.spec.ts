import { expect, test, type Page } from '@playwright/test'
import {
  buildPng,
  downloadResult,
  pressCompress,
  scratchDir,
  selectFiles,
  stubShare,
  waitForRunFinished,
  writeAt,
} from './journeys/support'

declare const innerWidth: number
declare function getComputedStyle(element: unknown): {
  backgroundColor: string
  borderTopWidth: string
}

const SOURCE_PATH = '/src/platform/source-files.ts'
const OUTPUT_PATH = '/src/platform/opfs.ts'

async function sourceCount(page: Page): Promise<number> {
  return page.evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('icompress-sources', 1)
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('sources', 'readonly');
      const count = tx.objectStore('sources').count();
      count.onsuccess = () => resolve(count.result);
      tx.oncomplete = () => db.close();
      tx.onabort = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  })`)
}

async function outputsRemain(page: Page): Promise<boolean> {
  return page.evaluate(async (path) => {
    const storage = await import(/* @vite-ignore */ path)
    try {
      if ((await storage.readOutputCopies()).length > 0) return true
      return (await storage.readArchive()).size > 0
    } catch {
      return false
    }
  }, OUTPUT_PATH)
}

async function finish(page: Page, count = 1): Promise<string[]> {
  const dir = scratchDir('temporary-cleanup')
  const files = Array.from({ length: count }, (_, index) =>
    writeAt(dir, `image-${index}.png`, buildPng(200, 150, index)),
  )
  await page.goto('/')
  await selectFiles(page, files)
  await pressCompress(page)
  await waitForRunFinished(page)
  return files
}

for (const count of [1, 2]) {
  test(`clears a downloaded ${count === 1 ? 'image' : 'ZIP'}, preserves settings, and supports another batch`, async ({
    page,
  }) => {
    test.slow()
    const files = await finish(page, count)
    await expect(page.getByTestId('processing-cleanup')).toHaveCount(0)
    await downloadResult(page)
    await expect(page.getByTestId('processing-cleanup')).toBeVisible()
    expect(await sourceCount(page)).toBe(count)
    expect(await outputsRemain(page)).toBe(true)
    const settingsPath = '/src/stores/settings.ts'
    const before = await page.evaluate(async (path) => {
      const { useSettingsStore } = await import(/* @vite-ignore */ path)
      return JSON.stringify(useSettingsStore().batch)
    }, settingsPath)
    await page.getByTestId('processing-clear-temporary').click()
    await expect(page.getByRole('button', { name: 'Select images', exact: true })).toBeVisible()
    expect(await sourceCount(page)).toBe(0)
    expect(await outputsRemain(page)).toBe(false)
    expect(
      await page.evaluate(async (path) => {
        const { useSettingsStore } = await import(/* @vite-ignore */ path)
        return JSON.stringify(useSettingsStore().batch)
      }, settingsPath),
    ).toBe(before)
    await selectFiles(page, [files[0]!])
    await pressCompress(page)
    await waitForRunFinished(page)
    await expect(page.getByTestId('processing-figure-succeeded')).toContainText('1 succeeded')
  })
}

test('clears a shared batch only after the user explicitly requests it', async ({ page }) => {
  test.slow()
  await stubShare(page, 'resolve')
  await finish(page, 2)
  await page.getByTestId('processing-share').click()
  await expect(page.getByTestId('processing-delivered')).toContainText('Shared')
  expect(await outputsRemain(page)).toBe(true)
  expect(await sourceCount(page)).toBe(2)
  await page.getByTestId('processing-clear-temporary').click()
  await expect(page.getByRole('button', { name: 'Select images', exact: true })).toBeVisible()
  expect(await sourceCount(page)).toBe(0)
  expect(await outputsRemain(page)).toBe(false)
})

test('help follows the dimension dialog pattern and the secondary action fits a narrow viewport', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 360, height: 800 })
  await stubShare(page, 'resolve')
  await finish(page)
  await downloadResult(page)
  const help = page.getByTestId('processing-cleanup-help')
  await help.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('help-dialog')
  await expect(dialog).toContainText('Wait until saving or sharing has finished')
  await expect(dialog).toContainText('not guaranteed')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(help).toBeFocused()
  await help.click()
  await page.getByTestId('help-dialog-close').click()
  await expect(help).toBeFocused()
  await help.click()
  await page.getByTestId('help-dialog-scrim').click({ position: { x: 5, y: 5 } })
  await expect(help).toBeFocused()
  const style = await page.getByTestId('processing-clear-temporary').evaluate((element) => {
    const s = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      background: s.backgroundColor,
      border: s.borderTopWidth,
      height: box.height,
      fits: box.left >= 0 && box.right <= innerWidth,
    }
  })
  const downloadStyle = await page.getByTestId('processing-download').evaluate((element) => {
    const s = getComputedStyle(element)
    return { background: s.backgroundColor, border: s.borderTopWidth }
  })
  expect(style).toMatchObject({ ...downloadStyle, border: '1px', fits: true })
  const helpHeight = (await help.boundingBox())?.height ?? 0
  expect(Math.abs(style.height - helpHeight)).toBeLessThanOrEqual(1)
  expect(await sourceCount(page)).toBe(1)
})

test('an aborted source deletion keeps the entire batch and permits cleanup retry', async ({
  page,
}) => {
  test.slow()
  await finish(page, 2)
  await downloadResult(page)
  await page.evaluate(`(() => {
    const remove = IDBObjectStore.prototype.delete;
    let count = 0;
    IDBObjectStore.prototype.delete = function(key) {
      if (this.name === 'sources' && ++count === 2) {
        IDBObjectStore.prototype.delete = remove;
        throw new DOMException('Blocked cleanup', 'SecurityError');
      }
      return remove.call(this, key);
    };
  })()`)
  await page.getByTestId('processing-clear-temporary').click()
  await expect(page.getByTestId('processing-cleanup-error')).toContainText('browser settings')
  await expect(page.getByTestId('processing-download')).toBeDisabled()
  await expect(page.getByTestId('processing-back')).toBeEnabled()
  expect(await sourceCount(page)).toBe(2)
  const sourcesReadable = await page.evaluate(async (path) => {
    const batchPath = '/src/stores/batch.ts'
    const { useBatchStore } = await import(/* @vite-ignore */ batchPath)
    const { getSourceFile } = await import(/* @vite-ignore */ path)
    return Promise.all(
      useBatchStore().images.map(
        async ({ id }: { id: string }) =>
          (await (await getSourceFile(id)).arrayBuffer()).byteLength > 0,
      ),
    )
  }, SOURCE_PATH)
  expect(sourcesReadable).toEqual([true, true])
  expect(await outputsRemain(page)).toBe(false)
  await page.getByTestId('processing-clear-temporary').click()
  await expect(page.getByRole('button', { name: 'Select images', exact: true })).toBeVisible()
  expect(await sourceCount(page)).toBe(0)
})

test('clearing one completed tab leaves another tab’s selected source and downloadable output intact', async ({
  page,
  context,
}) => {
  test.slow()
  await finish(page)
  await downloadResult(page)
  const other = await context.newPage()
  await finish(other)
  expect(await sourceCount(page)).toBe(2)
  expect(await outputsRemain(page)).toBe(true)
  await page.bringToFront()
  await page.getByTestId('processing-clear-temporary').click()
  await expect(page.getByRole('button', { name: 'Select images', exact: true })).toBeVisible()
  expect(await sourceCount(other)).toBe(1)
  expect(await outputsRemain(other)).toBe(true)
  await other.bringToFront()
  const delivered = await downloadResult(other)
  expect(delivered.bytes.length).toBeGreaterThan(0)
  await other.getByTestId('processing-back').click()
  await expect(other.getByTestId('gallery-root')).toBeVisible()
  await other.close()
})
