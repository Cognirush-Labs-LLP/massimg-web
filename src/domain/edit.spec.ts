import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CROP_LIMITS,
  RATIO_IDS,
  addQuarterTurns,
  aspectRatioFor,
  constrainCropRect,
  cropRectForTypedDimension,
  editOpsFor,
  fitScale,
  hasCropOp,
  hasSpill,
  imageRectInFrame,
  resolveCropGeometry,
  resolveCropInput,
  resolveCropOutput,
  resolveEditedSize,
  geometryEdit,
  trailingResizeOp,
  rotateCropInput,
  rotateSize,
  toFrameRect,
  toNormalisedRect,
  withTrailingResize,
  type CropGeometryInput,
  type FrameRect,
  type PixelSize,
  type QuarterTurns,
  type RatioId,
  type ResolvedCropGeometry,
} from './edit'
import type { EditOp, Rgba } from './types'

const SOURCE = { width: 4000, height: 3000 } as const satisfies PixelSize
const FRAME = { width: 800, height: 600 } as const satisfies PixelSize
const CROP = { width: 400, height: 300 } as const satisfies PixelSize
const CENTRED_CROP = { left: 200, top: 150, width: 400, height: 300 } as const satisfies FrameRect
const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

interface WorkedExampleRow {
  zoom: number
  drawScale: number
  drawn: PixelSize
  output: PixelSize
  spills: boolean
}

const WORKED_EXAMPLE = [
  {
    zoom: 1,
    drawScale: 0.2,
    drawn: { width: 800, height: 600 },
    output: { width: 2000, height: 1500 },
    spills: false,
  },
  {
    zoom: 2,
    drawScale: 0.4,
    drawn: { width: 1600, height: 1200 },
    output: { width: 1000, height: 750 },
    spills: false,
  },
  {
    zoom: 0.5,
    drawScale: 0.1,
    drawn: { width: 400, height: 300 },
    output: { width: 4000, height: 3000 },
    spills: false,
  },
  {
    zoom: 0.25,
    drawScale: 0.05,
    drawn: { width: 200, height: 150 },
    output: { width: 8000, height: 6000 },
    spills: true,
  },
] as const satisfies readonly WorkedExampleRow[]

const LOCKED_RATIO_IDS = RATIO_IDS.filter((id) => id !== 'free')

function input(overrides: Partial<CropGeometryInput> = {}): CropGeometryInput {
  return {
    source: SOURCE,
    quarterTurns: 0,
    frame: FRAME,
    zoom: 1,
    rect: CENTRED_CROP,
    ratio: { kind: 'free' },
    limits: DEFAULT_CROP_LIMITS,
    ...overrides,
  }
}

function resolved(overrides: Partial<CropGeometryInput> = {}): ResolvedCropGeometry {
  const geometry = resolveCropGeometry(input(overrides))

  if (geometry.kind !== 'resolved') {
    throw new Error(`expected resolved geometry, received ${geometry.reason}`)
  }

  return geometry
}

describe('crop and rotation arithmetic', () => {
  it('covers the worked example table exactly once per zoom step', () => {
    expect(WORKED_EXAMPLE).toHaveLength(4)
    expect(new Set(WORKED_EXAMPLE.map((row) => row.zoom)).size).toBe(WORKED_EXAMPLE.length)
    expect(fitScale(SOURCE, FRAME)).toBe(0.2)

    const byZoom = [...WORKED_EXAMPLE].sort((a, b) => a.zoom - b.zoom)

    expect(byZoom.map((row) => row.output.width)).toEqual([8000, 4000, 2000, 1000])
    expect(WORKED_EXAMPLE.filter((row) => row.spills).map((row) => row.output.width)).toEqual([
      8000,
    ])
  })

  it('takes the binding axis for the fit scale', () => {
    expect(fitScale(SOURCE, FRAME)).toBe(800 / 4000)
    expect(fitScale(SOURCE, FRAME)).toBe(600 / 3000)
  })

  it.each(WORKED_EXAMPLE)(
    'at zoom $zoom draws $drawn.width×$drawn.height and outputs $output.width×$output.height',
    ({ zoom, drawScale, drawn, output, spills }) => {
      const geometry = resolved({ zoom })

      expect(geometry.drawScale).toBeCloseTo(drawScale, 10)
      expect(geometry.imageRect.width).toBeCloseTo(drawn.width, 10)
      expect(geometry.imageRect.height).toBeCloseTo(drawn.height, 10)
      expect(geometry.output.size).toEqual(output)
      expect(hasSpill(geometry.output.spill)).toBe(spills)
    },
  )

  it.each(WORKED_EXAMPLE)(
    'derives the same output size from source fractions as from the frame at zoom $zoom',
    ({ zoom, drawScale, output }) => {
      const geometry = resolved({ zoom })

      expect(resolveCropOutput(geometry.normalisedRect, SOURCE).size).toEqual(output)
      expect(Math.abs(CROP.width / drawScale - output.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(CROP.height / drawScale - output.height)).toBeLessThanOrEqual(1)
    },
  )

  it('sizes the output from source fractions rather than the frame formula', () => {
    const geometry = resolved({
      source: { width: 1565, height: 4771 },
      frame: { width: 327, height: 271 },
      zoom: 0.6356195350781404,
      rect: { left: 100, top: 100, width: 2.4731341939683626, height: 40 },
    })

    expect(geometry.output.size.width).toBe(68)
  })

  it('normalises a spilled rectangle outside the unit square', () => {
    const geometry = resolved({ zoom: 0.25 })

    expect(geometry.normalisedRect).toEqual({ x: -0.5, y: -0.5, width: 2, height: 2 })
    expect(geometry.output.spill).toEqual({ left: 2000, top: 1500, right: 2000, bottom: 1500 })
    expect(geometry.output.placement).toEqual({
      offsetX: 2000,
      offsetY: 1500,
      width: 4000,
      height: 3000,
    })
  })

  it('reports no spill when the rectangle exactly covers the image', () => {
    const geometry = resolved({ zoom: 0.5 })

    expect(geometry.normalisedRect).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(geometry.output.spill).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(hasSpill(geometry.output.spill)).toBe(false)
  })

  it('reports spill on one side only when the rectangle overhangs one edge', () => {
    const geometry = resolved({
      zoom: 0.5,
      rect: { left: 190, top: 150, width: 400, height: 300 },
    })

    expect(geometry.output.spill.left).toBeGreaterThan(0)
    expect(geometry.output.spill.right).toBe(0)
    expect(geometry.output.spill.top).toBe(0)
    expect(geometry.output.spill.bottom).toBe(0)
  })

  it('round trips a rectangle through both coordinate spaces', () => {
    const imageRect = imageRectInFrame(SOURCE, FRAME, 0.2)
    const normalised = toNormalisedRect(CENTRED_CROP, imageRect)
    const restored = toFrameRect(normalised, imageRect)

    expect(restored.left).toBeCloseTo(CENTRED_CROP.left, 10)
    expect(restored.top).toBeCloseTo(CENTRED_CROP.top, 10)
    expect(restored.width).toBeCloseTo(CENTRED_CROP.width, 10)
    expect(restored.height).toBeCloseTo(CENTRED_CROP.height, 10)
  })

  it.each([
    [2000, 2000],
    [1000, 1000],
    [4000, 4000],
    [8000, 4000],
    [4, 16],
    [0, 16],
    [Number.NaN, 16],
  ])('reports %d typed output pixels as %d after clamping', (typed, expected) => {
    const base = input()
    const geometry = resolveCropGeometry({
      ...base,
      rect: cropRectForTypedDimension(base, { kind: 'width', pixels: typed }),
    })

    expect(geometry.kind).toBe('resolved')
    expect(geometry.kind === 'resolved' && geometry.output.size.width).toBe(expected)
  })

  it('derives the other axis from a locked ratio when a dimension is typed', () => {
    const base = input({ ratio: aspectRatioFor('1:1') })
    const geometry = resolveCropGeometry({
      ...base,
      rect: cropRectForTypedDimension(base, { kind: 'height', pixels: 1500 }),
    })

    expect(geometry.kind === 'resolved' && geometry.output.size).toEqual({
      width: 1500,
      height: 1500,
    })
  })

  it.each(LOCKED_RATIO_IDS)('locks the rectangle and the output to %s', (id: RatioId) => {
    const ratio = aspectRatioFor(id)
    const geometry = resolved({ ratio })
    const target = ratio.kind === 'locked' ? ratio.ratio : 0

    expect(geometry.rect.width / geometry.rect.height).toBeCloseTo(target, 9)
    expect(geometry.output.size.width / geometry.output.size.height).toBeCloseTo(target, 2)
    expect(geometry.rect.left).toBeGreaterThanOrEqual(0)
    expect(geometry.rect.top).toBeGreaterThanOrEqual(0)
    expect(geometry.rect.left + geometry.rect.width).toBeLessThanOrEqual(FRAME.width)
    expect(geometry.rect.top + geometry.rect.height).toBeLessThanOrEqual(FRAME.height)
  })

  it('leaves a free rectangle untouched inside the frame', () => {
    expect(resolved().rect).toEqual(CENTRED_CROP)
  })

  it('clamps each axis to the frame independently when the ratio is free', () => {
    expect(
      constrainCropRect(
        { left: 100, top: 100, width: 4000, height: 3000 },
        {
          frame: FRAME,
          drawScale: 0.2,
          ratio: { kind: 'free' },
          limits: DEFAULT_CROP_LIMITS,
          anchor: 'centre',
        },
      ),
    ).toEqual({ left: 0, top: 0, width: 800, height: 600 })
  })

  it('holds the named corner when the anchor is not the centre', () => {
    const rect = { left: 100, top: 100, width: 200, height: 150 }
    const constraints = {
      frame: FRAME,
      drawScale: 0.2,
      ratio: aspectRatioFor('1:1'),
      limits: DEFAULT_CROP_LIMITS,
      anchor: 'top-left',
    } as const

    expect(constrainCropRect(rect, constraints)).toEqual({
      left: 100,
      top: 100,
      width: 200,
      height: 200,
    })
    expect(constrainCropRect(rect, { ...constraints, anchor: 'centre' })).toEqual({
      left: 100,
      top: 75,
      width: 200,
      height: 200,
    })
  })

  it.each([
    { left: 0, top: 0, width: -50, height: 40 },
    { left: -900, top: -900, width: 0, height: 0 },
    { left: 700, top: 500, width: 4000, height: 4000 },
    { left: Number.NaN, top: 10, width: Number.NaN, height: 200 },
  ] as const satisfies readonly FrameRect[])('constrains %j idempotently', (rect: FrameRect) => {
    const constraints = {
      frame: FRAME,
      drawScale: 0.2,
      ratio: aspectRatioFor('4:5'),
      limits: DEFAULT_CROP_LIMITS,
      anchor: 'centre',
    } as const
    const once = constrainCropRect(rect, constraints)

    expect(constrainCropRect(once, constraints)).toEqual(once)
    expect(once.left).toBeGreaterThanOrEqual(0)
    expect(once.left + once.width).toBeLessThanOrEqual(FRAME.width)
  })

  it('keeps the frame when the minimum size cannot fit inside it', () => {
    const constrained = constrainCropRect(CENTRED_CROP, {
      frame: FRAME,
      drawScale: 0.2,
      ratio: { kind: 'free' },
      limits: { minimumOutputPixels: 16, minimumFramePixels: 5000 },
      anchor: 'centre',
    })

    expect(constrained).toEqual({ left: 0, top: 0, width: 800, height: 600 })
  })

  it('raises the advertised output floor when the frame floor binds', () => {
    const geometry = resolved({
      zoom: 0.25,
      limits: { minimumOutputPixels: 16, minimumFramePixels: 40 },
    })

    expect(geometry.minimumRect).toEqual({ width: 40, height: 40 })
    expect(geometry.minimumOutput.width).toBeGreaterThan(16)
  })

  it('swaps the source and refits to the fit point on a quarter turn', () => {
    const turned = rotateCropInput(input({ zoom: 2 }), 1)
    const geometry = resolveCropGeometry(turned)

    expect(turned.zoom).toBe(1)
    expect(geometry.kind === 'resolved' && geometry.rotatedSource).toEqual({
      width: 3000,
      height: 4000,
    })
    expect(geometry.kind === 'resolved' && geometry.fitScale).toBe(0.15)
    expect(geometry.kind === 'resolved' && geometry.imageRect.width).toBeCloseTo(450, 10)
    expect(geometry.kind === 'resolved' && geometry.imageRect.height).toBeCloseTo(600, 10)
    expect(geometry.kind === 'resolved' && geometry.output.size).toEqual({
      width: 3000,
      height: 4000,
    })
    expect(geometry.kind === 'resolved' && hasSpill(geometry.output.spill)).toBe(false)
  })

  it('returns to the original dimensions after two and after four quarter turns', () => {
    const start = input()
    const half = rotateCropInput(rotateCropInput(start, 1), 1)
    const full = rotateCropInput(rotateCropInput(half, 1), 1)
    const halfGeometry = resolveCropGeometry(half)

    expect(halfGeometry.kind === 'resolved' && halfGeometry.output.size).toEqual({
      width: 4000,
      height: 3000,
    })
    expect(full.quarterTurns).toBe(0)
    expect(full).toEqual(resolveCropInput({ ...start, quarterTurns: 0 }))
  })

  it('keeps a locked ratio through a quarter turn and refits the rectangle to it', () => {
    const turned = rotateCropInput(input({ ratio: aspectRatioFor('4:5') }), 1)
    const geometry = resolveCropGeometry(turned)

    expect(turned.ratio).toEqual(aspectRatioFor('4:5'))
    expect(geometry.kind === 'resolved' && geometry.rect.width / geometry.rect.height).toBeCloseTo(
      4 / 5,
      9,
    )
  })

  it.each([
    [0, 1, 1],
    [1, 1, 2],
    [3, 1, 0],
    [2, 2, 0],
    [3, 3, 2],
  ] as const satisfies readonly (readonly [QuarterTurns, QuarterTurns, QuarterTurns])[])(
    'adds %d and %d quarter turns to give %d',
    (turns, delta, expected) => {
      expect(addQuarterTurns(turns, delta)).toBe(expected)
    },
  )

  it.each([
    ['free', 0],
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
  ] as const satisfies readonly (readonly [RatioId, number])[])(
    'resolves the %s chip',
    (id, expected) => {
      const ratio = aspectRatioFor(id)

      expect(ratio.kind === 'locked' ? ratio.ratio : 0).toBe(expected)
    },
  )

  it('walks an operation list in order without assuming rotate then crop', () => {
    const fullFrame = { x: 0, y: 0, width: 1, height: 1 }
    const half = { x: 0, y: 0, width: 0.5, height: 0.5 }
    const rotate = { kind: 'rotate', quarterTurns: 1 } as const satisfies EditOp
    const cropHalf = {
      kind: 'crop',
      rect: half,
      zoom: 1,
      background: OPAQUE_WHITE,
    } as const satisfies EditOp
    const cropAll = {
      kind: 'crop',
      rect: fullFrame,
      zoom: 1,
      background: OPAQUE_WHITE,
    } as const satisfies EditOp

    expect(resolveEditedSize(SOURCE, [])).toEqual({ width: 4000, height: 3000 })
    expect(resolveEditedSize(SOURCE, [rotate])).toEqual({ width: 3000, height: 4000 })
    expect(resolveEditedSize(SOURCE, [rotate, rotate])).toEqual({ width: 4000, height: 3000 })
    expect(resolveEditedSize(SOURCE, [rotate, cropAll])).toEqual({ width: 3000, height: 4000 })
    expect(resolveEditedSize(SOURCE, [rotate, cropHalf])).toEqual({ width: 1500, height: 2000 })
    expect(resolveEditedSize(SOURCE, [cropHalf, rotate])).toEqual({ width: 1500, height: 2000 })
    expect(hasCropOp([rotate])).toBe(false)
    expect(hasCropOp([rotate, cropHalf])).toBe(true)
    expect(hasCropOp([])).toBe(false)
  })

  it('ignores the stored zoom when sizing an edit', () => {
    const rect = { x: 0, y: 0, width: 0.5, height: 0.5 }
    const slow = { kind: 'crop', rect, zoom: 0.25, background: OPAQUE_WHITE } as const
    const fast = { kind: 'crop', rect, zoom: 4, background: OPAQUE_WHITE } as const

    expect(resolveEditedSize(SOURCE, [slow])).toEqual(resolveEditedSize(SOURCE, [fast]))
  })

  it('treats a trailing recovery resize as a uniform post-crop size', () => {
    const crop = {
      kind: 'crop',
      rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      zoom: 1,
      background: OPAQUE_WHITE,
    } as const satisfies EditOp
    const edit = withTrailingResize({ ops: [crop], version: 4 }, { width: 800, height: 600 })

    expect(resolveEditedSize(SOURCE, edit.ops)).toEqual({ width: 800, height: 600 })
    expect(trailingResizeOp(edit.ops)).toEqual({ kind: 'resize', width: 800, height: 600 })
    expect(geometryEdit(edit)).toEqual({ ops: [crop], version: 5 })
    expect(edit.version).toBe(5)
  })

  it('replaces one trailing recovery resize and validates its dimensions', () => {
    const edit = withTrailingResize(
      { ops: [{ kind: 'resize', width: 800, height: 600 }], version: 1 },
      { width: 400, height: 300 },
    )

    expect(edit.ops).toEqual([{ kind: 'resize', width: 400, height: 300 }])
    expect(() => withTrailingResize(edit, { width: 0, height: 1 })).toThrow(RangeError)
    expect(() =>
      resolveEditedSize(SOURCE, [{ kind: 'resize', width: Number.NaN, height: 1 }]),
    ).toThrow(RangeError)
  })

  it('stores rotation before crop and omits an unturned rotation', () => {
    expect(editOpsFor(resolved(), 1, OPAQUE_WHITE).map((op) => op.kind)).toEqual(['crop'])
    expect(editOpsFor(resolved({ quarterTurns: 1 }), 1, OPAQUE_WHITE).map((op) => op.kind)).toEqual(
      ['rotate', 'crop'],
    )
  })

  it('predicts its own stored operations', () => {
    const geometry = resolved({ quarterTurns: 1, zoom: 0.5 })
    const ops = editOpsFor(geometry, 0.5, OPAQUE_WHITE)

    expect(resolveEditedSize(SOURCE, ops)).toEqual(geometry.output.size)
  })

  it.each([0, 1, 2, 3] as const satisfies readonly QuarterTurns[])(
    'omits a no-op crop for an untouched edit at %d quarter turns (R-D4)',
    (quarterTurns) => {
      // The production path, not a hand-built op list: `resolveCropInput` is what the editor calls
      // for a fresh entry or a rotation with no crop of its own, and `hasCropOp` is what
      // `resolveDimension` reads back to decide whether the batch dimension rule was overridden.
      const geometry = resolveCropGeometry(
        resolveCropInput({
          source: SOURCE,
          frame: FRAME,
          quarterTurns,
          ratio: { kind: 'free' },
          limits: DEFAULT_CROP_LIMITS,
        }),
      )

      if (geometry.kind !== 'resolved') {
        throw new Error(`expected resolved geometry, received ${geometry.reason}`)
      }

      const ops = editOpsFor(geometry, 1, OPAQUE_WHITE)

      expect(ops.map((op) => op.kind)).toEqual(quarterTurns === 0 ? [] : ['rotate'])
      expect(hasCropOp(ops)).toBe(false)
    },
  )

  it.each([
    ['empty-frame', input({ frame: { width: 0, height: 600 } })],
    ['empty-source', input({ source: { width: 4000, height: 0 } })],
    ['invalid-zoom', input({ zoom: 0 })],
    ['invalid-zoom', input({ zoom: -1 })],
    ['invalid-zoom', input({ zoom: Number.NaN })],
    ['invalid-zoom', input({ zoom: Number.POSITIVE_INFINITY })],
  ] as const)('refuses to resolve and reports %s', (reason, unresolvable) => {
    expect(resolveCropGeometry(unresolvable)).toEqual({ kind: 'unresolvable', reason })
  })

  it.each([
    [0, { width: 4000, height: 3000 }],
    [1, { width: 3000, height: 4000 }],
    [2, { width: 4000, height: 3000 }],
    [3, { width: 3000, height: 4000 }],
  ] as const satisfies readonly (readonly [QuarterTurns, PixelSize])[])(
    'swaps the axes on %d quarter turns',
    (quarterTurns, expected) => {
      expect(rotateSize(SOURCE, quarterTurns)).toEqual(expected)
    },
  )
})
