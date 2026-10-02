import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CROP_LIMITS,
  editOpsFor,
  resolveCropGeometry,
  resolveCropInput,
  type PixelSize,
} from './edit'
import {
  describePrimaryActionOutput,
  QUALITY_SLIDER_MAX,
  QUALITY_SLIDER_MIN,
  qualityForSlider,
  requestIsSatisfiedBySource,
  resolveSettings,
  singleImageDimensions,
  type BatchSettings,
  type SettingsImage,
} from './job'
import type {
  EditRecord,
  ImageId,
  ImageRecord,
  ResolvedDimension,
  ResolvedSettings,
  Rgba,
} from './types'

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
      'does not let a rotation applied through the real editor override $kind (R-D4)',
      (dimension) => {
        // The gap CORE-001 found: `ROTATE_EDIT` above is hand-built and never exercised the bug,
        // because `editOpsFor` — the function the editor actually calls — used to append a no-op
        // crop even for a rotation-only edit. This composes the real path instead:
        // resolveCropInput -> resolveCropGeometry -> editOpsFor -> resolveSettings.
        const source: PixelSize = { width: 4000, height: 3000 }
        const frame: PixelSize = { width: 800, height: 600 }

        const geometry = resolveCropGeometry(
          resolveCropInput({
            source,
            frame,
            quarterTurns: 1,
            ratio: { kind: 'free' },
            limits: DEFAULT_CROP_LIMITS,
          }),
        )

        if (geometry.kind !== 'resolved') {
          throw new Error(`expected resolved geometry, received ${geometry.reason}`)
        }

        const ops = editOpsFor(geometry, 1, { r: 255, g: 255, b: 255, a: 1 })
        const edit: EditRecord = { ops, version: 1 }

        const result = resolved({ ...BASE_IMAGE, edit }, { ...BASE_BATCH, dimension })

        expect(result.settings.dimension).toEqual(dimension)
      },
    )

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

    // T29: the source format is carried into the resolved settings because two pipeline decisions
    // key off it rather than off the output — which codecs a job loads, and which decoder the
    // animated path uses. R-F6's substitution changes the output and must not touch the source.
    it('carries the source format through, unchanged by an output substitution', () => {
      const substituted = resolved(
        { ...BASE_IMAGE, sourceFormat: 'png', isAnimated: true },
        { ...BASE_BATCH, format: 'jpeg' },
      )

      expect(substituted.settings.format).toBe('webp')
      expect(substituted.settings.sourceFormat).toBe('png')
    })

    it('carries the source format through for every input format it accepts', () => {
      for (const sourceFormat of ['jpeg', 'png', 'webp', 'gif', 'heic'] as const) {
        expect(resolved({ ...BASE_IMAGE, sourceFormat }, BASE_BATCH).settings.sourceFormat).toBe(
          sourceFormat,
        )
      }
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

// T30: the size-target search walks the slider itself and maps each position through the same
// function `resolveSettings` uses, so that a searched file is one the quality path could also have
// produced (§7.5).
describe('qualityForSlider', () => {
  it('is what settings resolution uses, for every format and both ends of the slider', () => {
    for (const format of ['jpeg', 'png', 'webp', 'avif', 'gif'] as const) {
      for (const slider of [QUALITY_SLIDER_MIN, 55, 95, 96, QUALITY_SLIDER_MAX]) {
        const viaResolution = resolved(BASE_IMAGE, {
          ...BASE_BATCH,
          quality: { kind: 'quality', value: slider },
          format,
        })

        expect(qualityForSlider(slider, format), `${format} at ${slider}`).toEqual(
          viaResolution.settings.quality,
        )
      }
    }
  })

  it('covers the slider Functional Design §4.1 offers', () => {
    expect([QUALITY_SLIDER_MIN, QUALITY_SLIDER_MAX]).toEqual([10, 100])
  })
})

// R-Q2's pass-through and R-X24's substitution both need this test, and R-X45 is what it says: the
// original may only be returned when returning it gives the user what they asked for.
describe('requestIsSatisfiedBySource', () => {
  const settings = (overrides: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
    quality: { kind: 'size', targetBytes: 100_000 },
    dimension: { kind: 'original' },
    format: 'jpeg',
    sourceFormat: 'jpeg',
    isAnimated: false,
    alpha: { kind: 'preserve' },
    ...overrides,
  })

  it('is true when the job asks for nothing the source does not already have', () => {
    expect(requestIsSatisfiedBySource(settings(), null)).toBe(true)
  })

  it('is false when the format changes', () => {
    expect(requestIsSatisfiedBySource(settings({ format: 'webp' }), null)).toBe(false)
  })

  it.each([
    { kind: 'fit-long-edge', pixels: 1920 },
    { kind: 'fixed-width', pixels: 1200 },
    { kind: 'fixed-height', pixels: 1080 },
  ] as const)('is false under a $kind rule', (dimension) => {
    expect(requestIsSatisfiedBySource(settings({ dimension }), null)).toBe(false)
  })

  it.each([
    ['a rotation', ROTATE_EDIT],
    ['a crop', CROP_EDIT],
  ] as const)('is false under %s', (_label, edit) => {
    // A crop forces the resolved dimension back to `original`, so the edit is what has to be seen.
    expect(requestIsSatisfiedBySource(settings(), edit)).toBe(false)
  })

  it('is true for an animated source whose format is unchanged', () => {
    expect(
      requestIsSatisfiedBySource(
        settings({ format: 'gif', sourceFormat: 'gif', isAnimated: true }),
        null,
      ),
    ).toBe(true)
  })

  it('is false for a source format that cannot be written at all', () => {
    expect(requestIsSatisfiedBySource(settings({ sourceFormat: 'heic' }), null)).toBe(false)
  })
})

describe('describePrimaryActionOutput', () => {
  let nextId = 0

  function image(overrides: Partial<ImageRecord> = {}): ImageRecord {
    nextId += 1

    return {
      id: `image-${nextId}` as ImageId,
      name: 'photo.jpg',
      relativePath: null,
      sizeBytes: 500_000,
      width: 4000,
      height: 3000,
      sourceFormat: 'jpeg',
      isAnimated: false,
      frameCount: null,
      hasTransparency: false,
      edit: null,
      status: 'ready',
      failure: null,
      ...overrides,
    }
  }

  const batch = (overrides: Partial<BatchSettings> = {}): BatchSettings => ({
    quality: { kind: 'quality', value: 70 },
    dimension: { kind: 'original' },
    format: 'dont-change',
    ...overrides,
  })

  it('reports empty for an empty batch', () => {
    expect(describePrimaryActionOutput([], batch())).toEqual({ kind: 'empty' })
  })

  it('names the setting, not a resolved format, for a multi-image "Don\'t change" batch', () => {
    expect(describePrimaryActionOutput([image(), image()], batch())).toEqual({
      kind: 'multi',
      count: 2,
      formatLabel: 'original',
    })
  })

  it('names the chosen format for a multi-image batch with a concrete format', () => {
    expect(
      describePrimaryActionOutput([image(), image(), image()], batch({ format: 'webp' })),
    ).toEqual({ kind: 'multi', count: 3, formatLabel: 'webp' })
  })

  it('never names a concrete format for a single image under "Don\'t change" (R-F4)', () => {
    expect(describePrimaryActionOutput([image({ sourceFormat: 'png' })], batch())).toEqual({
      kind: 'single',
      formatLabel: 'original',
      dimensions: { width: 4000, height: 3000 },
    })
  })

  it('resolves the real output format for a single image with a concrete format', () => {
    expect(describePrimaryActionOutput([image()], batch({ format: 'avif' }))).toEqual({
      kind: 'single',
      formatLabel: 'avif',
      dimensions: { width: 4000, height: 3000 },
    })
  })

  it('shows the R-F6 substitution, not the requested still-only format, for a single animated source', () => {
    expect(
      describePrimaryActionOutput(
        [image({ sourceFormat: 'gif', isAnimated: true })],
        batch({ format: 'jpeg' }),
      ),
    ).toEqual({ kind: 'single', formatLabel: 'webp', dimensions: { width: 4000, height: 3000 } })
  })

  it('takes dimensions from the crop, not the dimension rule, for a single cropped image (R-D1)', () => {
    expect(
      describePrimaryActionOutput(
        [image({ edit: CROP_EDIT })],
        batch({ dimension: { kind: 'fit-long-edge', pixels: 800 } }),
      ),
    ).toEqual({
      kind: 'single',
      formatLabel: 'original',
      // rect { width: 0.7, height: 0.6 } over a 4000x3000 source, per resolveCropOutput.
      dimensions: { width: 2800, height: 1800 },
    })
  })

  it('follows the batch dimension rule, applied to the rotated size, for a rotation-only image (R-D4)', () => {
    expect(
      describePrimaryActionOutput(
        [image({ edit: ROTATE_EDIT, width: 4000, height: 3000 })],
        batch({ dimension: { kind: 'fixed-width', pixels: 1200 } }),
      ),
    ).toEqual({
      kind: 'single',
      formatLabel: 'original',
      // Rotated to 3000x4000, then fixed-width 1200 derives height preserving that ratio.
      dimensions: { width: 1200, height: 1600 },
    })
  })

  it('omits dimensions rather than inventing them while the probe is still pending', () => {
    expect(describePrimaryActionOutput([image({ width: 0, height: 0 })], batch())).toEqual({
      kind: 'single',
      formatLabel: 'original',
      dimensions: null,
    })
  })

  // Exported since T36 so the Preview transform line shows the same figure as the meta line above.
  describe('singleImageDimensions', () => {
    it('returns the batch rule applied to the source for an unedited image', () => {
      expect(singleImageDimensions(image(), { kind: 'fit-long-edge', pixels: 2000 })).toEqual({
        width: 2000,
        height: 1500,
      })
    })

    it('takes the size from the crop, ignoring the batch rule (R-D1)', () => {
      expect(
        singleImageDimensions(image({ edit: CROP_EDIT }), { kind: 'fit-long-edge', pixels: 800 }),
      ).toEqual({ width: 2800, height: 1800 })
    })

    it('applies the batch rule to the rotated size for a rotation-only edit (R-D4)', () => {
      expect(singleImageDimensions(image({ edit: ROTATE_EDIT }), { kind: 'original' })).toEqual({
        width: 3000,
        height: 4000,
      })
    })

    it('is null while the source dimensions are unknown', () => {
      expect(singleImageDimensions(image({ width: 0, height: 0 }), { kind: 'original' })).toBeNull()
    })
  })
})
