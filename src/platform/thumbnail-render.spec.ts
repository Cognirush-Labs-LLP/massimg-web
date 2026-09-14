import { describe, expect, it } from 'vitest'

import { fitWithin, scaleToFit, thumbnailSize } from './thumbnail-render'
import type { EditOp, Rgba } from '@/domain/types'

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

describe('fitWithin', () => {
  it('bounds the long edge of a landscape source', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, 384)).toEqual({ width: 384, height: 288 })
  })

  it('bounds the long edge of a portrait source, not its width', () => {
    // The whole point of bounding both axes: a width-only bound would leave this 512 px tall.
    expect(fitWithin({ width: 3000, height: 4000 }, 384)).toEqual({ width: 288, height: 384 })
  })

  it('bounds a square source on both axes', () => {
    expect(fitWithin({ width: 2000, height: 2000 }, 384)).toEqual({ width: 384, height: 384 })
  })

  it('never upscales a source already inside the bound', () => {
    expect(fitWithin({ width: 120, height: 90 }, 384)).toEqual({ width: 120, height: 90 })
  })

  it('never returns a zero dimension for an extreme aspect ratio', () => {
    const fitted = fitWithin({ width: 10000, height: 3 }, 384)

    expect(fitted.width).toBe(384)
    expect(fitted.height).toBe(1)
  })
})

describe('scaleToFit', () => {
  it('is the ratio that brings the longer axis to the bound', () => {
    expect(scaleToFit({ width: 800, height: 400 }, 400)).toBe(0.5)
    expect(scaleToFit({ width: 400, height: 800 }, 400)).toBe(0.5)
  })

  it('is capped at 1 so a small source is never enlarged', () => {
    expect(scaleToFit({ width: 100, height: 50 }, 400)).toBe(1)
  })
})

describe('thumbnailSize', () => {
  const source = { width: 4000, height: 3000 }

  it('matches the unedited bound when there are no operations', () => {
    expect(thumbnailSize(source, [], 384)).toEqual({ width: 384, height: 288 })
  })

  it('swaps the axes for an odd quarter turn (R-G4)', () => {
    const ops: EditOp[] = [{ kind: 'rotate', quarterTurns: 1 }]

    expect(thumbnailSize(source, ops, 384)).toEqual({ width: 288, height: 384 })
  })

  it('leaves the axes alone for a half turn', () => {
    const ops: EditOp[] = [{ kind: 'rotate', quarterTurns: 2 }]

    expect(thumbnailSize(source, ops, 384)).toEqual({ width: 384, height: 288 })
  })

  it('follows the aspect ratio a crop produces, not the source aspect (R-G4)', () => {
    const ops: EditOp[] = [
      {
        kind: 'crop',
        rect: { x: 0.25, y: 0, width: 0.5, height: 1 },
        zoom: 1,
        background: OPAQUE_WHITE,
      },
    ]

    // 2000x3000 after the crop, so the bound now applies to the height.
    expect(thumbnailSize(source, ops, 384)).toEqual({ width: 256, height: 384 })
  })

  it('applies rotation before crop, in stored order', () => {
    const ops: EditOp[] = [
      { kind: 'rotate', quarterTurns: 1 },
      {
        kind: 'crop',
        rect: { x: 0, y: 0, width: 1, height: 0.5 },
        zoom: 1,
        background: OPAQUE_WHITE,
      },
    ]

    // 4000x3000 -> rotate -> 3000x4000 -> crop to half the height -> 3000x2000.
    expect(thumbnailSize(source, ops, 384)).toEqual({ width: 384, height: 256 })
  })
})
