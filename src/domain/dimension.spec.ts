import { describe, expect, it } from 'vitest'
import { needsResize, resolveResizedSize } from './dimension'
import { resolveEditedSize } from './edit'
import { resolveSettings, type BatchSettings, type SettingsImage } from './job'
import type { BatchDimension, EditRecord, ResolvedDimension } from './types'

const fit = (pixels: number) => ({ kind: 'fit-long-edge', pixels }) as const
const width = (pixels: number) => ({ kind: 'fixed-width', pixels }) as const
const height = (pixels: number) => ({ kind: 'fixed-height', pixels }) as const

describe('resolveResizedSize', () => {
  describe('downscale', () => {
    it.each([
      ['landscape', { width: 4000, height: 3000 }, fit(1920), { width: 1920, height: 1440 }],
      ['portrait', { width: 3000, height: 4000 }, fit(1920), { width: 1440, height: 1920 }],
      ['square', { width: 2048, height: 2048 }, fit(1080), { width: 1080, height: 1080 }],
      ['rounded short edge', { width: 1001, height: 667 }, fit(500), { width: 500, height: 333 }],
      ['fixed width', { width: 4000, height: 3000 }, width(1200), { width: 1200, height: 900 }],
      ['fixed height', { width: 4000, height: 3000 }, height(720), { width: 960, height: 720 }],
    ] as const)('%s', (_, size, dimension, expected) => {
      expect(resolveResizedSize(size, dimension)).toEqual(expected)
      expect(needsResize(size, dimension)).toBe(true)
    })
  })

  describe('upscale (R-N2)', () => {
    it.each([
      ['fixed width', { width: 800, height: 600 }, width(1200), { width: 1200, height: 900 }],
      ['fixed height', { width: 640, height: 480 }, height(1080), { width: 1440, height: 1080 }],
      [
        'fixed width, portrait',
        { width: 300, height: 400 },
        width(3000),
        { width: 3000, height: 4000 },
      ],
    ] as const)('%s', (_, size, dimension, expected) => {
      expect(resolveResizedSize(size, dimension)).toEqual(expected)
      expect(needsResize(size, dimension)).toBe(true)
    })
  })

  describe('no-op', () => {
    it.each([
      ['original', { width: 4000, height: 3000 }, { kind: 'original' }],
      ['fit, already inside the limit', { width: 800, height: 600 }, fit(1920)],
      ['fit, long edge exactly at the limit', { width: 1920, height: 1080 }, fit(1920)],
      ['fit, portrait long edge exactly at the limit', { width: 1080, height: 1920 }, fit(1920)],
      ['fixed width already that width', { width: 1200, height: 777 }, width(1200)],
      ['fixed height already that height', { width: 555, height: 1080 }, height(1080)],
    ] as const satisfies readonly [string, { width: number; height: number }, ResolvedDimension][])(
      '%s',
      (_, size, dimension) => {
        expect(resolveResizedSize(size, dimension)).toEqual(size)
        expect(needsResize(size, dimension)).toBe(false)
      },
    )

    it('never enlarges under fit within long edge', () => {
      expect(resolveResizedSize({ width: 16, height: 9 }, fit(3840))).toEqual({
        width: 16,
        height: 9,
      })
    })
  })

  it('floors a derived edge at one pixel', () => {
    expect(resolveResizedSize({ width: 10000, height: 2 }, fit(100))).toEqual({
      width: 100,
      height: 1,
    })
    expect(resolveResizedSize({ width: 2, height: 10000 }, height(100))).toEqual({
      width: 1,
      height: 100,
    })
  })

  it('returns a new object rather than the input', () => {
    const size = { width: 10, height: 10 }

    expect(resolveResizedSize(size, { kind: 'original' })).not.toBe(size)
  })

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a dimension value of %s',
    (pixels) => {
      for (const dimension of [fit(pixels), width(pixels), height(pixels)]) {
        expect(() => resolveResizedSize({ width: 100, height: 100 }, dimension)).toThrow(RangeError)
      }
    },
  )

  it('rejects an unknown rule', () => {
    expect(() =>
      resolveResizedSize({ width: 1, height: 1 }, {
        kind: 'stretch',
      } as unknown as ResolvedDimension),
    ).toThrow(RangeError)
  })

  it('pins the constrained edge exactly and keeps aspect within rounding, over a grid', () => {
    const edges = [1, 2, 3, 7, 99, 100, 101, 333, 1080, 1919, 1920, 1921, 4032, 6000]
    const values = [1, 2, 50, 99, 100, 101, 720, 1080, 1919, 1920, 3840]

    for (const w of edges) {
      for (const h of edges) {
        for (const n of values) {
          const fitted = resolveResizedSize({ width: w, height: h }, fit(n))
          const long = Math.max(fitted.width, fitted.height)

          if (Math.max(w, h) <= n) {
            expect(fitted).toEqual({ width: w, height: h })
          } else {
            expect(long).toBe(n)
            // The derived edge is the nearest whole pixel to the exact proportion.
            const short = Math.min(fitted.width, fitted.height)
            const exact = (Math.min(w, h) * n) / Math.max(w, h)
            expect(Math.abs(short - Math.max(1, exact))).toBeLessThanOrEqual(0.5)
          }

          const byWidth = resolveResizedSize({ width: w, height: h }, width(n))
          expect(byWidth.width).toBe(n)
          expect(Math.abs(byWidth.height - Math.max(1, (h * n) / w))).toBeLessThanOrEqual(0.5)

          const byHeight = resolveResizedSize({ width: w, height: h }, height(n))
          expect(byHeight.height).toBe(n)
          expect(Math.abs(byHeight.width - Math.max(1, (w * n) / h))).toBeLessThanOrEqual(0.5)
        }
      }
    }
  })
})

describe('dimension rule and edits', () => {
  const image = (edit: EditRecord | null): SettingsImage => ({
    sourceFormat: 'jpeg',
    isAnimated: false,
    edit,
  })
  const batch = (dimension: BatchDimension): BatchSettings => ({
    quality: { kind: 'quality', value: 70 },
    dimension,
    format: 'jpeg',
    animatedAsWebp: true,
  })

  function outputSize(
    source: { width: number; height: number },
    edit: EditRecord | null,
    rule: BatchDimension,
  ) {
    const result = resolveSettings(image(edit), batch(rule))
    if (result.kind !== 'resolved') {
      throw new Error('expected settings to resolve')
    }

    return resolveResizedSize(resolveEditedSize(source, edit?.ops ?? []), result.settings.dimension)
  }

  it('a cropped image takes its size from the crop, ignoring the rule (R-D1)', () => {
    const crop: EditRecord = {
      ops: [
        {
          kind: 'crop',
          rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          zoom: 1,
          background: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      version: 1,
    }

    for (const rule of [fit(100), width(3000), height(50)]) {
      expect(outputSize({ width: 4000, height: 3000 }, crop, rule)).toEqual({
        width: 2000,
        height: 1500,
      })
    }
  })

  it('a rotated but uncropped image follows the rule on its rotated size (R-D4)', () => {
    const rotate: EditRecord = { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 1 }

    expect(outputSize({ width: 4000, height: 3000 }, rotate, fit(1920))).toEqual({
      width: 1440,
      height: 1920,
    })
    expect(outputSize({ width: 4000, height: 3000 }, rotate, width(1200))).toEqual({
      width: 1200,
      height: 1600,
    })
  })
})
