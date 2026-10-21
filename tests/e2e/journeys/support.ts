// Shared helpers for the end-to-end journeys in this directory (T51). Not a spec: the name has no
// `.spec` suffix, so Playwright does not collect it.
//
// Everything here drives the application the way a person does — a file chooser, buttons,
// the browser's own back button — and reads results the way a person receives them: as a download.
// None of it reaches into stores or modules, which is what separates these journeys from the
// module-level specs next to them.

import { deflateSync, inflateRawSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, type Download, type Page } from '@playwright/test'

// The first run in a fresh page fetches and compiles the ImageMagick WASM build, and a cold CI
// machine is slow at it; every wait on a *finished run* uses this rather than the 5 s default.
export const RUN_TIMEOUT = 120_000

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * A real RGB PNG. `seed` shifts the pixel pattern so two files are not byte-identical, which would
 * hide a mix-up between them.
 */
export function buildPng(width: number, height: number, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3
      raw[pixel] = (x * 7 + y * 3 + seed) % 256
      raw[pixel + 1] = (x * 3 + y * 11 + seed * 5) % 256
      raw[pixel + 2] = (x + y + seed * 13) % 256
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A PNG whose header is perfectly valid and whose pixel data is cut off. It gets through selection
 * (the header reader sizes it from IHDR alone) and fails in the worker as "could not be read" —
 * the one reliable way to make a run contain a genuine per-image failure.
 */
export function buildTruncatedPng(width = 320, height = 240): Buffer {
  const whole = buildPng(width, height, 99)
  const idatStart = whole.indexOf(Buffer.from('IDAT', 'ascii')) + 4
  return whole.subarray(0, idatStart + 40)
}

/** A fresh temp directory; every journey writes its fixtures into its own. */
export function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `journey-${label}-`))
}

/** Writes `bytes` at `relativePath` under `dir` (creating folders) and returns the full path. */
export function writeAt(dir: string, relativePath: string, bytes: Buffer | string): string {
  const full = join(dir, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, bytes)
  return full
}

/** Selects files through the real "Select images" button, as a person would. */
export async function selectFiles(page: Page, paths: string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select images' }).click()
  await (await chooser).setFiles(paths)
}

/** Selects a folder through the real "Select folder" button. */
export async function selectFolder(page: Page, directory: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select folder' }).click()
  await (await chooser).setFiles(directory)
}

/** Presses the primary Compress action. */
export async function pressCompress(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Compress/ }).click()
}

/**
 * Waits for a run to finish: the Cancel button gives way to "Back to images".
 *
 * A run that halts (out of memory, storage failure) also ends up here, with whatever it had
 * finished so far on screen. None of these journeys expects that, and left unchecked it surfaces
 * as a confusing count mismatch several assertions later — so it is named here instead.
 */
export async function waitForRunFinished(page: Page): Promise<void> {
  await expect(page.getByTestId('processing-back')).toBeVisible({ timeout: RUN_TIMEOUT })
  const halted = page.getByTestId('processing-halted')
  if ((await halted.count()) > 0) {
    throw new Error(`the run halted instead of finishing: ${await halted.innerText()}`)
  }
}

/** Reads a download's bytes into memory. */
export async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  const parts: Buffer[] = []
  for await (const part of stream) {
    parts.push(part as Buffer)
  }
  return Buffer.concat(parts)
}

/** Presses Download and returns what the browser was handed. */
export async function downloadResult(page: Page, buttonTestId = 'processing-download') {
  const event = page.waitForEvent('download')
  await page.getByTestId(buttonTestId).click()
  const download = await event
  return { name: download.suggestedFilename(), bytes: await readDownload(download) }
}

export interface ZipEntry {
  name: string
  bytes: Buffer
}

/**
 * Reads a ZIP file's entries by its central directory. Only what the app's own archive writer
 * (client-zip) produces needs to work: stored and deflated entries, sizes held in the central
 * directory because the local headers use data descriptors.
 */
export function readZip(zip: Buffer): ZipEntry[] {
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50
  let end = -1
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at
      break
    }
  }
  if (end < 0) {
    throw new Error('not a ZIP file: no end-of-central-directory record')
  }

  const entryCount = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('corrupt ZIP: bad central-directory entry')
    }
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = zip.subarray(dataStart, dataStart + compressedSize)

    if (method !== 0 && method !== 8) {
      throw new Error(`unsupported ZIP compression method ${method} for ${name}`)
    }
    entries.push({ name, bytes: method === 0 ? Buffer.from(data) : inflateRawSync(data) })

    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

export function readFixture(...segments: string[]): Buffer {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', ...segments))
}

export type ShareMode = 'resolve' | 'abort' | 'reject' | 'unsupported'

interface ShareCall {
  keys: string[]
  names: string[]
}

/**
 * Replaces `navigator.canShare`/`navigator.share` before any page script runs, so the app's own
 * capability detection sees them. Chromium and Firefox have no file sharing at all and WebKit on
 * Linux answers "no", so a stub is the only way every engine reaches the same branches.
 *
 * `unsupported` is the platform that says no to the exact payload; the other three are the three
 * ways a real `share()` call ends (R-X50).
 */
export async function stubShare(page: Page, mode: ShareMode): Promise<void> {
  await page.addInitScript((shareMode) => {
    // tests/e2e has no DOM lib (tsconfig.node.json), so the page globals are typed by hand.
    const page = globalThis as unknown as {
      navigator: object
      DOMException: new (message: string, name: string) => Error
      __shareCalls: ShareCall[]
    }
    const calls: ShareCall[] = []
    page.__shareCalls = calls

    Object.defineProperty(page.navigator, 'canShare', {
      configurable: true,
      value: (data?: { files?: unknown[] }) =>
        shareMode !== 'unsupported' && Array.isArray(data?.files) && data.files.length > 0,
    })
    Object.defineProperty(page.navigator, 'share', {
      configurable: true,
      value: async (data: { files?: { name: string }[] }) => {
        calls.push({ keys: Object.keys(data), names: (data.files ?? []).map((file) => file.name) })
        if (shareMode === 'abort') {
          throw new page.DOMException('Share cancelled', 'AbortError')
        }
        if (shareMode === 'reject') {
          throw new page.DOMException('Share failed', 'NotAllowedError')
        }
      },
    })
  }, mode)
}

export async function readShareCalls(page: Page): Promise<ShareCall[]> {
  return page.evaluate(
    () => (globalThis as unknown as { __shareCalls?: ShareCall[] }).__shareCalls ?? [],
  )
}
