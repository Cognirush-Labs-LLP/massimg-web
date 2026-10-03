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
  resolveViewportBox,
  resolveViewportFrameRect,
  restBoxSize,
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
/** Matches LANDSCAPE's aspect exactly: the production case, where the host is the contain-fit box. */
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

/**
 * Re-expresses a fixed host-relative pointer position in a box's own frame — the same conversion a
 * real caller does every tick, since the box (`resolveViewportBox`) is centred in the host and
 * shifts underneath a pointer that has not actually moved whenever it resizes between calls. Needed
 * whenever a test's box can change size across the calls it is checking (an aspect mismatch between
 * the image and the host); not needed when the box is fixed (aspect matches, box never grows).
 */
function pointInBox(
  hostPoint: { left: number; top: number },
  box: PixelSize,
  host: PixelSize,
): { left: number; top: number } {
  return {
    left: hostPoint.left - (host.width - box.width) / 2,
    top: hostPoint.top - (host.height - box.height) / 2,
  }
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

describe('restBoxSize', () => {
  it('returns the image unchanged when it is already smaller than the host on both axes', () => {
    const natural = { width: 400, height: 300 } satisfies PixelSize
    const host = { width: 1200, height: 900 } satisfies PixelSize

    expect(restBoxSize(natural, host)).toEqual(natural)
  })

  it('downscales to fit when the image is bigger than the host, matching fitScale', () => {
    const scale = fitScale(LANDSCAPE, TALL_FRAME)

    expect(restBoxSize(LANDSCAPE, TALL_FRAME)).toEqual({
      width: LANDSCAPE.width * scale,
      height: LANDSCAPE.height * scale,
    })
  })

  it('returns a zero size for an unmeasured image or host', () => {
    expect(restBoxSize({ width: 0, height: 0 }, FITTED_FRAME)).toEqual({ width: 0, height: 0 })
    expect(restBoxSize(LANDSCAPE, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })
})

describe('resolveViewportBox', () => {
  // restBoxSize(LANDSCAPE, TALL_FRAME) is {800, 600}; TALL_FRAME is {800, 900} — width already
  // matches the host so it saturates immediately, height only once scale exceeds 900 / 600 = 1.5.
  const restBox = restBoxSize(LANDSCAPE, TALL_FRAME)

  it('is exactly the rest box at scale 1', () => {
    expect(resolveViewportBox(restBox, TALL_FRAME, 1)).toEqual(restBox)
  })

  it('saturates each axis independently, at the scale where that axis first exceeds the host', () => {
    const box = resolveViewportBox(restBox, TALL_FRAME, 1.2)

    expect(box.width).toBeCloseTo(TALL_FRAME.width, 10)
    expect(box.height).toBeCloseTo(restBox.height * 1.2, 10)
  })

  it('never exceeds the host, even at the maximum scale', () => {
    const box = resolveViewportBox(restBox, TALL_FRAME, MAX_VIEWPORT_SCALE)

    expect(box.width).toBeLessThanOrEqual(TALL_FRAME.width)
    expect(box.height).toBeLessThanOrEqual(TALL_FRAME.height)
    expect(box.width).toBeCloseTo(TALL_FRAME.width, 10)
    expect(box.height).toBeCloseTo(TALL_FRAME.height, 10)
  })

  it('returns a zero size for an unmeasured rest box, host, or non-finite scale', () => {
    expect(resolveViewportBox({ width: 0, height: 0 }, TALL_FRAME, 2)).toEqual({
      width: 0,
      height: 0,
    })
    expect(resolveViewportBox(restBox, { width: 0, height: 0 }, 2)).toEqual({
      width: 0,
      height: 0,
    })
    expect(resolveViewportBox(restBox, TALL_FRAME, Number.NaN)).toEqual({ width: 0, height: 0 })
  })
})

describe('clampViewportCenter', () => {
  it('collapses any centre to the middle at scale 1, on both axes and both frame shapes', () => {
    for (const frame of [FITTED_FRAME, TALL_FRAME]) {
      const restBox = restBoxSize(LANDSCAPE, frame)

      expectPointCloseTo(clampViewportCenter({ x: 0, y: 1 }, restBox, frame, 1), {
        x: 0.5,
        y: 0.5,
      })
      expectPointCloseTo(clampViewportCenter({ x: 0.9, y: 0.1 }, restBox, frame, 1), {
        x: 0.5,
        y: 0.5,
      })
    }
  })

  it('allows half a visible frame of travel from each edge at scale 2', () => {
    // Frame aspect matches the image, so both axes show 1/2 of the image at scale 2: [0.25, 0.75].
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)

    expectPointCloseTo(clampViewportCenter({ x: 0, y: 1 }, restBox, FITTED_FRAME, 2), {
      x: 0.25,
      y: 0.75,
    })
    expectPointCloseTo(clampViewportCenter({ x: 0.3, y: 0.7 }, restBox, FITTED_FRAME, 2), {
      x: 0.3,
      y: 0.7,
    })
  })

  it('clamps each axis by its own visible fraction, not by one shared bound', () => {
    // TALL_FRAME: restBox is {800, 600} (fitScale is set by width), inside an 800x900 host. At
    // scale 2 the host shows 1/2 of the width but 900/1200 = 3/4 of the height.
    const restBox = restBoxSize(LANDSCAPE, TALL_FRAME)
    const clamped = clampViewportCenter({ x: 0, y: 0 }, restBox, TALL_FRAME, 2)

    expect(clamped.x).toBeCloseTo(0.25, 10)
    expect(clamped.y).toBeCloseTo(0.375, 10)
  })

  it('returns the middle for a rest box or host that has not been measured', () => {
    expectPointCloseTo(
      clampViewportCenter(
        { x: 0.2, y: 0.2 },
        restBoxSize(LANDSCAPE, { width: 0, height: 0 }),
        { width: 0, height: 0 },
        2,
      ),
      { x: 0.5, y: 0.5 },
    )
    expectPointCloseTo(
      clampViewportCenter(
        { x: 0.2, y: 0.2 },
        restBoxSize({ width: 0, height: 10 }, FITTED_FRAME),
        FITTED_FRAME,
        2,
      ),
      { x: 0.5, y: 0.5 },
    )
  })
})

describe('resolveViewportFrameRect', () => {
  it('is exactly the rest box at the default viewport, filling it with no padding (R-P6)', () => {
    for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
      for (const host of [FITTED_FRAME, TALL_FRAME, { width: 1000, height: 300 }]) {
        const restBox = restBoxSize(natural, host)

        expect(resolveViewportFrameRect(restBox, host, DEFAULT_VIEWPORT)).toEqual(
          imageRectInFrame(restBox, restBox, 1),
        )
      }
    }
  })

  it('caps the rest-state rect at the image size, never upscaling to fill a larger host', () => {
    // A small image in a big host: restBoxSize caps at the image's own size, so the box never
    // grows past it and the rect is drawn at its true 100% size rather than blown up to fill host.
    const natural = { width: 400, height: 300 } satisfies PixelSize
    const host = { width: 1600, height: 1200 } satisfies PixelSize
    const restBox = restBoxSize(natural, host)
    const rect = resolveViewportFrameRect(restBox, host, DEFAULT_VIEWPORT)

    expect(rect).toEqual({ left: 0, top: 0, width: natural.width, height: natural.height })
  })

  it('preserves the image aspect ratio at every scale, so the image is never stretched (R-P6)', () => {
    const restBox = restBoxSize(PORTRAIT, TALL_FRAME)

    for (const scale of [1, 1.5, 3, MAX_VIEWPORT_SCALE]) {
      const rect = resolveViewportFrameRect(restBox, TALL_FRAME, viewport(0.5, 0.5, scale))

      expect(rect).not.toBeNull()
      expect(rect!.width / rect!.height).toBeCloseTo(PORTRAIT.width / PORTRAIT.height, 10)
    }
  })

  it('puts the viewport centre at the middle of the frame', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const inspector = viewport(0.3, 0.6, 4)
    const rect = resolveViewportFrameRect(restBox, FITTED_FRAME, inspector)

    expect(rect).not.toBeNull()
    expect(rect!.left + inspector.center.x * rect!.width).toBeCloseTo(FITTED_FRAME.width / 2, 10)
    expect(rect!.top + inspector.center.y * rect!.height).toBeCloseTo(FITTED_FRAME.height / 2, 10)
  })

  it('scales the drawn size by exactly the viewport scale', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const atRest = resolveViewportFrameRect(restBox, FITTED_FRAME, DEFAULT_VIEWPORT)
    const zoomed = resolveViewportFrameRect(restBox, FITTED_FRAME, viewport(0.5, 0.5, 2.5))

    expect(zoomed!.width).toBeCloseTo(atRest!.width * 2.5, 10)
    expect(zoomed!.height).toBeCloseTo(atRest!.height * 2.5, 10)
  })

  it('never lets the frame see past the image edge, however far the centre is pushed', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const rect = resolveViewportFrameRect(restBox, FITTED_FRAME, viewport(-5, 9, 3))

    expect(rect).not.toBeNull()
    // restBoxSize round-trips natural through a division and a multiplication by fitScale, so the
    // edge lands within floating-point epsilon of 0 rather than exactly on it.
    expect(rect!.left).toBeLessThan(1e-9)
    expect(rect!.top).toBeLessThan(1e-9)
    expect(rect!.left + rect!.width).toBeGreaterThan(FITTED_FRAME.width - 1e-9)
    expect(rect!.top + rect!.height).toBeGreaterThan(FITTED_FRAME.height - 1e-9)
  })

  it('is null for an unmeasured frame, an unmeasured image or a non-finite centre', () => {
    expect(
      resolveViewportFrameRect(
        restBoxSize(LANDSCAPE, { width: 0, height: 0 }),
        { width: 0, height: 0 },
        DEFAULT_VIEWPORT,
      ),
    ).toBeNull()
    expect(
      resolveViewportFrameRect(
        restBoxSize({ width: 0, height: 0 }, FITTED_FRAME),
        FITTED_FRAME,
        DEFAULT_VIEWPORT,
      ),
    ).toBeNull()
    expect(
      resolveViewportFrameRect(
        restBoxSize(LANDSCAPE, { width: Number.NaN, height: 600 }),
        { width: Number.NaN, height: 600 },
        DEFAULT_VIEWPORT,
      ),
    ).toBeNull()
  })

  it('treats a non-finite centre as the middle rather than producing a NaN rectangle', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)

    expect(
      resolveViewportFrameRect(restBox, FITTED_FRAME, viewport(Number.NaN, 0.5, 2)),
    ).toEqual(resolveViewportFrameRect(restBox, FITTED_FRAME, viewport(0.5, 0.5, 2)))
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
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const point = { left: 300, top: 220 }
    const start = DEFAULT_VIEWPORT as InspectorViewport
    const before = resolveViewportFrameRect(restBox, FITTED_FRAME, start)!
    const fraction = viewportFractionAt(before, point)

    let current = start
    for (const scale of [1.4, 2]) {
      current = zoomViewportAt(restBox, FITTED_FRAME, current, point, scale)
      const after = resolveViewportFrameRect(restBox, FITTED_FRAME, current)!

      expect(current.scale).toBe(scale)
      expectPointCloseTo(viewportFractionAt(after, point), fraction)
    }
  })

  it('keeps the anchor on a frame whose aspect differs from the image', () => {
    // The pointer is a fixed position in the host (TALL_FRAME). The box it is measured against is
    // restBox {800, 600} at scale 1 but host {800, 900} at scale 3 — it grows between the two calls
    // this test makes, so the point has to be re-expressed in each box's own frame via `pointInBox`,
    // exactly as `zoomViewportAt`'s internal `adjustedPoint` correction does for the viewport it
    // owns. Reusing one raw box-relative point across both would silently test the wrong thing.
    const restBox = restBoxSize(LANDSCAPE, TALL_FRAME)
    const hostPoint = { left: 500, top: 400 }
    const startBox = resolveViewportBox(restBox, TALL_FRAME, DEFAULT_VIEWPORT.scale)
    const point = pointInBox(hostPoint, startBox, TALL_FRAME)
    const before = resolveViewportFrameRect(restBox, TALL_FRAME, DEFAULT_VIEWPORT)!
    const fraction = viewportFractionAt(before, point)

    const zoomed = zoomViewportAt(restBox, TALL_FRAME, DEFAULT_VIEWPORT, point, 3)
    const after = resolveViewportFrameRect(restBox, TALL_FRAME, zoomed)!
    const nextBox = resolveViewportBox(restBox, TALL_FRAME, zoomed.scale)
    const afterPoint = pointInBox(hostPoint, nextBox, TALL_FRAME)

    expectPointCloseTo(viewportFractionAt(after, afterPoint), fraction)
  })

  it('keeps the content under the pointer through a zoom that crosses an axis saturation point', () => {
    // restBoxSize(LANDSCAPE, TALL_FRAME) is {800, 600}; TALL_FRAME is {800, 900}. The width axis
    // is saturated immediately (restBox.width already equals TALL_FRAME.width); the height axis
    // only saturates once scale exceeds 900 / 600 = 1.5.
    //
    // Below 1.5 the whole image height is already visible (visibleFraction's "capped at the whole
    // image" case), so there is nothing to pan vertically and clampViewportCenter *correctly*
    // forces centre.y to 0.5 regardless of the pointer — the anchor cannot hold there, by design,
    // the same way the single-step test below demonstrates at the boundary. So this steps from
    // DEFAULT_VIEWPORT straight across 1.5 in its first jump (exercising the box-growth correction
    // across exactly the saturation point, like the "aspect differs" test above) and then takes
    // several further steps once the axis has genuine pan freedom, checking at each one that the
    // anchor established by that first jump keeps holding rather than drifting on a later step.
    //
    // The pointer sits at a fixed position in the host; since the box resizes at every step, that
    // position has to be re-converted into the box's own frame before each call, exactly as a real
    // caller tracking a stationary mouse through a sequence of wheel ticks would (see `pointInBox`).
    const restBox = restBoxSize(LANDSCAPE, TALL_FRAME)
    const hostPoint = { left: 550, top: 500 }
    const start = DEFAULT_VIEWPORT as InspectorViewport
    const startBox = resolveViewportBox(restBox, TALL_FRAME, start.scale)
    const before = resolveViewportFrameRect(restBox, TALL_FRAME, start)!
    const fraction = viewportFractionAt(before, pointInBox(hostPoint, startBox, TALL_FRAME))

    let current = start
    for (const scale of [1.6, 1.8, 2.2, 2.6, 3]) {
      const currentBox = resolveViewportBox(restBox, TALL_FRAME, current.scale)
      const point = pointInBox(hostPoint, currentBox, TALL_FRAME)
      current = zoomViewportAt(restBox, TALL_FRAME, current, point, scale)

      const nextBox = resolveViewportBox(restBox, TALL_FRAME, current.scale)
      const afterPoint = pointInBox(hostPoint, nextBox, TALL_FRAME)
      const after = resolveViewportFrameRect(restBox, TALL_FRAME, current)!

      expect(current.scale).toBe(scale)
      expectPointCloseTo(viewportFractionAt(after, afterPoint), fraction)
    }
  })

  it('lets the edge clamp override the anchor on an axis that is still fully visible', () => {
    // LANDSCAPE in TALL_FRAME has a rest box of 800x600 inside an 800x900 host. At scale 1.5 the
    // grown box's height is exactly the host's, so there is nothing to pan vertically and the
    // centre must stay at 0.5 whatever the pointer asked for — the clamp is not allowed to lose to
    // the anchor, or the frame would show background above or below the image.
    const restBox = restBoxSize(LANDSCAPE, TALL_FRAME)
    const zoomed = zoomViewportAt(restBox, TALL_FRAME, DEFAULT_VIEWPORT, { left: 700, top: 200 }, 1.5)

    expect(zoomed.center.x).toBeCloseTo(0.625, 10)
    expect(zoomed.center.y).toBeCloseTo(0.5, 10)
  })

  it('clamps the scale and lands on the middle when the image is not measured yet', () => {
    const zoomed = zoomViewportAt(
      restBoxSize({ width: 0, height: 0 }, FITTED_FRAME),
      FITTED_FRAME,
      DEFAULT_VIEWPORT,
      { left: 10, top: 10 },
      40,
    )

    expect(zoomed.scale).toBe(MAX_VIEWPORT_SCALE)
    expectPointCloseTo(zoomed.center, { x: 0.5, y: 0.5 })
  })

  it('returns to the exact centre when zoomed back out to the fit point', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const zoomedIn = zoomViewportAt(restBox, FITTED_FRAME, DEFAULT_VIEWPORT, { left: 120, top: 90 }, 5)
    const backOut = zoomViewportAt(restBox, FITTED_FRAME, zoomedIn, { left: 120, top: 90 }, 1)

    expect(backOut.scale).toBe(1)
    expectPointCloseTo(backOut.center, { x: 0.5, y: 0.5 })
  })
})

describe('panViewport', () => {
  it('moves the content with the pointer, one frame pixel per frame pixel', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const zoomed = viewport(0.5, 0.5, 4)
    const rect = resolveViewportFrameRect(restBox, FITTED_FRAME, zoomed)!
    const panned = panViewport(restBox, FITTED_FRAME, zoomed, { left: 80, top: -40 })
    const after = resolveViewportFrameRect(restBox, FITTED_FRAME, panned)!

    expect(after.left - rect.left).toBeCloseTo(80, 10)
    expect(after.top - rect.top).toBeCloseTo(-40, 10)
  })

  it('stops at the image edge instead of dragging background into the frame', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const panned = panViewport(restBox, FITTED_FRAME, viewport(0.5, 0.5, 2), {
      left: 10_000,
      top: 10_000,
    })
    const rect = resolveViewportFrameRect(restBox, FITTED_FRAME, panned)!

    expect(rect.left).toBeCloseTo(0, 10)
    expect(rect.top).toBeCloseTo(0, 10)
    expectPointCloseTo(panned.center, { x: 0.25, y: 0.25 })
  })

  it('does nothing at the fit point, where the whole image is already visible', () => {
    const restBox = restBoxSize(LANDSCAPE, FITTED_FRAME)
    const panned = panViewport(restBox, FITTED_FRAME, DEFAULT_VIEWPORT, { left: 120, top: 60 })

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
