// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { deriveCodecLimits } from '@/config/limits'
import { findCapBreach, readImageHeader } from './image-header'
import type { Format } from './types'

function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../tests/fixtures/${path}`, import.meta.url)))
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)))
}

const u16 = (value: number): number[] => [value >> 8, value & 0xff]
const u32 = (value: number): number[] => [(value >>> 24) & 0xff, ...u24(value)]
const u24 = (value: number): number[] => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
const u32le = (value: number): number[] => [...u32(value)].reverse()
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))

function box(type: string, ...body: (Uint8Array | number[])[]): Uint8Array {
  const payload = concat(...body)
  return concat(u32(8 + payload.length), ascii(type), payload)
}

function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  const app = concat([0xff, 0xe1], u16(2 + 600), new Array<number>(600).fill(7))
  const frame = concat([0xff, marker], u16(17), [8], u16(height), u16(width), new Array(10).fill(0))
  return concat([0xff, 0xd8], app, [0xff, 0xff], frame, [0xff, 0xda])
}

function isobmff(...ispeSizes: [number, number][]): Uint8Array {
  const ispe = ispeSizes.map(([w, h]) => box('ispe', [0, 0, 0, 0], u32(w), u32(h)))
  return concat(
    box('ftyp', ascii('heic'), u32(0), ascii('heic')),
    box('meta', [0, 0, 0, 0], box('iprp', box('ipco', ...ispe))),
  )
}

describe('readImageHeader on real files', () => {
  const cases: [string, Format, number, number, number][] = [
    ['decode/orientation-1.jpg', 'jpeg', 60, 40, 1],
    ['decode/icc-p3.jpg', 'jpeg', 60, 40, 1],
    ['decode/cicp-p3.avif', 'avif', 60, 40, 1],
    ['decode/untagged.avif', 'avif', 60, 40, 1],
    ['animated/anim-6f.gif', 'gif', 64, 64, 6],
    ['animated/anim-6f.webp', 'webp', 64, 64, 6],
    ['animated/anim-6f.png', 'png', 64, 64, 6],
    ['animated/anim-1f.gif', 'gif', 64, 64, 1],
    ['limits/gray-6mp.png', 'png', 3000, 2000, 1],
  ]

  it.each(cases)('%s', (path, format, width, height, frames) => {
    expect(readImageHeader(fixture(path), format)).toEqual({ width, height, frames })
  })

  it('reads the declared size of each decompression bomb without decoding it', () => {
    expect(readImageHeader(fixture('limits/bomb-18k-area.png'), 'png')).toEqual({
      width: 18000,
      height: 18000,
      frames: 1,
    })
    expect(readImageHeader(fixture('limits/bomb-frames.gif'), 'gif')).toEqual({
      width: 3000,
      height: 3000,
      frames: 3000,
    })
    expect(readImageHeader(fixture('limits/bomb-webp-16k.webp'), 'webp')).toEqual({
      width: 16383,
      height: 16383,
      frames: 1,
    })
  })
})

describe('readImageHeader on built headers', () => {
  it('finds a JPEG frame header past a large segment and fill bytes, baseline or progressive', () => {
    expect(readImageHeader(jpeg(65535, 65535), 'jpeg')).toEqual({
      width: 65535,
      height: 65535,
      frames: 1,
    })
    expect(readImageHeader(jpeg(4000, 3000, 0xc2), 'jpeg')).toEqual({
      width: 4000,
      height: 3000,
      frames: 1,
    })
  })

  it('does not mistake a Huffman-table or arithmetic-conditioning marker for a frame header', () => {
    expect(readImageHeader(jpeg(10, 10, 0xc4), 'jpeg')).toBeUndefined()
    expect(readImageHeader(jpeg(10, 10, 0xcc), 'jpeg')).toBeUndefined()
  })

  it('reads a lossy WebP and a lossless one by their own layouts', () => {
    const lossy = concat(
      ascii('RIFF'),
      u32le(30),
      ascii('WEBP'),
      ascii('VP8 '),
      u32le(10),
      [0, 0, 0, 0x9d, 0x01, 0x2a],
      [0x10, 0x0e, 0x00, 0x0b],
    )
    expect(readImageHeader(lossy, 'webp')).toEqual({ width: 3600, height: 2816, frames: 1 })
  })

  it('takes the largest picture in an AVIF or HEIC, not its thumbnail or a tile', () => {
    expect(readImageHeader(isobmff([160, 120], [8000, 6000], [512, 512]), 'heic')).toEqual({
      width: 8000,
      height: 6000,
      frames: 1,
    })
  })

  it('has no reader for BMP, TIFF, JXL or JPEG 2000, which are left to the decoder', () => {
    for (const format of ['bmp', 'tiff', 'jxl', 'jp2'] as const) {
      expect(readImageHeader(fixture('decode/orientation-1.jpg'), format)).toBeUndefined()
    }
    expect(readImageHeader(fixture('decode/plain.tif'), 'tiff')).toBeUndefined()
  })

  it('refuses a zero dimension rather than reporting an empty image', () => {
    expect(readImageHeader(jpeg(0, 100), 'jpeg')).toBeUndefined()
    expect(readImageHeader(isobmff([100, 0]), 'heic')).toBeUndefined()
  })
})

// The reader runs on whatever a user selects, so "never throws, always finishes" is the property
// that matters most; these are its guards.
describe('readImageHeader on damaged input', () => {
  const real: [string, Format][] = [
    ['decode/orientation-1.jpg', 'jpeg'],
    ['decode/cicp-p3.avif', 'avif'],
    ['animated/anim-6f.gif', 'gif'],
    ['animated/anim-6f.webp', 'webp'],
    ['animated/anim-6f.png', 'png'],
    ['limits/bomb-webp-16k.webp', 'webp'],
  ]

  function isValid(result: ReturnType<typeof readImageHeader>): boolean {
    return (
      result === undefined ||
      (Number.isInteger(result.width) &&
        Number.isInteger(result.height) &&
        Number.isInteger(result.frames) &&
        result.width > 0 &&
        result.height > 0 &&
        result.frames >= 1)
    )
  }

  it.each(real)('returns a valid header or nothing for every truncation of %s', (path, format) => {
    const bytes = fixture(path)
    for (let length = 0; length <= bytes.length; length += 1) {
      expect(isValid(readImageHeader(bytes.subarray(0, length), format))).toBe(true)
    }
  })

  it.each(real)('survives seeded byte corruption of %s', (path, format) => {
    const original = fixture(path)
    let seed = 0x9e3779b9
    const next = (): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0
      return (seed >>> 0) / 0x100000000
    }

    for (let round = 0; round < 1500; round += 1) {
      const bytes = original.slice()
      for (let flips = 1 + Math.floor(next() * 4); flips > 0; flips -= 1) {
        bytes[Math.floor(next() * Math.min(bytes.length, 128))] = Math.floor(next() * 256)
      }
      expect(isValid(readImageHeader(bytes, format))).toBe(true)
    }
  })

  it('is not fooled by a format hint that does not match the bytes', () => {
    const jpegBytes = fixture('decode/orientation-1.jpg')
    for (const format of ['png', 'gif', 'webp', 'avif', 'heic', 'heif'] as const) {
      expect(isValid(readImageHeader(jpegBytes, format))).toBe(true)
    }
  })

  it('finishes on length fields that point far past the data or at themselves', () => {
    const png = concat(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      u32(13),
      ascii('IHDR'),
      u32(8),
      u32(8),
      [8, 0, 0, 0, 0],
      u32(0),
      u32(0xffffffff),
      ascii('tEXt'),
      new Array(64).fill(0),
    )
    const webp = concat(
      ascii('RIFF'),
      u32le(100),
      ascii('WEBP'),
      ascii('VP8X'),
      u32le(10),
      [0x02, 0, 0, 0],
      u24(0).reverse(),
      u24(0).reverse(),
      ascii('ANMF'),
      u32le(0xffffffff),
      new Array(32).fill(0),
    )
    const zeroSizedBoxes = concat(
      box('ftyp', ascii('heic'), u32(0), ascii('heic')),
      [0, 0, 0, 0],
      ascii('meta'),
      new Array(40).fill(0),
    )
    const jpegZeroLength = concat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xe0, 0x00, 0x01])

    expect(readImageHeader(png, 'png')).toEqual({ width: 8, height: 8, frames: 1 })
    expect(isValid(readImageHeader(webp, 'webp'))).toBe(true)
    expect(isValid(readImageHeader(zeroSizedBoxes, 'heic'))).toBe(true)
    expect(readImageHeader(jpegZeroLength, 'jpeg')).toBeUndefined()
  })

  it('reads nothing from an empty or one-byte input', () => {
    for (const format of ['jpeg', 'png', 'gif', 'webp', 'avif', 'heic'] as const) {
      expect(readImageHeader(new Uint8Array(0), format)).toBeUndefined()
      expect(readImageHeader(new Uint8Array(1), format)).toBeUndefined()
    }
  })
})

describe('findCapBreach', () => {
  const MiB = 1024 * 1024
  const limits = deriveCodecLimits(800 * MiB, 500)

  it('admits a still exactly at the pixel cap and refuses one pixel over', () => {
    const cap = limits.maximumImagePixels
    expect(findCapBreach({ width: cap, height: 1, frames: 1 }, limits)).toBeUndefined()
    expect(findCapBreach({ width: cap + 1, height: 1, frames: 1 }, limits)).toEqual({
      kind: 'image-too-large',
      width: cap + 1,
      height: 1,
      capPixels: cap,
    })
  })

  it('admits a 50 megapixel phone photo under the shipped mobile budget', () => {
    expect(findCapBreach({ width: 8160, height: 6120, frames: 1 }, limits)).toBeUndefined()
  })

  it('judges an animation by frames and by total frame-pixels, each with its own cap', () => {
    expect(findCapBreach({ width: 100, height: 100, frames: 500 }, limits)).toBeUndefined()
    expect(findCapBreach({ width: 100, height: 100, frames: 501 }, limits)).toMatchObject({
      kind: 'animation-too-large',
      frames: 501,
      capFrames: 500,
    })
    expect(findCapBreach({ width: 3000, height: 3000, frames: 5 }, limits)).toMatchObject({
      kind: 'animation-too-large',
      capFramePixels: limits.maximumAnimationFramePixels,
    })
  })

  it('treats a one-frame file as a still, whatever its container', () => {
    expect(findCapBreach({ width: 8000, height: 6000, frames: 1 }, limits)).toBeUndefined()
  })
})
