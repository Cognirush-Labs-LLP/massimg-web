import { countGifFrames } from './gif-frames'
import type { Format } from './types'

export type UnhandledReason = 'psd' | 'ico' | 'svg' | 'camera-raw' | 'animated-avif'

export type Classification =
  | { class: 'supported'; format: Format; isAnimated: boolean }
  | { class: 'unhandled'; reason: UnhandledReason }
  | { class: 'not-image' }

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function matchesBytes(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (offset < 0 || offset + signature.length > bytes.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function readAscii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  )
}

function classifyJpeg(bytes: Uint8Array): Classification | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { class: 'supported', format: 'jpeg', isAnimated: false }
  }
  return undefined
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function classifyPng(bytes: Uint8Array): Classification | undefined {
  if (!matchesBytes(bytes, 0, PNG_SIGNATURE)) return undefined

  let offset = 8
  while (offset + 8 <= bytes.length) {
    const chunkLength = readU32BE(bytes, offset)
    const chunkType = readAscii4(bytes, offset + 4)
    // acTL must appear before the first IDAT (APNG spec) — this is the only
    // cheap way to tell an APNG from a single-frame PNG without decoding
    // (R-I4). ImageMagick's PNG reader silently returns one frame otherwise
    // (D6), which is why this distinction is load-bearing.
    if (chunkType === 'acTL') return { class: 'supported', format: 'png', isAnimated: true }
    if (chunkType === 'IDAT') return { class: 'supported', format: 'png', isAnimated: false }
    offset += 8 + chunkLength + 4
  }
  return { class: 'supported', format: 'png', isAnimated: false }
}

function classifyGif(bytes: Uint8Array): Classification | undefined {
  const frameCount = countGifFrames(bytes)
  if (frameCount === undefined) return undefined
  return { class: 'supported', format: 'gif', isAnimated: frameCount > 1 }
}

function classifyWebp(bytes: Uint8Array): Classification | undefined {
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return undefined
  if (bytes.length < 16) return { class: 'supported', format: 'webp', isAnimated: false }

  const fourcc = readAscii4(bytes, 12)
  if (fourcc === 'VP8X') {
    if (bytes.length < 21) return { class: 'supported', format: 'webp', isAnimated: false }
    const flags = bytes[20]!
    return { class: 'supported', format: 'webp', isAnimated: (flags & 0x02) !== 0 }
  }
  return { class: 'supported', format: 'webp', isAnimated: false }
}

function classifyBmp(bytes: Uint8Array): Classification | undefined {
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { class: 'supported', format: 'bmp', isAnimated: false }
  }
  return undefined
}

function isStandardTiffMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  return (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  )
}

function classifyTiffFamily(bytes: Uint8Array): Classification | undefined {
  // RW2 (Panasonic): a TIFF-like header, but with version 0x55 where TIFF has 0x2A.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x55 &&
    bytes[3] === 0x00
  ) {
    return { class: 'unhandled', reason: 'camera-raw' }
  }

  if (isStandardTiffMagic(bytes)) {
    // CR2 (Canon): standard TIFF header, with "CR\x02\x00" at byte offset 8.
    if (
      bytes.length >= 12 &&
      bytes[8] === 0x43 &&
      bytes[9] === 0x52 &&
      bytes[10] === 0x02 &&
      bytes[11] === 0x00
    ) {
      return { class: 'unhandled', reason: 'camera-raw' }
    }
    // Plain TIFF, or a raw format (NEF/ARW/DNG) with no cheap distinguishing
    // signature at this container layer. See the T16 handover note: this
    // falls through to a decode-time failure rather than an invented,
    // unreliable per-vendor heuristic.
    return { class: 'supported', format: 'tiff', isAnimated: false }
  }

  return undefined
}

const JXL_CONTAINER_SIGNATURE = [
  0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
]

function classifyJxl(bytes: Uint8Array): Classification | undefined {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) {
    return { class: 'supported', format: 'jxl', isAnimated: false }
  }
  if (matchesBytes(bytes, 0, JXL_CONTAINER_SIGNATURE)) {
    return { class: 'supported', format: 'jxl', isAnimated: false }
  }
  return undefined
}

const JP2_SIGNATURE_BOX = [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]

function classifyJp2(bytes: Uint8Array): Classification | undefined {
  if (matchesBytes(bytes, 0, JP2_SIGNATURE_BOX)) {
    return { class: 'supported', format: 'jp2', isAnimated: false }
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0x4f &&
    bytes[2] === 0xff &&
    bytes[3] === 0x51
  ) {
    return { class: 'supported', format: 'jp2', isAnimated: false }
  }
  return undefined
}

const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']
const HEIF_BRANDS = ['mif1', 'msf1']

function classifyIsoBmff(bytes: Uint8Array): Classification | undefined {
  if (bytes.length < 8 || !matchesAscii(bytes, 4, 'ftyp')) return undefined

  const boxSize = readU32BE(bytes, 0)
  let headerSize = 8
  let boxEnd: number
  if (boxSize === 1) {
    if (bytes.length < 16) return undefined
    headerSize = 16
    boxEnd = bytes.length
  } else {
    boxEnd = boxSize === 0 ? bytes.length : Math.min(bytes.length, boxSize)
  }

  if (bytes.length < headerSize + 4) return undefined
  const majorBrand = readAscii4(bytes, headerSize)
  const brands = new Set<string>([majorBrand])
  let pos = headerSize + 8
  while (pos + 4 <= boxEnd && pos + 4 <= bytes.length) {
    brands.add(readAscii4(bytes, pos))
    pos += 4
  }

  // Animated AVIF is rejected outright (R-F8), not accepted and substituted or flattened later —
  // classified as unhandled here rather than `supported`+`isAnimated`, so it never reaches the
  // batch at all.
  if (brands.has('avis')) return { class: 'unhandled', reason: 'animated-avif' }
  if (brands.has('avif')) return { class: 'supported', format: 'avif', isAnimated: false }
  // CR3 (Canon): an ISO-BMFF ftyp box with the "crx " brand.
  if (brands.has('crx ')) return { class: 'unhandled', reason: 'camera-raw' }
  // Live Photo / portrait auxiliary images (R-I34) are a decode-stage
  // concern, not this module's — HEIC/HEIF are never reported as animated.
  if (HEIC_BRANDS.some((brand) => brands.has(brand))) {
    return { class: 'supported', format: 'heic', isAnimated: false }
  }
  if (HEIF_BRANDS.some((brand) => brands.has(brand))) {
    return { class: 'supported', format: 'heif', isAnimated: false }
  }
  return undefined
}

function classifyPsd(bytes: Uint8Array): Classification | undefined {
  if (matchesAscii(bytes, 0, '8BPS')) return { class: 'unhandled', reason: 'psd' }
  return undefined
}

function classifyIco(bytes: Uint8Array): Classification | undefined {
  if (matchesBytes(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return { class: 'unhandled', reason: 'ico' }
  return undefined
}

const SVG_TAG = [0x3c, 0x73, 0x76, 0x67] // "<svg"

function classifySvg(bytes: Uint8Array): Classification | undefined {
  const windowLength = Math.min(4096, bytes.length)
  let start = 0
  if (windowLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3
  }
  for (let i = start; i + SVG_TAG.length <= windowLength; i += 1) {
    if (matchesBytes(bytes, i, SVG_TAG)) return { class: 'unhandled', reason: 'svg' }
  }
  return undefined
}

/**
 * Classifies a file's raw bytes into one of three buckets: a supported
 * image, an image this build cannot handle, or not an image at all
 * (R-I2, R-I23). Reads magic bytes only, never the file name or extension.
 *
 * Every check either fully confirms its signature from bytes actually
 * present, or declines and falls through to the next check — this function
 * never throws, and a signature that matches but runs out of data before an
 * animation marker (a truncated PNG before IDAT/acTL, a cut-off GIF, a short
 * WebP) still returns the confirmed format with `isAnimated: false`, never a
 * guess toward "animated".
 *
 * `bytes` must be the complete file, not a truncated prefix: a GIF's second
 * frame marker can appear arbitrarily far into the file, after the first
 * frame's pixel data, unlike PNG/WebP/AVIF's animation markers, which are
 * all near the start.
 */
export function classify(bytes: Uint8Array): Classification {
  return (
    classifyJpeg(bytes) ??
    classifyPng(bytes) ??
    classifyGif(bytes) ??
    classifyWebp(bytes) ??
    classifyBmp(bytes) ??
    classifyTiffFamily(bytes) ??
    classifyJxl(bytes) ??
    classifyJp2(bytes) ??
    classifyIsoBmff(bytes) ??
    classifyPsd(bytes) ??
    classifyIco(bytes) ??
    classifySvg(bytes) ?? { class: 'not-image' }
  )
}
