import { describe, expect, it } from 'vitest'
import { fitScale, imageRectInFrame, type PixelSize, type QuarterTurns } from './edit'
import {
  DEFAULT_VIEWPORT,
  MAX_VIEWPORT_SCALE,
  MIN_VIEWPORT_SCALE,
  clampViewportCenter,
  clampViewportScale,
  panViewport,
  projectViewportToCompressed,
  projectViewportToOriginal,
  resolveViewportFrameRect,
  rotatePointByQuarterTurns,
  rotateViewportBetweenQuarterTurns,
  unprojectViewportFromCompressed,
  unprojectViewportFromOriginal,
  viewportEditGeometry,
  viewportFractionAt,
  zoomViewportAt,
  type InspectorViewport,
  type ViewportPoint,
} from './viewport'
import type { EditOp, EditRecord, NormalisedRect, Rgba } from './types'

const LANDSCAPE = { width: 4000, height: 3000 } as const satisfies PixelSize
const PORTRAIT = { width: 3000, height: 4000 } as const satisfies PixelSize
const SQUARE = { width: 2048, height: 2048 } as const satisfies PixelSize
/** Matches LANDSCAPE's aspect exactly: the production case, where the frame is the contain-fit box. */
const FITTED_FRAME = { width: 800, height: 600 } as const satisfies PixelSize
/** Taller than the image's aspect, so the fit scale is set by width and the y axis has slack. */
const TALL_FRAME = { width: 800, height: 900 } as const satisfies PixelSize
const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

const QUARTER_TURNS = [0, 1, 2, 3] as const satisfies readonly QuarterTurns[]

function viewport(x: number, y: number, scale: number): InspectorViewport {
  return { center: { x, y }, scale }
}

function editRecord(ops: EditOp[]): EditRecord {
  return { ops, version: 1 }
}

function cropOp(rect: NormalisedRect): EditOp {
  return { kind: 'crop', rect, zoom: 1, background: OPAQUE_WHITE }
}

function expectPointCloseTo(actual: ViewportPoint, expected: ViewportPoint): void {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.y).toBeCloseTo(expected.y, 10)
}

describe('clampViewportScale', () => {
  it('holds the scale between fit-to-frame and the maximum', () => {
    expect(clampViewportScale(0.25)).toBe(MIN_VIEWPORT_SCALE)
    expect(clampViewportScale(1)).toBe(1)
    expect(clampViewportScale(3.5)).toBe(3.5)
    expect(clampViewportScale(MAX_VIEWPORT_SCALE + 10)).toBe(MAX_VIEWPORT_SCALE)
  })

  it('resolves any non-finite scale to fit-to-frame, including an infinite one', () => {
    // An infinite scale is a broken computation rather than a very enthusiastic gesture, so it
    // resets to the state the user can always understand instead of snapping to maximum zoom.
    expect(clampViewportScale(Number.NaN)).toBe(MIN_VIEWPORT_SCALE)
    expect(clampViewportScale(Number.POSITIVE_INFINITY)).toBe(MIN_VIEWPORT_SCALE)
    expect(clampViewportScale(Number.NEGATIVE_INFINITY)).toBe(MIN_VIEWPORT_SCALE)
  })
})

describe('clampViewportCenter', () => {
  it('collapses any centre to the middle at scale 1, on both axes and both frame shapes', () => {
    for (const frame of [FITTED_FRAME, TALL_FRAME]) {
      expectPointCloseTo(clampViewportCenter({ x: 0, y: 1 }, LANDSCAPE, frame, 1), {
        x: 0.5,
        y: 0.5,
      })
      expectPointCloseTo(clampViewportCenter({ x: 0.9, y: 0.1 }, LANDSCAPE, frame, 1), {
        x: 0.5,
        y: 0.5,
      })
    }
  })

  it('allows half a visible frame of travel from each edge at scale 2', () => {
    // Frame aspect matches the image, so both axes show 1/2 of the image at scale 2: [0.25, 0.75].
    expectPointCloseTo(clampViewportCenter({ x: 0, y: 1 }, LANDSCAPE, FITTED_FRAME, 2), {
      x: 0.25,
      y: 0.75,
    })
    expectPointCloseTo(clampViewportCenter({ x: 0.3, y: 0.7 }, LANDSCAPE, FITTED_FRAME, 2), {
      x: 0.3,
      y: 0.7,
    })
  })

  it('clamps each axis by its own visible fraction, not by one shared bound', () => {
    // TALL_FRAME: fitScale is set by width (800/4000 = 0.2), so the drawn image is 800x600 inside a
    // 800x900 frame. At scale 2 the frame shows 1/2 of the width but 900/1200 = 3/4 of the height.
    const clamped = clampViewportCenter({ x: 0, y: 0 }, LANDSCAPE, TALL_FRAME, 2)

    expect(clamped.x).toBeCloseTo(0.25, 10)
    expect(clamped.y).toBeCloseTo(0.375, 10)
  })

  it('returns the middle for a frame or image that has not been measured', () => {
    expectPointCloseTo(
      clampViewportCenter({ x: 0.2, y: 0.2 }, LANDSCAPE, { width: 0, height: 0 }, 2),
      {
        x: 0.5,
        y: 0.5,
      },
    )
    expectPointCloseTo(
      clampViewportCenter({ x: 0.2, y: 0.2 }, { width: 0, height: 10 }, FITTED_FRAME, 2),
      { x: 0.5, y: 0.5 },
    )
  })
})

describe('resolveViewportFrameRect', () => {
  it('is exactly plain contain-fit at the default viewport (R-P6)', () => {
    for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
      for (const frame of [FITTED_FRAME, TALL_FRAME, { width: 1000, height: 300 }]) {
        expect(resolveViewportFrameRect(natural, frame, DEFAULT_VIEWPORT)).toEqual(
          imageRectInFrame(natural, frame, fitScale(natural, frame)),
        )
      }
    }
  })

  it('preserves the image aspect ratio at every scale, so the image is never stretched (R-P6)', () => {
    for (const scale of [1, 1.5, 3, MAX_VIEWPORT_SCALE]) {
      const rect = resolveViewportFrameRect(PORTRAIT, TALL_FRAME, viewport(0.5, 0.5, scale))

      expect(rect).not.toBeNull()
      expect(rect!.width / rect!.height).toBeCloseTo(PORTRAIT.width / PORTRAIT.height, 10)
    }
  })

  it('puts the viewport centre at the middle of the frame', () => {
    const inspector = viewport(0.3, 0.6, 4)
    const rect = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, inspector)

    expect(rect).not.toBeNull()
    expect(rect!.left + inspector.center.x * rect!.width).toBeCloseTo(FITTED_FRAME.width / 2, 10)
    expect(rect!.top + inspector.center.y * rect!.height).toBeCloseTo(FITTED_FRAME.height / 2, 10)
  })

  it('scales the drawn size by exactly the viewport scale', () => {
    const atRest = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, DEFAULT_VIEWPORT)
    const zoomed = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, viewport(0.5, 0.5, 2.5))

    expect(zoomed!.width).toBeCloseTo(atRest!.width * 2.5, 10)
    expect(zoomed!.height).toBeCloseTo(atRest!.height * 2.5, 10)
  })

  it('never lets the frame see past the image edge, however far the centre is pushed', () => {
    const rect = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, viewport(-5, 9, 3))

    expect(rect).not.toBeNull()
    expect(rect!.left).toBeLessThanOrEqual(0)
    expect(rect!.top).toBeLessThanOrEqual(0)
    expect(rect!.left + rect!.width).toBeGreaterThanOrEqual(FITTED_FRAME.width)
    expect(rect!.top + rect!.height).toBeGreaterThanOrEqual(FITTED_FRAME.height)
  })

  it('is null for an unmeasured frame, an unmeasured image or a non-finite centre', () => {
    expect(
      resolveViewportFrameRect(LANDSCAPE, { width: 0, height: 0 }, DEFAULT_VIEWPORT),
    ).toBeNull()
    expect(
      resolveViewportFrameRect({ width: 0, height: 0 }, FITTED_FRAME, DEFAULT_VIEWPORT),
    ).toBeNull()
    expect(
      resolveViewportFrameRect(LANDSCAPE, { width: Number.NaN, height: 600 }, DEFAULT_VIEWPORT),
    ).toBeNull()
  })

  it('treats a non-finite centre as the middle rather than producing a NaN rectangle', () => {
    expect(resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, viewport(Number.NaN, 0.5, 2))).toEqual(
      resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, viewport(0.5, 0.5, 2)),
    )
  })
})

describe('viewportFractionAt', () => {
  it('reads the fraction of the drawn image under a frame point', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }

    expectPointCloseTo(viewportFractionAt(rect, { left: 100, top: 50 }), { x: 0, y: 0 })
    expectPointCloseTo(viewportFractionAt(rect, { left: 300, top: 150 }), { x: 0.5, y: 0.5 })
    expectPointCloseTo(viewportFractionAt(rect, { left: 500, top: 250 }), { x: 1, y: 1 })
  })

  it('clamps a point outside the drawn image to the image itself', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }

    expectPointCloseTo(viewportFractionAt(rect, { left: -400, top: 900 }), { x: 0, y: 1 })
  })
})

describe('zoomViewportAt', () => {
  it('keeps the content under the pointer under the pointer', () => {
    // A point left of and above centre, zoomed in twice: the clamp cannot bite at these scales for
    // this point, so the anchor must hold exactly.
    const point = { left: 300, top: 220 }
    const start = DEFAULT_VIEWPORT as InspectorViewport
    const before = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, start)!
    const fraction = viewportFractionAt(before, point)

    let current = start
    for (const scale of [1.4, 2]) {
      current = zoomViewportAt(LANDSCAPE, FITTED_FRAME, current, point, scale)
      const after = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, current)!

      expect(current.scale).toBe(scale)
      expectPointCloseTo(viewportFractionAt(after, point), fraction)
    }
  })

  it('keeps the anchor on a frame whose aspect differs from the image', () => {
    const point = { left: 500, top: 400 }
    const before = resolveViewportFrameRect(LANDSCAPE, TALL_FRAME, DEFAULT_VIEWPORT)!
    const fraction = viewportFractionAt(before, point)
    const zoomed = zoomViewportAt(LANDSCAPE, TALL_FRAME, DEFAULT_VIEWPORT, point, 3)
    const after = resolveViewportFrameRect(LANDSCAPE, TALL_FRAME, zoomed)!

    expectPointCloseTo(viewportFractionAt(after, point), fraction)
  })

  it('lets the edge clamp override the anchor on an axis that is still fully visible', () => {
    // LANDSCAPE in TALL_FRAME draws 800x600 inside 800x900. At scale 1.5 the height is exactly the
    // frame's, so there is nothing to pan vertically and the centre must stay at 0.5 whatever the
    // pointer asked for — the clamp is not allowed to lose to the anchor, or the frame would show
    // background above or below the image.
    const zoomed = zoomViewportAt(
      LANDSCAPE,
      TALL_FRAME,
      DEFAULT_VIEWPORT,
      { left: 700, top: 200 },
      1.5,
    )

    expect(zoomed.center.x).toBeCloseTo(0.625, 10)
    expect(zoomed.center.y).toBeCloseTo(0.5, 10)
  })

  it('clamps the scale and lands on the middle when the image is not measured yet', () => {
    const zoomed = zoomViewportAt(
      { width: 0, height: 0 },
      FITTED_FRAME,
      DEFAULT_VIEWPORT,
      { left: 10, top: 10 },
      40,
    )

    expect(zoomed.scale).toBe(MAX_VIEWPORT_SCALE)
    expectPointCloseTo(zoomed.center, { x: 0.5, y: 0.5 })
  })

  it('returns to the exact centre when zoomed back out to the fit point', () => {
    const zoomedIn = zoomViewportAt(
      LANDSCAPE,
      FITTED_FRAME,
      DEFAULT_VIEWPORT,
      { left: 120, top: 90 },
      5,
    )
    const backOut = zoomViewportAt(LANDSCAPE, FITTED_FRAME, zoomedIn, { left: 120, top: 90 }, 1)

    expect(backOut.scale).toBe(1)
    expectPointCloseTo(backOut.center, { x: 0.5, y: 0.5 })
  })
})

describe('panViewport', () => {
  it('moves the content with the pointer, one frame pixel per frame pixel', () => {
    const zoomed = viewport(0.5, 0.5, 4)
    const rect = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, zoomed)!
    const panned = panViewport(LANDSCAPE, FITTED_FRAME, zoomed, { left: 80, top: -40 })
    const after = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, panned)!

    expect(after.left - rect.left).toBeCloseTo(80, 10)
    expect(after.top - rect.top).toBeCloseTo(-40, 10)
  })

  it('stops at the image edge instead of dragging background into the frame', () => {
    const panned = panViewport(LANDSCAPE, FITTED_FRAME, viewport(0.5, 0.5, 2), {
      left: 10_000,
      top: 10_000,
    })
    const rect = resolveViewportFrameRect(LANDSCAPE, FITTED_FRAME, panned)!

    expect(rect.left).toBeCloseTo(0, 10)
    expect(rect.top).toBeCloseTo(0, 10)
    expectPointCloseTo(panned.center, { x: 0.25, y: 0.25 })
  })

  it('does nothing at the fit point, where the whole image is already visible', () => {
    const panned = panViewport(LANDSCAPE, FITTED_FRAME, DEFAULT_VIEWPORT, { left: 120, top: 60 })

    expect(panned.scale).toBe(1)
    expectPointCloseTo(panned.center, { x: 0.5, y: 0.5 })
  })
})

describe('rotatePointByQuarterTurns', () => {
  const POINT = { x: 0.25, y: 0.75 } as const satisfies ViewportPoint

  it('maps the unit square clockwise, matching the pipeline pixel rotation', () => {
    const expected = [
      { x: 0.25, y: 0.75 },
      { x: 0.25, y: 0.25 },
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
    ] as const satisfies readonly ViewportPoint[]

    for (const turns of QUARTER_TURNS) {
      expectPointCloseTo(rotatePointByQuarterTurns(POINT, turns), expected[turns])
    }
  })

  it('sends the top-left corner clockwise around the square', () => {
    const corners = QUARTER_TURNS.map((turns) => rotatePointByQuarterTurns({ x: 0, y: 0 }, turns))

    expect(corners).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ])
  })

  it('returns to where it started after four quarter turns, from every point', () => {
    for (const point of [POINT, { x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }]) {
      for (const turns of QUARTER_TURNS) {
        const there = rotatePointByQuarterTurns(point, turns)
        const back = rotatePointByQuarterTurns(
          there,
          QUARTER_TURNS[(4 - turns) % 4] as QuarterTurns,
        )

        expectPointCloseTo(back, point)
      }
    }
  })
})

describe('projectViewportToOriginal', () => {
  it('is the identity when nothing is rotated', () => {
    const inspector = viewport(0.3, 0.8, 2)

    expect(projectViewportToOriginal(inspector, 0)).toEqual(inspector)
  })

  it('undoes the edit rotation, so the canonical point lands on the same source pixel', () => {
    // One clockwise turn maps a source point (sx, sy) to (1 - sy, sx). So a canonical point of
    // (0.25, 0.75) came from the source point where 1 - sy = 0.25 and sx = 0.75: (0.75, 0.75).
    expectPointCloseTo(projectViewportToOriginal(viewport(0.25, 0.75, 3), 1).center, {
      x: 0.75,
      y: 0.75,
    })
    // And the source's top-left corner is the rotated image's top-right, so looking at the rotated
    // top-right means looking at the source's top-left.
    expectPointCloseTo(projectViewportToOriginal(viewport(1, 0, 2), 1).center, { x: 0, y: 0 })
  })

  it('round-trips through the canonical space for every quarter turn', () => {
    const local = viewport(0.3, 0.8, 2.5)

    for (const turns of QUARTER_TURNS) {
      const canonical = unprojectViewportFromOriginal(local, turns)
      const back = projectViewportToOriginal(canonical, turns)

      expectPointCloseTo(back.center, local.center)
      expect(back.scale).toBe(local.scale)
    }
  })

  it('carries the scale through untouched, so both tabs show the image at the same size', () => {
    expect(projectViewportToOriginal(viewport(0.1, 0.2, 3.75), 3).scale).toBe(3.75)
  })
})

describe('rotateViewportBetweenQuarterTurns', () => {
  it('keeps the same source patch in view when the stored rotation changes', () => {
    // A source point, expressed in a canonical space of 0 turns and then of 1 turn.
    const source = { x: 0.2, y: 0.9 }
    const atZero: InspectorViewport = { center: source, scale: 3 }
    const atOne = rotateViewportBetweenQuarterTurns(atZero, 0, 1)

    expectPointCloseTo(atOne.center, rotatePointByQuarterTurns(source, 1))
    expect(atOne.scale).toBe(3)
  })

  it('agrees with re-deriving the point from the source for every pair of rotations', () => {
    const source = { x: 0.2, y: 0.9 }

    for (const from of QUARTER_TURNS) {
      for (const to of QUARTER_TURNS) {
        const moved = rotateViewportBetweenQuarterTurns(
          { center: rotatePointByQuarterTurns(source, from), scale: 2 },
          from,
          to,
        )

        expectPointCloseTo(moved.center, rotatePointByQuarterTurns(source, to))
      }
    }
  })
})

describe('projectViewportToCompressed', () => {
  const RIGHT_HALF = { x: 0.5, y: 0, width: 0.5, height: 1 } as const satisfies NormalisedRect
  /** A crop zoomed out past the fit point: the output contains background on all four sides (R-C9). */
  const SPILLING = { x: -0.5, y: -0.5, width: 2, height: 2 } as const satisfies NormalisedRect

  it('is the identity when no crop is stored', () => {
    const inspector = viewport(0.4, 0.6, 3)

    expect(projectViewportToCompressed(inspector, null)).toEqual(inspector)
  })

  it('expresses the canonical point as a fraction of the crop rect', () => {
    expectPointCloseTo(projectViewportToCompressed(viewport(0.75, 0.25, 2), RIGHT_HALF).center, {
      x: 0.5,
      y: 0.25,
    })
  })

  it('reaches the far edge of a cropped output, which a coarse canonical bound would have clamped', () => {
    expectPointCloseTo(projectViewportToCompressed(viewport(1, 0.5, 2), RIGHT_HALF).center, {
      x: 1,
      y: 0.5,
    })
  })

  it('clamps a canonical point outside the crop to the nearest edge rather than resetting', () => {
    expectPointCloseTo(projectViewportToCompressed(viewport(0.1, 0.5, 4), RIGHT_HALF).center, {
      x: 0,
      y: 0.5,
    })
  })

  it('maps the whole source into the middle of an output that spills on every side', () => {
    expectPointCloseTo(projectViewportToCompressed(viewport(0.5, 0.5, 2), SPILLING).center, {
      x: 0.5,
      y: 0.5,
    })
    expectPointCloseTo(projectViewportToCompressed(viewport(0, 1, 2), SPILLING).center, {
      x: 0.25,
      y: 0.75,
    })
  })

  it('round-trips through the canonical space, including outside the unit square', () => {
    for (const rect of [RIGHT_HALF, SPILLING, null]) {
      for (const local of [viewport(0, 0, 2), viewport(0.5, 0.5, 2), viewport(1, 1, 2)]) {
        const canonical = unprojectViewportFromCompressed(local, rect)
        const back = projectViewportToCompressed(canonical, rect)

        expectPointCloseTo(back.center, local.center)
        expect(back.scale).toBe(local.scale)
      }
    }
  })

  it('leaves the viewport alone for a degenerate crop rect', () => {
    const inspector = viewport(0.4, 0.6, 2)
    const empty = { x: 0.2, y: 0.2, width: 0, height: 0 } satisfies NormalisedRect

    expect(projectViewportToCompressed(inspector, empty)).toEqual(inspector)
    expect(unprojectViewportFromCompressed(inspector, empty)).toEqual(inspector)
  })
})

describe('projection between the two tabs', () => {
  const CROP = { x: 0.5, y: 0, width: 0.5, height: 1 } as const satisfies NormalisedRect

  it('is lossless over a there-and-back tab flip, even when the other tab clamps', () => {
    // Looking at the left edge of the source, which a right-half crop cannot show at all. The
    // compressed tab clamps to its own left edge; the canonical value it was projected from is
    // untouched by that clamp, so flipping back lands exactly where the user was.
    const canonical = viewport(0.05, 0.5, 4)

    expectPointCloseTo(projectViewportToCompressed(canonical, CROP).center, { x: 0, y: 0.5 })
    expectPointCloseTo(projectViewportToOriginal(canonical, 0).center, { x: 0.05, y: 0.5 })
  })

  it('composes a rotation and a crop in the right order', () => {
    // The user is looking at the left edge, vertical middle, of the *source* on the Original tab,
    // with one clockwise turn stored. That patch is the top edge, horizontal middle, of the rotated
    // source — which is exactly where a right-half crop of the rotated source begins.
    const canonical = unprojectViewportFromOriginal(viewport(0.05, 0.5, 4), 1)

    expectPointCloseTo(canonical.center, { x: 0.5, y: 0.05 })
    expectPointCloseTo(projectViewportToCompressed(canonical, CROP).center, { x: 0, y: 0.05 })
    expectPointCloseTo(projectViewportToOriginal(canonical, 1).center, { x: 0.05, y: 0.5 })
  })
})

describe('viewportEditGeometry', () => {
  it('reports no rotation and no crop for an image with no edit', () => {
    expect(viewportEditGeometry(null)).toEqual({
      kind: 'projectable',
      quarterTurns: 0,
      cropRect: null,
    })
  })

  it('reads a rotation-only edit', () => {
    expect(viewportEditGeometry(editRecord([{ kind: 'rotate', quarterTurns: 3 }]))).toEqual({
      kind: 'projectable',
      quarterTurns: 3,
      cropRect: null,
    })
  })

  it('composes several rotations, wrapping at a full revolution', () => {
    expect(
      viewportEditGeometry(
        editRecord([
          { kind: 'rotate', quarterTurns: 3 },
          { kind: 'rotate', quarterTurns: 2 },
        ]),
      ),
    ).toEqual({ kind: 'projectable', quarterTurns: 1, cropRect: null })
  })

  it('reads the rotation and crop of the op order editOpsFor produces', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } satisfies NormalisedRect

    expect(
      viewportEditGeometry(editRecord([{ kind: 'rotate', quarterTurns: 1 }, cropOp(rect)])),
    ).toEqual({ kind: 'projectable', quarterTurns: 1, cropRect: rect })
  })

  it('ignores a single trailing recovery resize because it does not change crop coordinates', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } satisfies NormalisedRect

    expect(
      viewportEditGeometry(editRecord([cropOp(rect), { kind: 'resize', width: 500, height: 500 }])),
    ).toEqual({ kind: 'projectable', quarterTurns: 0, cropRect: rect })
    expect(
      viewportEditGeometry(
        editRecord([
          { kind: 'resize', width: 500, height: 500 },
          { kind: 'rotate', quarterTurns: 1 },
        ]),
      ),
    ).toEqual({ kind: 'unprojectable', reason: 'resize-before-final-operation' })
  })

  it('refuses an op order it cannot summarise rather than mis-projecting it', () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } satisfies NormalisedRect

    expect(
      viewportEditGeometry(editRecord([cropOp(rect), { kind: 'rotate', quarterTurns: 1 }])),
    ).toEqual({ kind: 'unprojectable', reason: 'rotate-after-crop' })
    expect(viewportEditGeometry(editRecord([cropOp(rect), cropOp(rect)]))).toEqual({
      kind: 'unprojectable',
      reason: 'multiple-crops',
    })
  })
})
