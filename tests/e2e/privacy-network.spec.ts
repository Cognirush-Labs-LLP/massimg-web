import { deflateSync } from 'node:zlib'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Request } from '@playwright/test'

// R-V2, the claim the whole product rests on: "The app sends no image bytes, file names,
// dimensions or sizes over the network, including to analytics." This drives a real run through
// the real UI — select, compress, download — with every request the page and its workers make
// recorded, and then asserts the recording contains none of those four things.
//
// Two assertions here are deliberately narrower than they could be, and must stay that way:
//
//  - The bare dimension numbers (617, 413) are searched for in request *bodies* only, never in
//    URLs. Vite's hashed asset URLs and `?t=` cache-busting timestamps contain arbitrary digit
//    runs, so scanning URLs for a three-digit number manufactures failures that mean nothing.
//    The high-entropy file name covers the URL side properly.
//  - blob: and data: URLs are ignored. They are same-document handoffs (the download anchor,
//    worker bootstraps) and never leave the machine, so counting them as egress would be wrong.
//
// Every assertion is made once the run has finished and its archive exists, before Download is
// pressed: that is where all of the app's work — and so all of its chance to leak — happens.
// Pressing Download then only reads bytes the app already holds, and is exercised afterwards as
// a tolerated extra step, because in Firefox the download navigation tears the page context down
// (the pre-existing download assertion in accessibility.spec.ts fails there for the same
// reason). The log is re-checked after delivery wherever the page survives it.
//
// The site's analytics script is injected by Cloudflare at the edge (Technical Design §12.6), so
// neither this suite nor any local build can observe it.

const ALLOWED_ORIGINS = ['http://localhost:5173']

// Deliberately odd and high-entropy, so a substring match on either cannot be a coincidence.
const SENTINEL_NAME = 'privacy-sentinel-8f21a7.png'
const WIDTH = 617
const HEIGHT = 413

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
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

/** A real WIDTH x HEIGHT RGB PNG, built here so its exact byte length is known in Node. */
function buildSentinelPng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3))
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * (1 + WIDTH * 3)
    for (let x = 0; x < WIDTH; x += 1) {
      const pixel = rowStart + 1 + x * 3
      raw[pixel] = (x * 7 + y * 3) % 256
      raw[pixel + 1] = (x * 3 + y * 11) % 256
      raw[pixel + 2] = (x + y) % 256
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface Recorded {
  url: string
  method: string
  body: string | null
  bodyBytes: number
}

test('no network request carries image bytes, file names, dimensions or sizes (R-V2)', async ({
  page,
}) => {
  test.slow() // The first run fetches the ImageMagick WASM build.

  const dir = mkdtempSync(join(tmpdir(), 'privacy-network-'))
  const png = buildSentinelPng()
  // Two files, not one: a batch of exactly one auto-opens Preview (R-M1) instead of Gallery.
  const first = join(dir, SENTINEL_NAME)
  const second = join(dir, `second-${SENTINEL_NAME}`)
  writeFileSync(first, png)
  writeFileSync(second, png)
  const inputBytes = statSync(first).size

  const recorded: Recorded[] = []
  // Context level, not page level: the pipeline runs in module workers, and worker traffic does
  // not surface on the page's own request event.
  page.context().on('request', (request: Request) => {
    const buffer = request.postDataBuffer()
    recorded.push({
      url: request.url(),
      method: request.method(),
      body: buffer === null ? null : buffer.toString('utf8'),
      bodyBytes: buffer?.byteLength ?? 0,
    })
  })

  await page.goto('/')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooserPromise).setFiles([first, second])
  await expect(page.getByTestId('primary-action-meta')).toContainText('2 images')

  await page.getByRole('button', { name: /^Compress/ }).click()
  const download = page.getByTestId('processing-download')
  await expect(download).toBeVisible({ timeout: 120_000 })
  // Non-vacuity: both images really were compressed, so the run this test inspects did happen.
  await expect(page.getByTestId('processing-figure-succeeded')).toContainText('2')
  expect(recorded.some((entry) => entry.url.endsWith('.wasm'))).toBe(true)

  function networkRequests(): Recorded[] {
    return recorded.filter(
      (entry) => !entry.url.startsWith('blob:') && !entry.url.startsWith('data:'),
    )
  }

  const network = networkRequests()
  expect(network.length).toBeGreaterThan(0)

  // 1. No file name, anywhere.
  for (const entry of network) {
    expect(entry.url, 'request URL names no file').not.toContain('privacy-sentinel')
    expect(entry.url).not.toContain('8f21a7')
    expect(entry.body ?? '', 'request body names no file').not.toContain('privacy-sentinel')
    expect(entry.body ?? '').not.toContain('8f21a7')
  }

  // 2. No dimensions, as a formatted pair anywhere or as bare numbers in a body.
  for (const entry of network) {
    for (const pair of [`${WIDTH}x${HEIGHT}`, `${WIDTH}×${HEIGHT}`]) {
      expect(entry.url).not.toContain(pair)
      expect(entry.body ?? '').not.toContain(pair)
    }
    expect(entry.body ?? '').not.toContain(String(WIDTH))
    expect(entry.body ?? '').not.toContain(String(HEIGHT))
  }

  // 3. No sizes. Only the input's exact byte length can be named here; the output's is covered
  //    by assertion 4, which rules out every request body rather than one number.
  for (const entry of network) {
    expect(entry.url).not.toContain(String(inputBytes))
    expect(entry.body ?? '').not.toContain(String(inputBytes))
  }

  // 4. No request carries a body at all. A local-processing app that never POSTs anything is
  //    the strongest form of this claim, and it subsumes "no body is image-sized".
  const withBodies = network.filter((entry) => entry.bodyBytes > 0)
  expect(
    withBodies.map((entry) => `${entry.method} ${entry.url} (${entry.bodyBytes} bytes)`),
  ).toEqual([])

  // 5. Nothing is sent to a third party. On the dev server the allowlist is the whole list: the
  //    app bundles no analytics script and no webfont, so any cross-origin request at all is a
  //    regression.
  function foreignOrigins(entries: Recorded[]): string[] {
    const origins = entries
      .map((entry) => new URL(entry.url).origin)
      .filter((origin) => !ALLOWED_ORIGINS.includes(origin))
    return [...new Set(origins)]
  }

  expect(foreignOrigins(network)).toEqual([])

  // Delivery, as a final step whose own failure must not mask any of the above. Where the engine
  // keeps the page alive through the download, the log is checked once more so delivery itself
  // is covered rather than assumed.
  const before = recorded.length
  try {
    await download.click()
    await page.waitForTimeout(2_000)
    const afterDelivery = networkRequests()
    expect(foreignOrigins(afterDelivery)).toEqual([])
    for (const entry of afterDelivery.slice(before)) {
      expect(entry.url).not.toContain('privacy-sentinel')
      expect(entry.bodyBytes, `${entry.method} ${entry.url} carries a body`).toBe(0)
    }
  } catch (error) {
    // Firefox navigates away on download and closes the context; nothing above depends on it.
    if (!/closed/i.test(String(error))) throw error
  }
})
