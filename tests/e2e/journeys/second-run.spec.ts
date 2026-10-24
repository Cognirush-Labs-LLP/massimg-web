import { expect, test, type Page } from '@playwright/test'
import {
  buildPng,
  downloadResult,
  pressCompress,
  RUN_TIMEOUT,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: compress, deliver, go back, and compress the same image again (R-X17).
//
// The edited variant is the one that used to fail: an edit stored on the image picked up a nested
// reactive Proxy when the first run reset its status, and the second run's job then threw
// `DataCloneError` at the worker's `postMessage`, leaving Processing stuck on its pending count.
// Only a real worker clones the job, so this cannot be caught by the unit suite's mocked pool.

async function rotateAndCrop(page: Page): Promise<void> {
  await page.getByTestId('preview-edit').click()
  await expect(page.getByTestId('edit-root')).toBeVisible()
  await page.getByTestId('edit-rotate-right').click()
  await page.getByTestId('edit-width-field').fill('200')
  await page.getByTestId('edit-apply').click()
  await expect(page.getByTestId('preview-edit')).toHaveText('Edit changes')
}

async function compressAndDownload(page: Page): Promise<Buffer> {
  await pressCompress(page)
  await waitForRunFinished(page)
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('1 succeeded')
  await expect(page.getByTestId('processing-figure-pending')).toHaveText('0 pending')

  const delivered = await downloadResult(page)
  expect(delivered.name).toBe('holiday.png')
  return delivered.bytes
}

/** A PNG's IHDR width and height. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

for (const edited of [false, true]) {
  test(`a second Compress after Back runs again, ${edited ? 'with' : 'without'} an edit (R-X17)`, async ({
    page,
  }) => {
    test.slow()
    // Any DataCloneError, not just one that stalls the run: Gallery's thumbnail worker hit the same
    // Proxy after Back to images while the run itself still succeeded. The stack says which path.
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message))

    const dir = scratchDir(edited ? 'second-run-edited' : 'second-run')
    const source = writeAt(dir, 'holiday.png', buildPng(320, 240))

    await page.goto('/')
    await selectFiles(page, [source])
    await expect(page.getByTestId('preview-image')).toBeVisible({ timeout: RUN_TIMEOUT })
    if (edited) {
      await rotateAndCrop(page)
    }

    const first = await compressAndDownload(page)
    await page.getByTestId('processing-back').click()
    await expect(page.getByTestId('processing-root')).toHaveCount(0)

    const second = await compressAndDownload(page)

    // The same edit applied again, not dropped or doubled.
    expect(pngSize(second)).toEqual(pngSize(first))
    if (edited) {
      expect(pngSize(second).width).toBe(200)
    } else {
      expect(pngSize(second)).toEqual({ width: 320, height: 240 })
    }
    expect(errors).toEqual([])
  })
}
