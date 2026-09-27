import { describe, expect, it } from 'vitest'
import { resolveSettings } from '@/domain/job'
import type { BatchSettings, SettingsImage } from '@/domain/job'
import type { ResolvedQuality } from '@/domain/types'
import { pickSmaller } from './encode-plan'
import type { QualitySettings } from './encode-plan'
import {
  OXIPNG_LEVEL,
  PNG_SIGNATURE,
  PngFormatError,
  QUANTIZER_ABORT_MESSAGE,
  QUANTIZER_SPEED,
  QUANTIZER_TARGET_QUALITY,
  findIccpChunk,
  hasAlphaChannel,
  isQuantizerAbort,
  oxipngOptions,
  pngBranches,
  pngCaveats,
  quantizerSettings,
  readPaletteSize,
  readPngChunks,
  readPngHeader,
  rewritePngChunks,
} from './png-plan'

// The PNG slider mapping is `domain/job.ts`'s, and R-Q11's floor is its arithmetic, not this
// module's. These tests drive the real `resolveSettings` rather than restating `70 + (q - 10) * 30 /
// 90`, so that a change to the mapping is caught here instead of being mirrored into agreement.
const IMAGE: SettingsImage = { sourceFormat: 'png', isAnimated: false, edit: null }
const BATCH: BatchSettings = {
  quality: { kind: 'quality', value: 80 },
  dimension: { kind: 'original' },
  format: 'png',
}

function pngQuality(slider: number): QualitySettings {
  const resolution = resolveSettings(IMAGE, {
    ...BATCH,
    quality: { kind: 'quality', value: slider },
  })

  if (resolution.kind !== 'resolved') {
    throw new Error(`slider ${slider} did not resolve`)
  }

  const quality: ResolvedQuality = resolution.settings.quality

  if (quality.kind !== 'quality') {
    throw new Error(`slider ${slider} resolved to a size target`)
  }

  return quality
}

const SLIDER_RANGE = Array.from({ length: 91 }, (_, index) => index + 10)

// ---------------------------------------------------------------------------------------------
// Chunk surgery. The fixtures are hand-built so that a chunk's bytes are known exactly; nothing
// here needs a real encoder, and nothing here recomputes a CRC, because chunks are only ever moved
// whole.
// ---------------------------------------------------------------------------------------------

function chunk(type: string, data: number[], crc = [0xde, 0xad, 0xbe, 0xef]): number[] {
  const length = data.length

  return [
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    ...Array.from(type, (character) => character.charCodeAt(0)),
    ...data,
    ...crc,
  ]
}

const IHDR_DATA = [
  0,
  0,
  0,
  4, // width 4
  0,
  0,
  0,
  3, // height 3
  8, // bit depth
  6, // colour type: RGBA
  0,
  0,
  0, // interlace
]

function png(...chunks: number[][]): Uint8Array {
  return new Uint8Array([...PNG_SIGNATURE, ...chunks.flat()])
}

const IHDR = chunk('IHDR', IHDR_DATA)
const IEND = chunk('IEND', [])

describe('readPngChunks', () => {
  it('walks a PNG and reports each chunk with its offset and data length', () => {
    const file = png(IHDR, chunk('PLTE', [1, 2, 3]), chunk('IDAT', [9, 9]), IEND)

    expect(readPngChunks(file)).toEqual([
      { type: 'IHDR', at: 8, length: 13 },
      { type: 'PLTE', at: 33, length: 3 },
      { type: 'IDAT', at: 48, length: 2 },
      { type: 'IEND', at: 62, length: 0 },
    ])
  })

  it('stops at IEND and ignores anything appended after it', () => {
    const file = new Uint8Array([...png(IHDR, IEND), 1, 2, 3, 4, 5, 6, 7, 8, 9])

    expect(readPngChunks(file).map((entry) => entry.type)).toEqual(['IHDR', 'IEND'])
  })

  it.each([
    ['empty input', new Uint8Array()],
    ['a JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0])],
    ['a signature one byte wrong', new Uint8Array([...PNG_SIGNATURE.slice(0, 7), 0x00])],
  ])('refuses %s', (_label, bytes) => {
    expect(() => readPngChunks(bytes)).toThrow(PngFormatError)
  })

  it('refuses a chunk whose length runs past the end of the file', () => {
    // A `DataView` read past the end would raise `RangeError`, which `pipeline/worker.ts` reports as
    // the machine running out of memory — the exact mis-report T23 found in `colour.ts`.
    const file = png([0, 0, 0xff, 0xff, ...Array.from('IDAT', (c) => c.charCodeAt(0)), 1, 2, 3, 4])

    expect(() => readPngChunks(file)).toThrow(PngFormatError)
    expect(() => readPngChunks(file)).not.toThrow(RangeError)
  })

  it('refuses a file that ends without IEND', () => {
    expect(() => readPngChunks(png(IHDR, chunk('IDAT', [1])))).toThrow(PngFormatError)
  })
})

describe('readPngHeader', () => {
  it('reads the IHDR fields', () => {
    expect(readPngHeader(png(IHDR, IEND))).toEqual({
      width: 4,
      height: 3,
      bitDepth: 8,
      colorType: 6,
      interlace: 0,
    })
  })

  it('refuses a file whose first chunk is not a 13-byte IHDR', () => {
    expect(() => readPngHeader(png(chunk('IHDR', [1, 2, 3]), IEND))).toThrow(PngFormatError)
    expect(() => readPngHeader(png(chunk('PLTE', IHDR_DATA), IEND))).toThrow(PngFormatError)
  })
})

describe('readPaletteSize and hasAlphaChannel', () => {
  const palette = (colorType: number, chunks: number[][] = []) =>
    png(chunk('IHDR', [...IHDR_DATA.slice(0, 9), colorType, 0, 0, 0]), ...chunks, IEND)

  it('counts palette entries, three bytes each', () => {
    expect(
      readPaletteSize(
        palette(3, [
          chunk(
            'PLTE',
            Array.from({ length: 27 }, () => 0),
          ),
        ]),
      ),
    ).toBe(9)
  })

  it('reports no palette for a truecolour PNG', () => {
    expect(readPaletteSize(palette(2))).toBeNull()
  })

  it.each([
    ['greyscale', 0, false],
    ['truecolour', 2, false],
    ['palette', 3, false],
    ['greyscale with alpha', 4, true],
    ['truecolour with alpha', 6, true],
  ])('reads an alpha channel from colour type %s', (_label, colorType, expected) => {
    expect(hasAlphaChannel(palette(colorType))).toBe(expected)
  })

  it('treats a tRNS chunk as an alpha channel, whatever the colour type', () => {
    expect(hasAlphaChannel(palette(3, [chunk('tRNS', [0, 128, 255])]))).toBe(true)
    expect(hasAlphaChannel(palette(2, [chunk('tRNS', [0, 0, 0, 0, 0, 0])]))).toBe(true)
  })
})

describe('findIccpChunk', () => {
  const iccp = chunk('iCCP', [0x69, 0x63, 0x63, 0, 0, 0x78, 0x9c, 1, 2, 3])

  it('returns the whole chunk, header and CRC included', () => {
    const file = png(IHDR, iccp, chunk('IDAT', [7]), IEND)
    const found = findIccpChunk(file)

    expect(found).not.toBeNull()
    expect(Array.from(found as Uint8Array)).toEqual(iccp)
  })

  it('returns a copy that owns its buffer, not a window onto the source', () => {
    const found = findIccpChunk(png(IHDR, iccp, IEND)) as Uint8Array

    expect(found.byteOffset).toBe(0)
    expect(found.byteLength).toBe(found.buffer.byteLength)
  })

  it('returns null when the file carries no profile', () => {
    expect(findIccpChunk(png(IHDR, chunk('IDAT', [7]), IEND))).toBeNull()
  })
})

describe('rewritePngChunks', () => {
  const iccp = chunk('iCCP', [0x69, 0x63, 0x63, 0, 0, 1, 2, 3])
  const donor = new Uint8Array(chunk('iCCP', [0x64, 0x6f, 0x6e, 0, 0, 9, 9, 9, 9]))
  const noisy = png(
    IHDR,
    iccp,
    chunk(
      'cHRM',
      Array.from({ length: 32 }, () => 1),
    ),
    chunk('PLTE', [1, 2, 3]),
    chunk('tRNS', [200]),
    chunk('tIME', [7, 0xe9, 9, 16, 12, 0, 0]),
    chunk(
      'zTXt',
      Array.from({ length: 40 }, () => 2),
    ),
    chunk(
      'tEXt',
      Array.from({ length: 37 }, () => 3),
    ),
    chunk('sRGB', [0]),
    chunk('gAMA', [0, 1, 0x86, 0xa0]),
    chunk('IDAT', [4, 5, 6]),
    IEND,
  )

  const typesOf = (file: Uint8Array) => readPngChunks(file).map((entry) => entry.type)

  it('keeps only the critical chunks and tRNS, dropping every metadata chunk (R-I17)', () => {
    // ImageMagick writes all of cHRM, tIME, tEXt and a duplicate zTXt copy of the profile on every
    // PNG; none of them is asked for, and the dates are a timestamp the user did not publish.
    expect(typesOf(rewritePngChunks(noisy, { kind: 'drop' }))).toEqual([
      'IHDR',
      'PLTE',
      'tRNS',
      'IDAT',
      'IEND',
    ])
  })

  it('keeps the encoder’s own iCCP when told to', () => {
    expect(typesOf(rewritePngChunks(noisy, { kind: 'keep' }))).toEqual([
      'IHDR',
      'iCCP',
      'PLTE',
      'tRNS',
      'IDAT',
      'IEND',
    ])
  })

  it('moves the kept iCCP byte for byte, CRC included', () => {
    const rewritten = rewritePngChunks(noisy, { kind: 'keep' })
    const found = findIccpChunk(rewritten) as Uint8Array

    expect(Array.from(found)).toEqual(iccp)
  })

  it('replaces an existing iCCP with the attached one and puts it straight after IHDR', () => {
    const rewritten = rewritePngChunks(noisy, { kind: 'attach', chunk: donor })

    expect(typesOf(rewritten)).toEqual(['IHDR', 'iCCP', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
    expect(Array.from(findIccpChunk(rewritten) as Uint8Array)).toEqual(Array.from(donor))
  })

  it('inserts an attached iCCP into a file that had none, before PLTE and IDAT', () => {
    const bare = png(IHDR, chunk('PLTE', [1, 2, 3]), chunk('IDAT', [4]), IEND)
    const rewritten = rewritePngChunks(bare, { kind: 'attach', chunk: donor })
    const order = typesOf(rewritten)

    expect(order).toEqual(['IHDR', 'iCCP', 'PLTE', 'IDAT', 'IEND'])
    expect(order.indexOf('iCCP')).toBeLessThan(order.indexOf('PLTE'))
    expect(order.indexOf('iCCP')).toBeLessThan(order.indexOf('IDAT'))
  })

  it('drops sRGB and gAMA alongside an attached profile, which the specification forbids pairing', () => {
    // T23: `sRGB` and `iCCP` are mutually exclusive, and a file carrying both makes libpng warn and
    // two readers disagree about the colour.
    const rewritten = rewritePngChunks(noisy, { kind: 'attach', chunk: donor })

    expect(typesOf(rewritten)).not.toContain('sRGB')
    expect(typesOf(rewritten)).not.toContain('gAMA')
    expect(typesOf(rewritten)).not.toContain('cHRM')
  })

  it('keeps the signature, the IHDR bytes and every IDAT in order', () => {
    const many = png(IHDR, chunk('IDAT', [1]), chunk('IDAT', [2]), chunk('IDAT', [3]), IEND)
    const rewritten = rewritePngChunks(many, { kind: 'drop' })

    expect(Array.from(rewritten.subarray(0, 8))).toEqual([...PNG_SIGNATURE])
    expect(readPngHeader(rewritten)).toEqual(readPngHeader(many))
    expect(typesOf(rewritten)).toEqual(['IHDR', 'IDAT', 'IDAT', 'IDAT', 'IEND'])
    // Each IDAT's single payload byte, in the order it was written: image data is one stream split
    // across chunks, so reordering or dropping one silently corrupts the image.
    expect(
      readPngChunks(rewritten)
        .filter((entry) => entry.type === 'IDAT')
        .map((entry) => rewritten[entry.at + 8]),
    ).toEqual([1, 2, 3])
  })

  it('returns a buffer the worker may transfer', () => {
    const rewritten = rewritePngChunks(noisy, { kind: 'drop' })

    expect(rewritten.byteOffset).toBe(0)
    expect(rewritten.byteLength).toBe(rewritten.buffer.byteLength)
  })

  it('refuses a PNG that does not start with IHDR', () => {
    expect(() => rewritePngChunks(png(chunk('PLTE', [1]), IEND), { kind: 'drop' })).toThrow(
      PngFormatError,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// The decisions.
// ---------------------------------------------------------------------------------------------

describe('pngBranches', () => {
  it('runs both candidates below the lossless point and only lossless at or above it (R-Q12, R-Q14)', () => {
    for (const slider of SLIDER_RANGE) {
      const quality = pngQuality(slider)

      expect(pngBranches(quality), `slider ${slider}`).toEqual(
        slider >= 85 ? ['lossless'] : ['lossless', 'quantized'],
      )
    }
  })

  it('turns lossless on at slider 85 and not at 84 (R-Q12)', () => {
    expect(pngQuality(84).lossless).toBe(false)
    expect(pngQuality(85).lossless).toBe(true)
    expect(pngQuality(85).value).toBe(95)
    expect(pngBranches(pngQuality(84))).toEqual(['lossless', 'quantized'])
    expect(pngBranches(pngQuality(85))).toEqual(['lossless'])
  })
})

describe('quantizerSettings', () => {
  it('maps the three values R-Q11 names exactly, with no rounding to move them', () => {
    expect(quantizerSettings(pngQuality(10)).minimum).toBe(70)
    expect(quantizerSettings(pngQuality(40)).minimum).toBe(80)
    expect(quantizerSettings(pngQuality(70)).minimum).toBe(90)
    expect(quantizerSettings(pngQuality(85)).minimum).toBe(95)
    expect(quantizerSettings(pngQuality(100)).minimum).toBe(100)
  })

  it('rounds a fractional mapped value to the nearest whole number', () => {
    // Slider 20 maps to 73.333…, slider 12 to 70.666…, slider 84 to 94.666…. WebAssembly would
    // truncate a fraction silently, so the rounding is explicit and it is nearest, not floor.
    expect(pngQuality(20).value).toBeCloseTo(73 + 1 / 3, 12)
    expect(quantizerSettings(pngQuality(20)).minimum).toBe(73)
    expect(pngQuality(12).value).toBeCloseTo(70 + 2 / 3, 12)
    expect(quantizerSettings(pngQuality(12)).minimum).toBe(71)
    expect(quantizerSettings(pngQuality(84)).minimum).toBe(95)
  })

  it('rounds after the lossless decision, never before it (R-Q12)', () => {
    // Slider 84 rounds to 95, the mapped value R-Q12 makes lossless. Rounding first would have made
    // slider 84 lossless as well, one step earlier than the requirement says.
    expect(quantizerSettings(pngQuality(84)).minimum).toBe(
      quantizerSettings(pngQuality(85)).minimum,
    )
    expect(pngQuality(84).lossless).toBe(false)
    expect(pngQuality(85).lossless).toBe(true)
  })

  it('never asks for less than 70 anywhere on the slider (R-Q11’s floor)', () => {
    const minimums = SLIDER_RANGE.map((slider) => quantizerSettings(pngQuality(slider)).minimum)

    expect(Math.min(...minimums)).toBe(70)
    expect(Math.max(...minimums)).toBe(100)
    // Monotonic: a higher slider never asks for a lower quantization quality.
    expect([...minimums].sort((a, b) => a - b)).toEqual(minimums)
  })

  it('asks for the measured target and speed on every value (§7.3)', () => {
    for (const slider of SLIDER_RANGE) {
      expect(quantizerSettings(pngQuality(slider))).toMatchObject({
        target: QUANTIZER_TARGET_QUALITY,
        speed: QUANTIZER_SPEED,
      })
    }
  })

  it('leaves the target at 100 and the speed off the library default', () => {
    // Measured (T27): asking for fewer colours makes libimagequant dither harder, and a gradient at
    // target 70 came out both larger and further from the source than the same image at target 100.
    expect(QUANTIZER_TARGET_QUALITY).toBe(100)
    expect(QUANTIZER_SPEED).toBeGreaterThanOrEqual(1)
    expect(QUANTIZER_SPEED).toBeLessThanOrEqual(10)
  })

  it.each([0, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a mapped quality of %s',
    (value) => {
      expect(() => quantizerSettings({ kind: 'quality', value, lossless: false })).toThrow(
        PngFormatError,
      )
    },
  )
})

describe('oxipngOptions', () => {
  it('runs at level 2, not the library default and not 6 (§7.3)', () => {
    expect(OXIPNG_LEVEL).toBe(2)
    expect(oxipngOptions()).toEqual({ level: 2, interlace: false, optimiseAlpha: false })
  })

  it('leaves optimiseAlpha off, so a lossless PNG is lossless under its transparent pixels too', () => {
    expect(oxipngOptions().optimiseAlpha).toBe(false)
  })
})

describe('isQuantizerAbort', () => {
  it('recognises libimagequant refusing to meet the floor (R-Q11)', () => {
    expect(isQuantizerAbort(new Error(QUANTIZER_ABORT_MESSAGE))).toBe(true)
    expect(isQuantizerAbort(new Error(`imagequant: ${QUANTIZER_ABORT_MESSAGE} (min 95)`))).toBe(
      true,
    )
    expect(isQuantizerAbort(QUANTIZER_ABORT_MESSAGE)).toBe(true)
  })

  it.each([
    ['an out-of-memory failure', new RangeError('Out of memory')],
    ['a null pointer panic', new Error('null pointer passed to rust')],
    ['an unreadable wasm-bindgen message', new TypeError('Cannot read properties of undefined')],
    ['nothing at all', undefined],
  ])('does not mistake %s for the abort', (_label, error) => {
    expect(isQuantizerAbort(error)).toBe(false)
  })
})

describe("R-Q14's comparison is R-Q6's", () => {
  it('is decided by the same pickSmaller, tie included', () => {
    // `png.ts` calls `pickSmaller(quantized, lossless)` — the function `encode.ts` calls for WebP —
    // rather than repeating the comparison. §7.6 names the two rules together, and two copies of
    // "keep the smaller, tie goes to lossless" are two places for the tie-break to drift.
    expect(pickSmaller(100, 90)).toBe('lossless')
    expect(pickSmaller(90, 100)).toBe('lossy')
    // A tie keeps the lossless candidate: the same size, with nothing given up and no caveat to
    // explain. `png.ts` maps that answer onto its own branch names.
    expect(pickSmaller(100, 100)).toBe('lossless')
  })
})

describe('pngCaveats', () => {
  it('records png-quantized only when the quantized candidate is the one kept (R-X46)', () => {
    expect(pngCaveats('quantized')).toEqual([{ kind: 'png-quantized' }])
    // The caveat's own words are "PNG was not written losslessly". R-Q14 may keep the lossless
    // candidate below slider 85, and the quantizer may have aborted to it; in both cases the output
    // *is* lossless and the caveat would be false.
    expect(pngCaveats('lossless')).toEqual([])
  })
})
