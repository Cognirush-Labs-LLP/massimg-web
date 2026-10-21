// What a file's own header says about its size, read before anything decodes it (Functional Design
// R-I19, R-I22). The formats covered are the ones where a few hundred bytes can declare an image
// far larger than a device can hold; the rest return `undefined` and are left to ImageMagick's
// resource limits (Technical Design §8.3).
//
// Everything here runs on a file already in memory, so no read can wait on, or grow with, anything
// the file declares:
//   - every access goes through a `DataView`, which throws past the end of the data, and the one
//     `try` in `readImageHeader` turns any throw into `undefined`, so a damaged file is "unknown"
//     and never an error;
//   - every loop advances by at least one box, chunk, segment or block per iteration, so it is
//     bounded by the file's length, not by a length field inside it;
//   - nothing is allocated from a number found in the file.
import type { CodecLimits } from '@/config/limits'
import { countGifFrames } from './gif-frames'
import type { Format } from './types'

export interface ImageHeader {
  width: number
  height: number
  /** 1 for a still, or an animation that declares no more than one frame. */
  frames: number
}

export type CapBreach =
  | { kind: 'image-too-large'; width: number; height: number; capPixels: number }
  | {
      kind: 'animation-too-large'
      width: number
      height: number
      frames: number
      capFrames: number
      capFramePixels: number
    }

function header(width: number, height: number, frames = 1): ImageHeader | undefined {
  return width > 0 && height > 0 ? { width, height, frames: Math.max(1, frames) } : undefined
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  )
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegHeader(view: DataView): ImageHeader | undefined {
  let at = 2
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return undefined
    const marker = view.getUint8(at + 1)

    if (marker === 0xff) {
      at += 1
    } else if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
    } else if (marker === 0xd9 || marker === 0xda) {
      return undefined
    } else if (isStartOfFrame(marker)) {
      return header(view.getUint16(at + 7), view.getUint16(at + 5))
    } else {
      const length = view.getUint16(at + 2)
      if (length < 2) return undefined
      at += 2 + length
    }
  }
  return undefined
}

function pngHeader(view: DataView): ImageHeader | undefined {
  if (fourcc(view, 12) !== 'IHDR') return undefined

  let frames = 1
  for (let at = 8; at + 12 <= view.byteLength; at += 12 + view.getUint32(at)) {
    const type = fourcc(view, at + 4)
    if (type === 'acTL') {
      frames = view.getUint32(at + 8)
      break
    }
    if (type === 'IDAT') break
  }
  return header(view.getUint32(16), view.getUint32(20), frames)
}

function gifHeader(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  return header(view.getUint16(6, true), view.getUint16(8, true), countGifFrames(bytes) ?? 1)
}

function webpHeader(view: DataView): ImageHeader | undefined {
  const kind = fourcc(view, 12)

  if (kind === 'VP8X') {
    const width = 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16))
    const height = 1 + (view.getUint16(27, true) | (view.getUint8(29) << 16))
    let frames = 1
    if (view.getUint8(20) & 0x02) {
      frames = 0
      for (let at = 30; at + 8 <= view.byteLength;) {
        const size = view.getUint32(at + 4, true)
        if (fourcc(view, at) === 'ANMF') frames += 1
        at += 8 + size + (size & 1)
      }
    }
    return header(width, height, frames)
  }

  if (kind === 'VP8L' && view.getUint8(20) === 0x2f) {
    const bits = view.getUint32(21, true)
    return header((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }

  // A lossy frame: a three-byte tag, then the start code 9d 01 2a, then 14-bit width and height.
  if (
    kind === 'VP8 ' &&
    view.getUint8(23) === 0x9d &&
    view.getUint8(24) === 0x01 &&
    view.getUint8(25) === 0x2a
  ) {
    return header(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
  }

  return undefined
}

// meta (a FullBox, hence the extra four bytes) > iprp > ipco > ispe.
const ISOBMFF_PATH = ['meta', 'iprp', 'ipco'] as const

// An AVIF or HEIC may carry thumbnails and tiles beside the picture, each with its own `ispe`. The
// largest is the picture, and the largest is also the safe one to judge a cap by.
function isobmffHeader(view: DataView): ImageHeader | undefined {
  let largest: ImageHeader | undefined

  const walk = (start: number, end: number, depth: number): void => {
    for (let at = start; at + 8 <= end;) {
      let size = view.getUint32(at)
      let body = at + 8
      if (size === 1) {
        if (view.getUint32(at + 8) !== 0) return
        size = view.getUint32(at + 12)
        body = at + 16
      } else if (size === 0) {
        size = end - at
      }
      if (size < body - at) return

      const next = at + size
      const type = fourcc(view, at + 4)
      if (depth < ISOBMFF_PATH.length && type === ISOBMFF_PATH[depth]) {
        walk(body + (depth === 0 ? 4 : 0), Math.min(next, end), depth + 1)
      } else if (depth === ISOBMFF_PATH.length && type === 'ispe') {
        const found = header(view.getUint32(body + 4), view.getUint32(body + 8))
        if (found && (!largest || found.width * found.height > largest.width * largest.height)) {
          largest = found
        }
      }
      at = next
    }
  }

  walk(0, view.byteLength, 0)
  return largest
}

/**
 * Width, height and frame count from the header of a complete file, or `undefined` for a format with
 * no reader here and for anything that cannot be parsed. Never throws.
 */
export function readImageHeader(bytes: Uint8Array, format: Format): ImageHeader | undefined {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    switch (format) {
      case 'jpeg':
        return jpegHeader(view)
      case 'png':
        return pngHeader(view)
      case 'gif':
        return gifHeader(bytes, view)
      case 'webp':
        return webpHeader(view)
      case 'avif':
      case 'heic':
      case 'heif':
        return isobmffHeader(view)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** Which cap, if any, an image's header breaches. Pixel products stay far below 2^53. */
export function findCapBreach(header: ImageHeader, limits: CodecLimits): CapBreach | undefined {
  const pixels = header.width * header.height

  if (header.frames > 1) {
    if (
      header.frames > limits.maximumAnimationFrames ||
      pixels * header.frames > limits.maximumAnimationFramePixels
    ) {
      return {
        kind: 'animation-too-large',
        width: header.width,
        height: header.height,
        frames: header.frames,
        capFrames: limits.maximumAnimationFrames,
        capFramePixels: limits.maximumAnimationFramePixels,
      }
    }
    return undefined
  }

  return pixels > limits.maximumImagePixels
    ? {
        kind: 'image-too-large',
        width: header.width,
        height: header.height,
        capPixels: limits.maximumImagePixels,
      }
    : undefined
}
