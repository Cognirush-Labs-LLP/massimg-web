import { describe, expect, it } from 'vitest'
import { resolveSettings, type BatchSettings, type SettingsImage } from './job'
import type { EditRecord, ResolvedDimension, Rgba } from './types'

const DIMENSIONS = [
  { kind: 'original' },
  { kind: 'fit-long-edge', pixels: 1920 },
  { kind: 'fixed-width', pixels: 1200 },
  { kind: 'fixed-height', pixels: 1080 },
] as const satisfies readonly ResolvedDimension[]

const ROTATE_EDIT = {
  ops: [{ kind: 'rotate', quarterTurns: 1 }],
  version: 1,
} as const satisfies EditRecord

const CROP_BACKGROUND = { r: 12, g: 34, b: 56, a: 0.25 } as const satisfies Rgba

const CROP_EDIT = {
  ops: [
    {
      kind: 'crop',
      rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      zoom: 1.25,
      background: CROP_BACKGROUND,
    },
  ],
  version: 1,
} as const satisfies EditRecord

const ROTATE_AND_CROP_EDIT = {
  ops: [...ROTATE_EDIT.ops, ...CROP_EDIT.ops],
  version: 2,
} as const satisfies EditRecord

const BASE_IMAGE = {
  sourceFormat: 'jpeg',
  isAnimated: false,
  edit: null,
} as const satisfies SettingsImage

const BASE_BATCH = {
  quality: { kind: 'quality', value: 70 },
  dimension: { kind: 'fit-long-edge', pixels: 1920 },
  format: 'jpeg',
} as const satisfies BatchSettings

function resolved(image: SettingsImage, batch: BatchSettings) {
  const result = resolveSettings(image, batch)

  expect(result.kind).toBe('resolved')
  if (result.kind === 'rejected') {
    throw new Error('Expected settings to resolve')
  }

  return result
}

describe('settings resolution', () => {
  describe('quality', () => {
    it.each([
      [10, 70, false],
      [40, 80, false],
      [70, 90, false],
      [84, 94 + 2 / 3, false],
      [85, 95, true],
      [86, 95 + 1 / 3, true],
      [100, 100, true],
    ] as const)('maps PNG slider quality %i to %f (lossless=%s)', (slider, mapped, lossless) => {
      const result = resolved(BASE_IMAGE, {
        ...BASE_BATCH,
        quality: { kind: 'quality', value: slider },
        format: 'png',
      })

      expect(result.settings.quality.kind).toBe('quality')
      if (result.settings.quality.kind === 'quality') {
        expect(result.settings.quality.value).toBeCloseTo(mapped, 12)
        expect(result.settings.quality.lossless).toBe(lossless)
      }
    })

    it.each([
      ['jpeg', 95, false],
      ['jpeg', 96, false],
      ['jpeg', 100, false],
      ['webp', 95, false],
      ['webp', 96, true],
      ['avif', 95, false],
      ['avif', 96, true],
      ['gif', 95, false],
      ['gif', 96, true],
    ] as const)('resolves %s slider quality %i (lossless=%s)', (format, value, lossless) => {
      const result = resolved(BASE_IMAGE, {
        ...BASE_BATCH,
        quality: { kind: 'quality', value },
        format,
      })

      expect(result.settings.quality).toEqual({ kind: 'quality', value, lossless })
    })

    it('passes a per-image size target through without applying a quality mapping', () => {
      const result = resolved(BASE_IMAGE, {
        ...BASE_BATCH,
        quality: { kind: 'size', targetBytes: 1_572_864 },
        format: 'png',
      })

      expect(result.settings.quality).toEqual({ kind: 'size', targetBytes: 1_572_864 })
    })
  })

  describe('dimension precedence', () => {
    const cases = DIMENSIONS.flatMap((dimension) => [
      { label: 'without a crop', dimension, edit: null, expected: dimension },
      { label: 'with a crop', dimension, edit: CROP_EDIT, expected: { kind: 'original' } as const },
    ])

    it('covers every crop and dimension combination', () => {
      expect(cases).toHaveLength(8)
      expect(
        new Set(cases.map(({ dimension, edit }) => `${dimension.kind}:${edit === null}`)).size,
      ).toBe(8)
    })

    it.each(cases)('$label under $dimension.kind', ({ dimension, edit, expected }) => {
      const result = resolved({ ...BASE_IMAGE, edit }, { ...BASE_BATCH, dimension })

      expect(result.settings.dimension).toEqual(expected)
    })

    it.each(DIMENSIONS)('does not let rotation override $kind', (dimension) => {
      const result = resolved({ ...BASE_IMAGE, edit: ROTATE_EDIT }, { ...BASE_BATCH, dimension })

      expect(result.settings.dimension).toEqual(dimension)
    })

    it.each(DIMENSIONS)(
      'lets crop override $kind even when rotation is also present',
      (dimension) => {
        const result = resolved(
          { ...BASE_IMAGE, edit: ROTATE_AND_CROP_EDIT },
          { ...BASE_BATCH, dimension },
        )

        expect(result.settings.dimension).toEqual({ kind: 'original' })
      },
    )
  })

  describe('format and alpha handling', () => {
    it('uses opaque white when an image resolves to JPEG outside Edit', () => {
      const result = resolved(
        { ...BASE_IMAGE, sourceFormat: 'png', edit: null },
        { ...BASE_BATCH, format: 'jpeg' },
      )

      expect(result.settings.alpha).toEqual({
        kind: 'flatten',
        background: { r: 255, g: 255, b: 255, a: 1 },
      })
    })

    it('uses the crop colour and resolves its stored alpha to opaque for JPEG', () => {
      const result = resolved(
        { ...BASE_IMAGE, sourceFormat: 'png', edit: CROP_EDIT },
        { ...BASE_BATCH, format: 'jpeg' },
      )

      expect(result.settings.alpha).toEqual({
        kind: 'flatten',
        background: { r: 12, g: 34, b: 56, a: 1 },
      })
      expect(CROP_EDIT.ops[0].background).toEqual(CROP_BACKGROUND)
    })

    it.each(['png', 'webp', 'avif', 'gif'] as const)('preserves alpha for %s output', (format) => {
      const result = resolved(
        { ...BASE_IMAGE, sourceFormat: 'png', edit: CROP_EDIT },
        { ...BASE_BATCH, format },
      )

      expect(result.settings.alpha).toEqual({ kind: 'preserve' })
    })

    it('resolves effective format and retains its animation-substitution caveat', () => {
      const result = resolved(
        { ...BASE_IMAGE, sourceFormat: 'gif', isAnimated: true },
        { ...BASE_BATCH, quality: { kind: 'quality', value: 96 }, format: 'jpeg' },
      )

      expect(result.settings.format).toBe('webp')
      expect(result.settings.isAnimated).toBe(true)
      expect(result.settings.quality).toEqual({ kind: 'quality', value: 96, lossless: true })
      expect(result.settings.alpha).toEqual({ kind: 'preserve' })
      expect(result.caveats).toEqual([{ kind: 'animation-substituted' }])
    })

    it('passes through the format resolver rejection for animated AVIF input', () => {
      expect(
        resolveSettings(
          { ...BASE_IMAGE, sourceFormat: 'avif', isAnimated: true },
          { ...BASE_BATCH, format: 'png' },
        ),
      ).toEqual({ kind: 'rejected', reason: 'animated-avif-input' })
    })
  })
})
