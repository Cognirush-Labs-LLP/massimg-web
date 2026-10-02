import { describe, expect, it } from 'vitest'
import type { BatchSettings } from '@/domain/job'
import type { EditRecord, ImageId, ImageRecord, Rgba } from '@/domain/types'
import { describeTransformLine, type TransformLine } from './transform-line'

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

const CROP_EDIT = {
  ops: [
    {
      kind: 'crop',
      rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      zoom: 1,
      background: OPAQUE_WHITE,
    },
  ],
  version: 1,
} as const satisfies EditRecord

const ROTATE_EDIT = {
  ops: [{ kind: 'rotate', quarterTurns: 1 }],
  version: 1,
} as const satisfies EditRecord

function image(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: 'image-1' as ImageId,
    name: 'photo.jpeg',
    relativePath: null,
    sizeBytes: 500_000,
    width: 4000,
    height: 3000,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    ...overrides,
  }
}

function batch(overrides: Partial<BatchSettings> = {}): BatchSettings {
  return {
    quality: { kind: 'quality', value: 70 },
    dimension: { kind: 'original' },
    format: 'dont-change',
    ...overrides,
  }
}

function described(line: TransformLine): Extract<TransformLine, { kind: 'described' }> {
  expect(line.kind).toBe('described')

  return line as Extract<TransformLine, { kind: 'described' }>
}

describe('describeTransformLine', () => {
  it('names the source and the output with their sizes', () => {
    const line = described(describeTransformLine(image(), batch({ format: 'webp' })))

    expect(line.sourceName).toBe('photo.jpeg')
    expect(line.sourceSize).toEqual({ width: 4000, height: 3000 })
    expect(line.outputName).toBe('photo.webp')
    expect(line.outputSize).toEqual({ width: 4000, height: 3000 })
    expect(line.outputFormat).toBe('webp')
  })

  it('reproduces the input extension exactly under "Don\'t change", including its case (R-X43)', () => {
    expect(described(describeTransformLine(image({ name: 'photo.JPG' }), batch())).outputName).toBe(
      'photo.JPG',
    )
    expect(
      described(describeTransformLine(image({ name: 'image.jpeg' }), batch())).outputName,
    ).toBe('image.jpeg')
  })

  it('uses the canonical extension when the format does change (R-X44)', () => {
    expect(
      described(describeTransformLine(image({ name: 'photo.jpeg' }), batch({ format: 'jpeg' })))
        .outputName,
    ).toBe('photo.jpg')
  })

  it('shows the real output extension when "Don\'t change" cannot be honoured (R-F2)', () => {
    const line = described(
      describeTransformLine(image({ name: 'IMG_0001.HEIC', sourceFormat: 'heic' }), batch()),
    )

    expect(line.outputName).toBe('IMG_0001.jpg')
    expect(line.outputFormat).toBe('jpeg')
  })

  it('names only the file, never its folder, for an image that came from a folder', () => {
    const line = described(
      describeTransformLine(
        image({ name: 'beach.jpeg', relativePath: 'holiday/day1/beach.jpeg' }),
        batch({ format: 'webp' }),
      ),
    )

    expect(line.outputName).toBe('beach.webp')
  })

  it('takes the output size from the crop, not from the dimension rule (R-D1)', () => {
    const line = described(
      describeTransformLine(
        image({ edit: CROP_EDIT }),
        batch({ dimension: { kind: 'fit-long-edge', pixels: 800 } }),
      ),
    )

    expect(line.outputSize).toEqual({ width: 2800, height: 1800 })
  })

  it('follows the dimension rule on the rotated size for a rotation-only edit (R-D4)', () => {
    const line = described(
      describeTransformLine(
        image({ edit: ROTATE_EDIT }),
        batch({ dimension: { kind: 'fixed-width', pixels: 1200 } }),
      ),
    )

    expect(line.outputSize).toEqual({ width: 1200, height: 1600 })
  })

  it('leaves both sizes out while the dimension probe is still pending', () => {
    const line = described(describeTransformLine(image({ width: 0, height: 0 }), batch()))

    expect(line.sourceSize).toBeNull()
    expect(line.outputSize).toBeNull()
  })

  it('discloses flattening when the output format has no alpha (R-C17)', () => {
    expect(
      described(
        describeTransformLine(image({ sourceFormat: 'png' }), batch({ format: 'jpeg' })),
      ).notes,
    ).toEqual(['alpha-flattened'])
  })

  it('stays silent about flattening for a JPEG source, which can never carry transparency', () => {
    const line = described(describeTransformLine(image(), batch({ format: 'jpeg' })))

    expect(line.notes).toEqual([])
  })

  it('stays silent for a JPEG source re-encoded to AVIF, the other alpha-less output', () => {
    const line = described(describeTransformLine(image(), batch({ format: 'avif' })))

    expect(line.notes).toEqual([])
  })

  it('discloses flattening when transparency has never been tested, which is every image today', () => {
    const line = described(
      describeTransformLine(
        image({ sourceFormat: 'png', hasTransparency: null }),
        batch({ format: 'jpeg' }),
      ),
    )

    expect(line.notes).toContain('alpha-flattened')
  })

  it('stays silent about flattening for an image measured to be opaque', () => {
    const line = described(
      describeTransformLine(
        image({ sourceFormat: 'png', hasTransparency: false }),
        batch({ format: 'jpeg' }),
      ),
    )

    expect(line.notes).toEqual([])
  })

  it('stays silent about flattening when the output format carries alpha', () => {
    const line = described(
      describeTransformLine(
        image({ sourceFormat: 'png', hasTransparency: true }),
        batch({ format: 'webp' }),
      ),
    )

    expect(line.notes).toEqual([])
  })

  it('states the animated substitution on the line itself (R-F6)', () => {
    const line = described(
      describeTransformLine(
        image({ name: 'loop.gif', sourceFormat: 'gif', isAnimated: true }),
        batch({ format: 'jpeg' }),
      ),
    )

    expect(line.notes).toEqual(['animation-substituted'])
    expect(line.outputFormat).toBe('webp')
    expect(line.outputName).toBe('loop.webp')
  })

  it('never pairs the two disclosures, because R-F6 substitutes WebP and WebP carries alpha', () => {
    // Worth pinning rather than assuming: the only alpha-less output formats are JPEG and AVIF, and
    // both of them are also the only still-only ones — so an animated source that would flatten is
    // always redirected to WebP first, and the flatten note can never apply to it. If a future
    // alpha-less *animated* format is ever added, this expectation breaks and the component's
    // note rendering has to handle two notes at once.
    for (const format of ['jpeg', 'avif'] as const) {
      const line = described(
        describeTransformLine(
          image({ sourceFormat: 'gif', isAnimated: true, hasTransparency: true }),
          batch({ format }),
        ),
      )

      expect(line.notes).toEqual(['animation-substituted'])
      expect(line.outputFormat).toBe('webp')
    }
  })

  it('reports no describable transform for an input the format rules reject (R-F8)', () => {
    expect(
      describeTransformLine(image({ sourceFormat: 'avif', isAnimated: true }), batch()),
    ).toEqual({ kind: 'unavailable' })
  })
})
