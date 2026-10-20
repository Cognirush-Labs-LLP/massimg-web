import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// tests/e2e has no DOM lib (tsconfig.node.json); declared minimally, as the other specs do.
declare const document: { documentElement: { scrollWidth: number; clientWidth: number } }

// A download the browser silently declines is indistinguishable from one that saved: an anchor
// click resolves nothing and throws nothing. So the app keeps the run's outputs after a Download
// instead of deleting them, and keeps the action on screen as "Download again" — pressing it has
// to deliver the same payload a second time, for real. That is what this proves, end to end, in
// each engine: two actual files arrive.
//
// See src/pipeline/run-download.ts for why Share is different (navigator.share() resolves only on
// real acceptance, so that path still cleans up immediately).

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}
function buildPng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 3)
    for (let x = 0; x < w; x += 1) {
      const p = row + 1 + x * 3
      raw[p] = (x * 7) % 256
      raw[p + 1] = (y * 5) % 256
      raw[p + 2] = (x + y) % 256
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('Download stays available after the first attempt and delivers again (R-X42)', async ({
  page,
}) => {
  test.slow()
  const dir = mkdtempSync(join(tmpdir(), 'retry-'))
  const png = buildPng(320, 240)
  const a = join(dir, 'a.png')
  const b = join(dir, 'b.png')
  writeFileSync(a, png)
  writeFileSync(b, png)
  const downloads: string[] = []
  page.on('download', (d) => downloads.push(d.suggestedFilename()))

  await page.goto('/')
  const cp = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await cp).setFiles([a, b])
  await expect(page.getByTestId('primary-action-meta')).toContainText('2 images')
  await page.getByRole('button', { name: /^Compress/ }).click()

  const download = page.getByTestId('processing-download')
  await expect(download).toBeVisible({ timeout: 120_000 })
  await download.click()
  await expect(page.getByTestId('processing-delivered')).toBeVisible()

  await expect(download).toHaveText('Download again')
  await download.click()
  await expect.poll(() => downloads.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

  // The delivered row holds three things — Back to images, the checked line and the retry — in a
  // stage column capped at 520px. Before this was allowed to wrap as a row, the flex items were
  // squeezed instead and their labels broke onto a second line ("Back to images" measured 96x58
  // at 390px instead of 155x44). Buttons keep their own height at every width; the row wraps.
  for (const width of [1440, 900, 600, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const back = await page.getByTestId('processing-back').boundingBox()
    const retry = await page.getByTestId('processing-download').boundingBox()

    expect(back?.height, `Back to images is one line at ${width}px`).toBeLessThanOrEqual(48)
    expect(retry?.height, `Download again is one line at ${width}px`).toBeLessThanOrEqual(48)
  }

  // ...and no width makes the page scroll sideways to accommodate it.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
