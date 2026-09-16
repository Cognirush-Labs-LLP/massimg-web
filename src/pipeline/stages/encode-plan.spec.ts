import { describe, expect, it } from 'vitest'
import {
  AVIF_MAX_QUALITY,
  AVIF_SPEED,
  LOSSLESS_GATE_MAX_COLORS,
  WEBP_METHOD,
  colourPlan,
  countUniqueColors,
  encoderAttempt,
  isOpaque,
  pickSmaller,
  plannedModes,
  shouldTryLossless,
  unsupportedColour,
  type QualitySettings,
  type StillFormat,
} from './encode-plan'
import type { FrameColour } from './frame'

// The slider maps to `lossless` in `domain/job.ts`; these are the settings it produces.
const quality = (value: number): QualitySettings => ({
  kind: 'quality',
  value,
  lossless: value > 95,
})

const PROFILE = new Uint8Array([1, 2, 3, 4])

describe('plannedModes', () => {
  it.each([
    ['jpeg', 10, ['lossy']],
    ['jpeg', 95, ['lossy']],
    // No lossless mode exists for JPEG; 96-100 is highest quality (§7.4).
    ['jpeg', 96, ['lossy']],
    ['jpeg', 100, ['lossy']],
    // R-Q6: below 96 WebP also attempts lossless, subject to the gate.
    ['webp', 10, ['lossy', 'lossless']],
    ['webp', 95, ['lossy', 'lossless']],
    // R-Q5: above 95 is lossless, and only lossless.
    ['webp', 96, ['lossless']],
    ['webp', 100, ['lossless']],
    // AVIF has no comparison rule (§7.6 names WebP and PNG only) and, in this build, no usable
    // lossless mode either (D9) — 96-100 is highest quality, as JPEG is.
    ['avif', 10, ['lossy']],
    ['avif', 95, ['lossy']],
    ['avif', 96, ['lossy']],
    ['avif', 100, ['lossy']],
  ] as const)('%s at %i → %j', (format, value, modes) => {
    expect(plannedModes(format, quality(value))).toEqual(modes)
  })
})

describe('encoderAttempt', () => {
  const ALL_VALUES = [10, 70, 95, 96, 100]

  it('passes JPEG quality through as given, with no defines', () => {
    for (const value of ALL_VALUES) {
      expect(encoderAttempt('jpeg', quality(value), 'lossy')).toEqual({
        mode: 'lossy',
        format: 'Jpeg',
        quality: value,
        defines: [],
      })
    }
  })

  it('refuses a lossless JPEG attempt', () => {
    expect(() => encoderAttempt('jpeg', quality(100), 'lossless')).toThrow(RangeError)
  })

  it('sets WebP method 4 on every attempt, never 6 (§7.3)', () => {
    for (const value of ALL_VALUES) {
      for (const mode of ['lossy', 'lossless'] as const) {
        expect(encoderAttempt('webp', quality(value), mode).defines).toContainEqual({
          format: 'WebP',
          name: 'method',
          value: String(WEBP_METHOD),
        })
      }
    }
    expect(WEBP_METHOD).toBe(4)
  })

  it('encodes lossy WebP at the slider value', () => {
    expect(encoderAttempt('webp', quality(70), 'lossy')).toEqual({
      mode: 'lossy',
      format: 'WebP',
      quality: 70,
      defines: [{ format: 'WebP', name: 'method', value: '4' }],
    })
  })

  it('encodes lossless WebP with the quality unset, which is what keeps it exact', () => {
    for (const value of [10, 70, 96, 100]) {
      const attempt = encoderAttempt('webp', quality(value), 'lossless')

      expect(attempt.quality).toBeNull()
      expect(attempt.defines).toContainEqual({ format: 'WebP', name: 'lossless', value: 'true' })
    }
  })

  it('sets AVIF speed 9 on every attempt, never the library default (§7.3, D7)', () => {
    for (const value of ALL_VALUES) {
      expect(encoderAttempt('avif', quality(value), 'lossy').defines).toContainEqual({
        format: 'Heic',
        name: 'speed',
        value: '9',
      })
    }
    expect(AVIF_SPEED).toBe(9)
  })

  it('writes AVIF defines under heic:, never avif: (T23)', () => {
    for (const value of ALL_VALUES) {
      for (const define of encoderAttempt('avif', quality(value), 'lossy').defines) {
        expect(define.format).toBe('Heic')
      }
    }
  })

  it("encodes AVIF at the slider value, capped below AOM's unusable lossless switch (D9)", () => {
    expect(encoderAttempt('avif', quality(70), 'lossy')).toMatchObject({ quality: 70 })
    // The cap takes only what it must: the band above 95 keeps its shape, and only 100 moves.
    expect(encoderAttempt('avif', quality(96), 'lossy').quality).toBe(96)
    expect(encoderAttempt('avif', quality(99), 'lossy').quality).toBe(99)
    // 100 is AOM's lossless mode, whose output no browser decodes correctly.
    expect(encoderAttempt('avif', quality(100), 'lossy').quality).toBe(AVIF_MAX_QUALITY)
    expect(AVIF_MAX_QUALITY).toBe(99)
  })

  it('drops chroma subsampling for a request above 95, and only then', () => {
    const chroma = { format: 'Heic', name: 'chroma', value: '444' }

    expect(encoderAttempt('avif', quality(96), 'lossy').defines).toContainEqual(chroma)
    expect(encoderAttempt('avif', quality(100), 'lossy').defines).toContainEqual(chroma)
    expect(encoderAttempt('avif', quality(95), 'lossy').defines).not.toContainEqual(chroma)
  })

  it('refuses a lossless AVIF attempt, since this build has none that works', () => {
    expect(() => encoderAttempt('avif', quality(100), 'lossless')).toThrow(RangeError)
  })

  it.each([0, 101, 70.5, Number.NaN])('rejects a quality of %s', (value) => {
    expect(() =>
      encoderAttempt('jpeg', { kind: 'quality', value, lossless: false }, 'lossy'),
    ).toThrow(RangeError)
  })
})

describe('colourPlan and unsupportedColour', () => {
  const icc: FrameColour = { kind: 'icc', profile: PROFILE, description: 'Display P3' }
  const untagged: FrameColour = { kind: 'untagged' }
  const cicp = (primaries: number, transfer: number, matrix: number): FrameColour => ({
    kind: 'cicp',
    cicp: { primaries, transfer, matrix, fullRange: true },
  })
  const ALL_FORMATS = ['jpeg', 'webp', 'avif'] as const

  it('writes an ICC profile verbatim to every format (R-I12)', () => {
    for (const format of ALL_FORMATS) {
      const plan = colourPlan(icc, format)

      expect(plan).toEqual({ kind: 'profile', profile: PROFILE })
      // The same bytes, not a copy that could drift.
      expect(plan.kind === 'profile' && plan.profile).toBe(PROFILE)
    }
  })

  it('adds nothing to an untagged frame (R-I14)', () => {
    for (const format of ALL_FORMATS) {
      expect(colourPlan(untagged, format)).toEqual({ kind: 'none' })
      expect(unsupportedColour(untagged, format)).toBeNull()
    }
  })

  it('keeps CICP primaries and transfer for AVIF, and states the matrix the writer really uses', () => {
    // Measured in T26: this build converts with BT.601 whatever it labels the file, so labelling it
    // with the source's matrix makes decoders invert a conversion that never happened.
    for (const [p, t, m] of [
      [12, 13, 6],
      [1, 13, 1],
      [9, 16, 9],
      [1, 13, 0],
    ]) {
      expect(colourPlan(cicp(p!, t!, m!), 'avif')).toEqual({
        kind: 'defines',
        defines: [
          { format: 'Heic', name: 'cicp', value: `${p},${t},6` },
          { format: 'Heic', name: 'preserve-cicp', value: 'true' },
        ],
      })
    }
  })

  it.each(['jpeg', 'webp'] as const)(
    'writes an sRGB-equivalent CICP to %s as untagged, not as a conversion',
    (format: StillFormat) => {
      for (const [p, t, m] of [
        [2, 2, 2],
        [1, 13, 6],
        [1, 13, 0],
      ]) {
        expect(unsupportedColour(cicp(p!, t!, m!), format)).toBeNull()
        expect(colourPlan(cicp(p!, t!, m!), format)).toEqual({ kind: 'none' })
      }
    },
  )

  it.each(['jpeg', 'webp'] as const)(
    'refuses any other CICP to %s rather than writing it as sRGB',
    (format: StillFormat) => {
      for (const [p, t, m] of [
        [12, 13, 6], // Display P3
        [9, 16, 9], // BT.2100 PQ
        [9, 18, 9], // BT.2100 HLG
        [1, 1, 1], // BT.709 transfer is not the sRGB transfer
        [1, 2, 1], // partly unspecified
        [2, 13, 2],
      ]) {
        expect(unsupportedColour(cicp(p!, t!, m!), format)).toContain('cannot be carried')
        expect(colourPlan(cicp(p!, t!, m!), format).kind).toBe('unsupported')
      }
    },
  )

  it('never refuses a colour AVIF can carry', () => {
    for (const colour of [icc, untagged, cicp(12, 13, 6), cicp(9, 16, 9)]) {
      expect(unsupportedColour(colour, 'avif')).toBeNull()
    }
  })
})

describe('countUniqueColors', () => {
  const rgba = (...pixels: number[][]) => new Uint8Array(pixels.flat())

  it('counts exact distinct RGBA values', () => {
    const pixels = rgba([0, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 255], [255, 0, 0, 255])

    expect(countUniqueColors(pixels, 100)).toBe(2)
  })

  it('treats the same RGB at a different alpha as a different colour', () => {
    expect(countUniqueColors(rgba([9, 9, 9, 255], [9, 9, 9, 0], [9, 9, 9, 128]), 100)).toBe(3)
  })

  it('counts a colour that recurs after a run only once', () => {
    const pixels = rgba([1, 1, 1, 1], [1, 1, 1, 1], [2, 2, 2, 2], [2, 2, 2, 2], [1, 1, 1, 1])

    expect(countUniqueColors(pixels, 100)).toBe(2)
  })

  it('stops as soon as the limit is passed and says so with limit + 1', () => {
    const pixels = new Uint8Array(1000 * 4)
    for (let index = 0; index < 1000; index += 1) {
      pixels[index * 4] = index & 255
      pixels[index * 4 + 1] = index >> 8
    }

    expect(countUniqueColors(pixels, 1000)).toBe(1000)
    expect(countUniqueColors(pixels, 999)).toBe(1000)
    expect(countUniqueColors(pixels, 10)).toBe(11)
  })

  it('handles an empty frame and a frame not aligned to a 4-byte offset', () => {
    expect(countUniqueColors(new Uint8Array(0), 10)).toBe(0)

    const backing = new Uint8Array(1 + 8)
    backing.set([7, 7, 7, 7, 8, 8, 8, 8], 1)
    expect(countUniqueColors(backing.subarray(1), 10)).toBe(2)
  })

  it('scans a large single-colour frame quickly', () => {
    const pixels = new Uint8Array(4000 * 3000 * 4).fill(200)
    const start = performance.now()

    expect(countUniqueColors(pixels, LOSSLESS_GATE_MAX_COLORS)).toBe(1)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('shouldTryLossless', () => {
  it('lets the lossless attempt run at and below the limit and skips it above', () => {
    expect(shouldTryLossless(1)).toBe(true)
    expect(shouldTryLossless(LOSSLESS_GATE_MAX_COLORS)).toBe(true)
    expect(shouldTryLossless(LOSSLESS_GATE_MAX_COLORS + 1)).toBe(false)
  })
})

describe('pickSmaller', () => {
  it('keeps lossy when lossy is smaller', () => {
    expect(pickSmaller(518_150, 1_357_564)).toBe('lossy')
  })

  it('keeps lossless when lossless is smaller', () => {
    expect(pickSmaller(16_586, 522)).toBe('lossless')
  })

  it('keeps lossless on a tie', () => {
    expect(pickSmaller(1000, 1000)).toBe('lossless')
  })
})

describe('isOpaque', () => {
  it('is true only when every alpha byte is 255', () => {
    expect(isOpaque(new Uint8Array([0, 0, 0, 255, 9, 9, 9, 255]))).toBe(true)
    expect(isOpaque(new Uint8Array([0, 0, 0, 255, 9, 9, 9, 254]))).toBe(false)
    expect(isOpaque(new Uint8Array([255, 255, 255, 0]))).toBe(false)
  })
})
