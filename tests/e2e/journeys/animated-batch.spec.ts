import { expect, test } from '@playwright/test'
import {
  downloadResult,
  pressCompress,
  readFixture,
  readZip,
  scratchDir,
  selectFiles,
  waitForRunFinished,
  writeAt,
} from './support'

// Journey: an animated batch (T51, R-X16, animation requirements in Functional Design §7). An
// animated GIF, WebP and APNG go in with the format left alone; each must come out still animated.
//
// Frames are counted from the container's own structure rather than by rendering them: Playwright's
// WebKit on Linux draws animated images as blank pixels (tests/e2e/webkit-platform.ts), so a
// structural count is the one check that means the same thing on every engine and OS.

function countGifFrames(bytes: Buffer): number {
  // Walk the blocks properly: a bare 0x2C byte can occur inside image data or a palette.
  let at = 13
  if (bytes[10]! & 0x80) at += 3 * (1 << ((bytes[10]! & 7) + 1))
  let frames = 0
  while (at < bytes.length) {
    const marker = bytes[at]
    if (marker === 0x3b) break
    if (marker === 0x2c) {
      frames += 1
      const flags = bytes[at + 9]!
      at += 10
      if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1))
      at += 1 // LZW minimum code size
    } else if (marker === 0x21) {
      at += 2 // introducer and label; sub-blocks follow
    } else {
      throw new Error(`unexpected GIF block 0x${marker?.toString(16)} at ${at}`)
    }
    while (bytes[at] !== 0) at += bytes[at]! + 1
    at += 1
  }
  return frames
}

function countChunks(bytes: Buffer, tag: string): number {
  let count = 0
  for (let at = bytes.indexOf(tag, 0, 'ascii'); at >= 0; at = bytes.indexOf(tag, at + 4, 'ascii')) {
    count += 1
  }
  return count
}

test('an animated GIF, WebP and APNG batch comes out still animated', async ({ page }) => {
  test.slow()
  const dir = scratchDir('animated')
  const files = [
    writeAt(dir, 'loop.gif', readFixture('animated', 'anim-6f.gif')),
    writeAt(dir, 'loop.webp', readFixture('animated', 'anim-6f.webp')),
    writeAt(dir, 'loop.png', readFixture('animated', 'anim-6f.png')),
  ]

  await page.goto('/')
  await selectFiles(page, files)
  await expect(page.getByTestId('primary-action-meta')).toContainText('3 images')

  await pressCompress(page)
  await waitForRunFinished(page)
  await expect(page.getByTestId('processing-figure-succeeded')).toHaveText('3 succeeded')
  await expect(page.getByTestId('processing-figure-failed')).toHaveText('0 failed')

  const { bytes } = await downloadResult(page)
  const byName = new Map(readZip(bytes).map((entry) => [entry.name, entry.bytes]))

  expect([...byName.keys()].sort()).toEqual([
    'image_compression_report.txt',
    'loop.gif',
    'loop.png',
    'loop.webp',
  ])

  expect(countGifFrames(byName.get('loop.gif')!)).toBeGreaterThan(1)
  expect(countChunks(byName.get('loop.webp')!, 'ANMF')).toBeGreaterThan(1)
  expect(countChunks(byName.get('loop.png')!, 'fcTL')).toBeGreaterThan(1)
})
