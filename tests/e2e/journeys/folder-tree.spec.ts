import { expect, test } from '@playwright/test'
import { skipWebKitOutsideMac } from '../webkit-platform'
import {
  buildPng,
  downloadResult,
  pressCompress,
  readZip,
  scratchDir,
  selectFolder,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: a whole folder tree (T51, R-I27 to R-I30, R-X22). The tree's shape must survive into
// the ZIP, hidden and system entries must never be read, and two files sharing a base name in
// different directories must not be renamed — a collision only exists within one directory.

test('a nested folder keeps its tree in the ZIP, skips hidden files and renames nothing across directories', async ({
  page,
}, testInfo) => {
  skipWebKitOutsideMac(
    testInfo.project.name,
    'the page intermittently stops answering Playwright after a folder selection (about 3% of runs)',
  )
  test.slow()
  const root = scratchDir('folder')
  writeAt(root, 'album/photo.png', buildPng(200, 150, 1))
  writeAt(root, 'album/sub/photo.png', buildPng(200, 150, 2))
  writeAt(root, 'album/sub/deeper/last.png', buildPng(200, 150, 3))
  writeAt(root, 'album/.hidden.png', buildPng(200, 150, 4))
  writeAt(root, 'album/Thumbs.db', 'not an image')
  writeAt(root, 'album/.git/ignored.png', buildPng(200, 150, 5))

  await page.goto('/')
  await selectFolder(page, `${root}/album`)

  await expect(page.getByTestId('gallery-root')).toBeVisible()
  await expect(page.getByTestId('primary-action-meta')).toContainText('3 images')

  await pressCompress(page)
  await waitForRunFinished(page)
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('3 succeeded')

  const { bytes } = await downloadResult(page)
  const names = readZip(bytes)
    .map((entry) => entry.name)
    .sort()

  expect(names).toEqual([
    'album/photo.png',
    'album/sub/deeper/last.png',
    'album/sub/photo.png',
    'image_compression_report.txt',
  ])
})
