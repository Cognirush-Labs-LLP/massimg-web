import { describe, expect, it } from 'vitest'
import { classify, type Classification } from './classify'
import type { Format } from './types'

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

function u16le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff)
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  return concatBytes(u32be(data.length), ascii(type), data, Uint8Array.of(0, 0, 0, 0))
}

function pngFile(...chunks: Uint8Array[]): Uint8Array {
  return concatBytes(PNG_SIGNATURE, ...chunks)
}

function ftypBox(majorBrand: string, compatibleBrands: string[]): Uint8Array {
  const body = concatBytes(
    ascii(majorBrand),
    u32be(0),
    ...compatibleBrands.map((brand) => ascii(brand)),
  )
  const size = 8 + body.length
  return concatBytes(u32be(size), ascii('ftyp'), body)
}

function gifImageDescriptor(): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x2c), // image separator
    u16le(0), // left
    u16le(0), // top
    u16le(1), // width
    u16le(1), // height
    Uint8Array.of(0x00), // packed fields: no local colour table
    Uint8Array.of(0x02), // LZW minimum code size
    Uint8Array.of(0x01, 0x00), // one sub-block of length 1, byte 0x00
    Uint8Array.of(0x00), // block terminator
  )
}

function gifFile(frameCount: number): Uint8Array {
  const header = ascii('GIF89a')
  const logicalScreenDescriptor = concatBytes(
    u16le(1), // width
    u16le(1), // height
    Uint8Array.of(0x00), // packed fields: no global colour table
    Uint8Array.of(0x00), // background colour index
    Uint8Array.of(0x00), // pixel aspect ratio
  )
  const frames = Array.from({ length: frameCount }, () => gifImageDescriptor())
  return concatBytes(header, logicalScreenDescriptor, ...frames, Uint8Array.of(0x3b))
}

function webpFile(fourcc: 'VP8 ' | 'VP8L', payload: Uint8Array = new Uint8Array(4)): Uint8Array {
  const chunk = concatBytes(ascii(fourcc), u32be(payload.length), payload)
  return concatBytes(ascii('RIFF'), u32be(4 + chunk.length), ascii('WEBP'), chunk)
}

function webpVp8xFile(animated: boolean): Uint8Array {
  const flags = animated ? 0x02 : 0x00
  const vp8x = concatBytes(
    Uint8Array.of(flags, 0x00, 0x00),
    Uint8Array.of(0x00, 0x00, 0x00), // width - 1
    Uint8Array.of(0x00, 0x00, 0x00), // height - 1
  )
  const chunk = concatBytes(ascii('VP8X'), u32be(vp8x.length), vp8x)
  return concatBytes(ascii('RIFF'), u32be(4 + chunk.length), ascii('WEBP'), chunk)
}

const SUPPORTED = (format: Format, isAnimated = false): Classification => ({
  class: 'supported',
  format,
  isAnimated,
})

describe('classify', () => {
  it('classifies a JPEG by magic bytes even when the name suggests PNG', () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46)
    expect(classify(bytes)).toEqual(SUPPORTED('jpeg'))
  })

  it('classifies a single-frame PNG as not animated', () => {
    const bytes = pngFile(
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('IDAT', new Uint8Array(4)),
      pngChunk('IEND'),
    )
    expect(classify(bytes)).toEqual(SUPPORTED('png'))
  })

  it('classifies a PNG truncated before IDAT or acTL as not animated', () => {
    const bytes = pngFile(pngChunk('IHDR', new Uint8Array(13)))
    expect(classify(bytes)).toEqual(SUPPORTED('png'))
  })

  it('classifies an APNG (acTL before IDAT) as animated', () => {
    const bytes = pngFile(
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('acTL', new Uint8Array(8)),
      pngChunk('IDAT', new Uint8Array(4)),
      pngChunk('IEND'),
    )
    expect(classify(bytes)).toEqual(SUPPORTED('png', true))
  })

  it('does not honour an acTL chunk that appears after the first IDAT', () => {
    const bytes = pngFile(
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('IDAT', new Uint8Array(4)),
      pngChunk('acTL', new Uint8Array(8)),
      pngChunk('IEND'),
    )
    expect(classify(bytes)).toEqual(SUPPORTED('png'))
  })

  it('rejects an animated AVIF from the ftyp avis brand as unhandled (R-F8)', () => {
    const bytes = ftypBox('avif', ['avif', 'avis', 'mif1', 'miaf'])
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'animated-avif' })
  })

  it('classifies a still AVIF from the ftyp avif brand alone', () => {
    const bytes = ftypBox('avif', ['mif1'])
    expect(classify(bytes)).toEqual(SUPPORTED('avif'))
  })

  it('classifies a PSD as an image we cannot handle', () => {
    const bytes = concatBytes(ascii('8BPS'), new Uint8Array(20))
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'psd' })
  })

  it('classifies a docx (a zip) as not an image', () => {
    const bytes = concatBytes(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), new Uint8Array(20))
    expect(classify(bytes)).toEqual({ class: 'not-image' })
  })

  describe('every Format member has a real magic-byte fixture', () => {
    const FIXTURES = {
      jpeg: () => Uint8Array.of(0xff, 0xd8, 0xff, 0xe1),
      png: () => pngFile(pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT')),
      webp: () => webpFile('VP8 '),
      avif: () => ftypBox('avif', ['mif1']),
      gif: () => gifFile(1),
      bmp: () => Uint8Array.of(0x42, 0x4d, 0x00, 0x00),
      tiff: () => Uint8Array.of(0x49, 0x49, 0x2a, 0x00),
      jxl: () => Uint8Array.of(0xff, 0x0a),
      jp2: () => Uint8Array.of(0xff, 0x4f, 0xff, 0x51),
      heic: () => ftypBox('heic', ['mif1', 'heic']),
      heif: () => ftypBox('mif1', ['msf1']),
    } as const satisfies Record<Format, () => Uint8Array>

    it.each(Object.entries(FIXTURES))('%s', (format, build) => {
      const result = classify(build())
      expect(result.class).toBe('supported')
      expect((result as { format: Format }).format).toBe(format)
    })
  })

  it('classifies a still WebP (VP8) as not animated', () => {
    expect(classify(webpFile('VP8 '))).toEqual(SUPPORTED('webp'))
  })

  it('classifies a lossless still WebP (VP8L) as not animated', () => {
    expect(classify(webpFile('VP8L'))).toEqual(SUPPORTED('webp'))
  })

  it('classifies a VP8X WebP with the animation flag set as animated', () => {
    expect(classify(webpVp8xFile(true))).toEqual(SUPPORTED('webp', true))
  })

  it('classifies a VP8X WebP without the animation flag as not animated', () => {
    expect(classify(webpVp8xFile(false))).toEqual(SUPPORTED('webp'))
  })

  it('does not misclassify a non-WEBP RIFF file (e.g. WAVE) as an image', () => {
    const chunk = concatBytes(ascii('fmt '), u32be(4), new Uint8Array(4))
    const bytes = concatBytes(ascii('RIFF'), u32be(4 + chunk.length), ascii('WAVE'), chunk)
    expect(classify(bytes)).toEqual({ class: 'not-image' })
  })

  it('classifies a single-descriptor GIF as not animated', () => {
    expect(classify(gifFile(1))).toEqual(SUPPORTED('gif'))
  })

  it('classifies a two-descriptor GIF as animated', () => {
    expect(classify(gifFile(2))).toEqual(SUPPORTED('gif', true))
  })

  it('does not throw on a GIF truncated mid sub-block', () => {
    const full = gifFile(2)
    const truncated = full.subarray(0, full.length - 3)
    expect(() => classify(truncated)).not.toThrow()
    expect(classify(truncated).class).toBe('supported')
  })

  it('classifies the JPEG XL container signature', () => {
    const bytes = Uint8Array.of(
      0x00,
      0x00,
      0x00,
      0x0c,
      0x4a,
      0x58,
      0x4c,
      0x20,
      0x0d,
      0x0a,
      0x87,
      0x0a,
    )
    expect(classify(bytes)).toEqual(SUPPORTED('jxl'))
  })

  it('classifies the JPEG 2000 signature box', () => {
    const bytes = Uint8Array.of(
      0x00,
      0x00,
      0x00,
      0x0c,
      0x6a,
      0x50,
      0x20,
      0x20,
      0x0d,
      0x0a,
      0x87,
      0x0a,
    )
    expect(classify(bytes)).toEqual(SUPPORTED('jp2'))
  })

  it('classifies a CR2 (standard TIFF header plus the CR marker) as camera-raw', () => {
    const bytes = Uint8Array.of(0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0x43, 0x52, 0x02, 0x00)
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'camera-raw' })
  })

  it('classifies a CR3 (ftyp crx brand) as camera-raw', () => {
    const bytes = ftypBox('crx ', ['crx ', 'isom'])
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'camera-raw' })
  })

  it('classifies an RW2 (TIFF-like header with version 0x55) as camera-raw', () => {
    const bytes = Uint8Array.of(0x49, 0x49, 0x55, 0x00)
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'camera-raw' })
  })

  it('classifies a plain TIFF with no raw-vendor marker as a supported TIFF, not camera-raw', () => {
    const bytes = Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8)
    expect(classify(bytes)).toEqual(SUPPORTED('tiff'))
  })

  it('classifies an ICO as an image we cannot handle', () => {
    const bytes = Uint8Array.of(0x00, 0x00, 0x01, 0x00, 0x01, 0x00)
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'ico' })
  })

  it('classifies an SVG as an image we cannot handle', () => {
    const bytes = ascii('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'svg' })
  })

  it('classifies an SVG with a leading UTF-8 BOM', () => {
    const bytes = concatBytes(
      Uint8Array.of(0xef, 0xbb, 0xbf),
      ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    )
    expect(classify(bytes)).toEqual({ class: 'unhandled', reason: 'svg' })
  })

  it('classifies an empty buffer as not an image', () => {
    expect(classify(new Uint8Array(0))).toEqual({ class: 'not-image' })
  })

  it('classifies a few bytes of garbage as not an image', () => {
    expect(classify(Uint8Array.of(0x01, 0x02, 0x03))).toEqual({ class: 'not-image' })
  })

  it('classifies plain text as not an image', () => {
    expect(classify(ascii('just some plain text content, nothing else'))).toEqual({
      class: 'not-image',
    })
  })

  it('does not throw on a truncated ftyp box claiming a 64-bit size', () => {
    const bytes = concatBytes(u32be(1), ascii('ftyp'), ascii('avif'))
    expect(() => classify(bytes)).not.toThrow()
    expect(classify(bytes)).toEqual({ class: 'not-image' })
  })
})
