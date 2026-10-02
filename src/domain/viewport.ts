// The Preview inspector's viewport: where the user is looking, and how closely (T36).
//
// Functional Design R-P1-R-P8 describe a whole-image, contain-fit frame and a tab that flips between
// Original and Compressed. The inspector adds zoom and pan on top of that, and the one thing it has
// to get right is that flipping tabs keeps the same *patch of the image* in view even though the two
// tabs are different rasters: the compressed one may be resized (R-N1), and once T37 ships, cropped
// and rotated (R-C2, R-D1). So the viewport is not stored per tab. It is stored once, in one
// canonical space, and projected into each tab's own space for rendering.
//
// **The canonical space is fractions of the rotated, uncropped source** — the same reference frame a
// stored crop `rect` already uses (`resolveCropGeometry`'s `normalisedRect` in `domain/edit.ts`), so
// no third coordinate system is introduced. From there:
//
//   Original tab    the source as the browser draws it: EXIF-oriented (R-I9) but *not* user-rotated,
//                   never cropped. Reached by the inverse of the edit's quarter turns.
//   Compressed tab  the encoded output: rotated, cropped, resized. Reached by mapping through the
//                   crop rect. Resizing is a uniform scale, so it leaves fractions untouched and
//                   does not appear in the arithmetic at all.
//
// Two rules keep the two tabs honest, and both are asserted in `viewport.spec.ts`:
//
//   - **Rendering clamps; writing does not.** `resolveViewportFrameRect` clamps the centre it is
//     given to what that tab can actually show, so neither tab can ever reveal anything outside its
//     own image. The canonical value keeps whatever the user's gesture produced, so flipping to a
//     tab that clamps and back again returns exactly where you were.
//   - **The clamp is exact and per-axis, not a coarse aspect-agnostic bound.** A coarse bound in
//     canonical space would be wrong the moment a crop exists: for a crop of the right half
//     (`x: 0.5, width: 0.5`), the right-hand side of the compressed image sits at canonical x > 0.75,
//     which an aspect-agnostic `[1/2s, 1 - 1/2s]` bound would clamp away. Under spill
//     (`rect.x < 0`), canonical values legitimately leave `[0, 1]` altogether.
//
// Scale passes through both projections unchanged: scale 1 means "this tab's whole image fits the
// frame" on both tabs, which is what makes the comparison a comparison — a 500x500 output of a
// 1000x1000 source is shown at the same size as its original, not at half of it.
//
// Pure, like every other module in `domain/`: no DOM, no Vue. Every value returned is a fresh object
// and nothing here mutates its arguments, which is what lets a caller hold the canonical viewport in
// a `ref` and only ever replace it.

import { addQuarterTurns, fitScale, imageRectInFrame } from './edit'
import type { FrameRect, PixelSize, QuarterTurns } from './edit'
import type { EditRecord, NormalisedRect } from './types'

/** A point in fractions of an image's own width and height. Never frame pixels. */
export interface ViewportPoint {
  x: number
  y: number
}

/**
 * A point in frame pixels — a pointer position, usually. Named after `FrameRect`'s origin rather
 * than `x`/`y` for the reason `domain/edit.ts` gives for `FrameRect` itself: the two coordinate
 * spaces must not be assignable to each other in either direction.
 */
export interface FramePoint {
  left: number
  top: number
}

/** Where the user is looking (centre) and how closely (scale), in the canonical space. */
export interface InspectorViewport {
  center: ViewportPoint
  scale: number
}

/**
 * Fit to frame, centred — the state R-P6 describes, and the one every image starts in.
 *
 * Deeply readonly so it cannot be mutated in place by a caller that holds it. Callers replace the
 * viewport they hold; they never mutate one.
 */
export const DEFAULT_VIEWPORT = {
  center: { x: 0.5, y: 0.5 },
  scale: 1,
} as const satisfies InspectorViewport

/** Scale 1 is fit-to-frame. Zooming out past it would shrink the image inside its own frame. */
export const MIN_VIEWPORT_SCALE = 1

/**
 * No design document gives a maximum zoom. 8x is a placeholder: enough to inspect JPEG blocking at
 * the pixel level on a 4000px photo, bounded so a flung trackpad gesture cannot leave the user
 * looking at four pixels with no way to tell what they are looking at.
 */
export const MAX_VIEWPORT_SCALE = 8

const INVERSE_QUARTER_TURNS = {
  0: 0,
  1: 3,
  2: 2,
  3: 1,
} as const satisfies Record<QuarterTurns, QuarterTurns>

/** Whether an edit's op list can be summarised as one (quarter turns, crop rect) pair at all. */
export type ViewportEditGeometry =
  | { kind: 'projectable'; quarterTurns: QuarterTurns; cropRect: NormalisedRect | null }
  | { kind: 'unprojectable'; reason: 'rotate-after-crop' | 'multiple-crops' }

function isUsableSize(size: PixelSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}

function isUsableRect(rect: NormalisedRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5
  }

  return Math.min(Math.max(value, 0), 1)
}

/**
 * How much of each axis of the drawn image the frame can show, as a fraction of that axis, capped at
 * the whole image. On the axis the fit scale is set by, this is exactly `1 / scale`; on the other it
 * is larger, which is why the clamp below has to be per-axis.
 */
function visibleFraction(natural: PixelSize, frame: PixelSize, scale: number): ViewportPoint {
  const drawScale = fitScale(natural, frame) * scale

  return {
    x: Math.min(1, frame.width / (natural.width * drawScale)),
    y: Math.min(1, frame.height / (natural.height * drawScale)),
  }
}

function clampAxis(value: number, visible: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(visible)) {
    return 0.5
  }

  const half = visible / 2

  return Math.min(Math.max(value, half), 1 - half)
}

/** Clamps a zoom factor to the inspector's range. */
export function clampViewportScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return MIN_VIEWPORT_SCALE
  }

  return Math.min(Math.max(scale, MIN_VIEWPORT_SCALE), MAX_VIEWPORT_SCALE)
}

/**
 * Clamps a centre to what this raster can actually show in this frame at this scale, per axis.
 *
 * At scale 1 the visible fraction is the whole image on both axes, so this collapses the centre to
 * `(0.5, 0.5)` — which is why `resolveViewportFrameRect` at `DEFAULT_VIEWPORT` is plain contain-fit
 * with no special case anywhere (R-P6).
 */
export function clampViewportCenter(
  center: ViewportPoint,
  natural: PixelSize,
  frame: PixelSize,
  scale: number,
): ViewportPoint {
  if (!isUsableSize(natural) || !isUsableSize(frame)) {
    return { x: 0.5, y: 0.5 }
  }

  const visible = visibleFraction(natural, frame, clampViewportScale(scale))

  return { x: clampAxis(center.x, visible.x), y: clampAxis(center.y, visible.y) }
}

/**
 * Where to draw one raster inside the frame: the rectangle to apply to an `<img>` as
 * `left`/`top`/`width`/`height`.
 *
 * `null` for a frame or an image that has not been measured yet (the frame before its first
 * `ResizeObserver` callback, an `<img>` before `load`), so the caller renders its own at-rest
 * fallback rather than positioning against a zero or a NaN.
 */
export function resolveViewportFrameRect(
  natural: PixelSize,
  frame: PixelSize,
  viewport: InspectorViewport,
): FrameRect | null {
  if (!isUsableSize(natural) || !isUsableSize(frame)) {
    return null
  }

  const scale = clampViewportScale(viewport.scale)
  const drawScale = fitScale(natural, frame) * scale
  // The one place the centred placement is computed, shared with Edit mode's own arithmetic.
  const centred = imageRectInFrame(natural, frame, drawScale)
  const center = clampViewportCenter(viewport.center, natural, frame, scale)
  // At DEFAULT_VIEWPORT the clamp above forces (0.5, 0.5), both shifts are exactly 0, and this
  // returns `centred` unchanged: contain-fit, R-P6, by construction rather than by branch.
  const rect: FrameRect = {
    left: centred.left + (0.5 - center.x) * centred.width,
    top: centred.top + (0.5 - center.y) * centred.height,
    width: centred.width,
    height: centred.height,
  }

  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null
  }

  return rect
}

/** The fraction of the drawn image under a frame point, clamped to the image itself. */
export function viewportFractionAt(rect: FrameRect, point: FramePoint): ViewportPoint {
  return {
    x: clamp01((point.left - rect.left) / rect.width),
    y: clamp01((point.top - rect.top) / rect.height),
  }
}

/**
 * Zooms to `nextScale` about a frame point, keeping whatever content is under that point under it —
 * the wheel/pinch gesture. Near an edge the clamp wins and the anchor drifts, because the
 * alternative is showing the user something that is not in their image.
 */
export function zoomViewportAt(
  natural: PixelSize,
  frame: PixelSize,
  viewport: InspectorViewport,
  point: FramePoint,
  nextScale: number,
): InspectorViewport {
  const scale = clampViewportScale(nextScale)
  const current = resolveViewportFrameRect(natural, frame, viewport)

  if (current === null) {
    return { center: { x: 0.5, y: 0.5 }, scale }
  }

  const fraction = viewportFractionAt(current, point)
  const nextDrawScale = fitScale(natural, frame) * scale
  const nextWidth = natural.width * nextDrawScale
  const nextHeight = natural.height * nextDrawScale
  // Inverse of resolveViewportFrameRect: a rect's left edge sits at `frame.width / 2 - center.x *
  // width`, so the centre that puts `fraction` at `point` is this.
  const center = {
    x: fraction.x + (frame.width / 2 - point.left) / nextWidth,
    y: fraction.y + (frame.height / 2 - point.top) / nextHeight,
  }

  return { center: clampViewportCenter(center, natural, frame, scale), scale }
}

/** Pans by a frame-pixel delta, so the content tracks the pointer 1:1 (docs/ui-design.md §15). */
export function panViewport(
  natural: PixelSize,
  frame: PixelSize,
  viewport: InspectorViewport,
  delta: FramePoint,
): InspectorViewport {
  const scale = clampViewportScale(viewport.scale)
  const rect = resolveViewportFrameRect(natural, frame, viewport)

  if (rect === null) {
    return { center: { x: 0.5, y: 0.5 }, scale }
  }

  // From the *clamped* centre, which is the one on screen — otherwise a drag that ran into an edge
  // would have to be dragged back out of an offset the user never saw.
  const base = clampViewportCenter(viewport.center, natural, frame, scale)
  const center = {
    x: base.x - delta.left / rect.width,
    y: base.y - delta.top / rect.height,
  }

  return { center: clampViewportCenter(center, natural, frame, scale), scale }
}

/**
 * Clockwise quarter turns applied to a point in fractions of the unit square, matching the pixel
 * rotation in `pipeline/stages/edit.ts` and `rotateSize` in `domain/edit.ts`: a source pixel
 * `(x, y)` lands at column `height - 1 - y`, row `x` on one clockwise turn, which in fractions is
 * `(1 - y, x)`.
 */
export function rotatePointByQuarterTurns(
  point: ViewportPoint,
  quarterTurns: QuarterTurns,
): ViewportPoint {
  switch (quarterTurns) {
    case 0:
      return { x: point.x, y: point.y }
    case 1:
      return { x: 1 - point.y, y: point.x }
    case 2:
      return { x: 1 - point.x, y: 1 - point.y }
    case 3:
      return { x: point.y, y: 1 - point.x }
    default: {
      const unknown: never = quarterTurns
      throw new RangeError(`unsupported quarter turns: ${JSON.stringify(unknown)}`)
    }
  }
}

/** Canonical (rotated source) into the Original tab's own, unrotated space. */
export function projectViewportToOriginal(
  viewport: InspectorViewport,
  quarterTurns: QuarterTurns,
): InspectorViewport {
  return {
    center: rotatePointByQuarterTurns(viewport.center, INVERSE_QUARTER_TURNS[quarterTurns]),
    scale: viewport.scale,
  }
}

/** The Original tab's space back into canonical. The exact inverse of the projection above. */
export function unprojectViewportFromOriginal(
  viewport: InspectorViewport,
  quarterTurns: QuarterTurns,
): InspectorViewport {
  return {
    center: rotatePointByQuarterTurns(viewport.center, quarterTurns),
    scale: viewport.scale,
  }
}

/**
 * Re-expresses a canonical viewport after the edit's own rotation changed, so the user keeps looking
 * at the same patch of the source rather than at whatever patch now happens to carry those
 * coordinates. The canonical space *is* the rotated source, so changing the rotation changes the
 * space, and the stored point has to move with it.
 */
export function rotateViewportBetweenQuarterTurns(
  viewport: InspectorViewport,
  from: QuarterTurns,
  to: QuarterTurns,
): InspectorViewport {
  return {
    center: rotatePointByQuarterTurns(
      viewport.center,
      addQuarterTurns(to, INVERSE_QUARTER_TURNS[from]),
    ),
    scale: viewport.scale,
  }
}

/**
 * Canonical into the Compressed tab's space. Identity without a crop; otherwise the canonical point
 * expressed as a fraction of the crop rect, which is what the output raster actually contains.
 *
 * A canonical point outside the crop clamps to the nearest edge rather than resetting: the user was
 * looking at part of the source this output does not contain, and the honest answer is the closest
 * part of the output to it.
 */
export function projectViewportToCompressed(
  viewport: InspectorViewport,
  cropRect: NormalisedRect | null,
): InspectorViewport {
  if (cropRect === null || !isUsableRect(cropRect)) {
    return { center: { x: viewport.center.x, y: viewport.center.y }, scale: viewport.scale }
  }

  return {
    center: {
      x: clamp01((viewport.center.x - cropRect.x) / cropRect.width),
      y: clamp01((viewport.center.y - cropRect.y) / cropRect.height),
    },
    scale: viewport.scale,
  }
}

/** The Compressed tab's space back into canonical. */
export function unprojectViewportFromCompressed(
  viewport: InspectorViewport,
  cropRect: NormalisedRect | null,
): InspectorViewport {
  if (cropRect === null || !isUsableRect(cropRect)) {
    return { center: { x: viewport.center.x, y: viewport.center.y }, scale: viewport.scale }
  }

  return {
    center: {
      x: cropRect.x + clamp01(viewport.center.x) * cropRect.width,
      y: cropRect.y + clamp01(viewport.center.y) * cropRect.height,
    },
    scale: viewport.scale,
  }
}

/**
 * Reduces an edit record to the one (quarter turns, crop rect) pair the projections above need.
 *
 * Ops are an ordered list that the pipeline walks in sequence (Technical Design §3.5), and only the
 * order `editOpsFor` produces — rotation, then at most one crop — can be summarised as a single pair.
 * A rotation *after* a crop would mean the crop rect is in a different space than the turns describe,
 * and a second crop would need the two composed. Neither is reachable from the interface today, and
 * both are named here rather than quietly mis-projected: the caller disables the inspector instead
 * (R-P6's at-rest contain-fit is still correct in that state).
 */
export function viewportEditGeometry(edit: EditRecord | null): ViewportEditGeometry {
  let quarterTurns: QuarterTurns = 0
  let cropRect: NormalisedRect | null = null

  for (const op of edit?.ops ?? []) {
    if (op.kind === 'rotate') {
      if (cropRect !== null) {
        return { kind: 'unprojectable', reason: 'rotate-after-crop' }
      }

      quarterTurns = addQuarterTurns(quarterTurns, op.quarterTurns)
      continue
    }

    if (cropRect !== null) {
      return { kind: 'unprojectable', reason: 'multiple-crops' }
    }

    cropRect = op.rect
  }

  return { kind: 'projectable', quarterTurns, cropRect }
}
