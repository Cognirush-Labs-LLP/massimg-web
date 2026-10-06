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
// Scale is pinned to the Original tab's own convention: canonical scale *is* Original-tab scale,
// with no conversion, because Original always has 1:1 pixel correspondence with canonical space — no
// crop, no resize, and rotation is magnitude-neutral. Crossing to Compressed converts that scale so
// that on-screen *pixel density* survives the switch, not apparent box size: a 500x500 output of a
// 1000x1000 source viewed at Compressed's own 100% shows the Original at 50%, the true fraction of
// its pixels currently on screen, rather than at the same apparent size
// (`nativePixelsPerCanonicalPixel`, used by `projectViewportToCompressed`/
// `unprojectViewportFromCompressed`). The box actually clipped and panned within
// (`resolveViewportBox`) still grows from `restBox` toward the host area as `scale` increases past 1,
// on whichever tab is active, using that tab's own `effectiveMaxScale` — but a value arriving from a
// tab switch may legitimately exceed that normal ceiling (a pixel-density match wins over the usual
// cap), so callers must not re-clamp a freshly-projected scale down to it.
//
// Pure, like every other module in `domain/`: no DOM, no Vue. Every value returned is a fresh object
// and nothing here mutates its arguments, which is what lets a caller hold the canonical viewport in
// a `ref` and only ever replace it.

import { addQuarterTurns, fitScale, imageRectInFrame, rotateSize } from './edit'
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

/** One tab's own rest box and natural pixel size — everything `projectScale*` needs for that tab. */
export interface ViewportTabGeometry {
  restBox: PixelSize
  natural: PixelSize
}

/** Both tabs' geometry at once, needed to convert a scale across a tab switch. */
export interface ViewportTabSizes {
  original: ViewportTabGeometry
  compressed: ViewportTabGeometry
}

/**
 * Rest state (`restBoxSize`), centred — the state R-P6 describes, and the one every image starts in.
 *
 * Deeply readonly so it cannot be mutated in place by a caller that holds it. Callers replace the
 * viewport they hold; they never mutate one.
 */
export const DEFAULT_VIEWPORT = {
  center: { x: 0.5, y: 0.5 },
  scale: 1,
} as const satisfies InspectorViewport

/**
 * Scale 1 is *this tab's own* rest state, `restBoxSize` (fit to the host, capped at 100% — never
 * upscaled) — the floor for an ordinary in-tab gesture, where zooming out past fit has nothing left
 * to show. It is not a universal floor on `scale` itself, though: a cross-tab pixel-density match
 * (R-P9) can legitimately land below 1 on the target tab (its own fit represents proportionally more
 * true pixels than the density match calls for), and that value must render smaller than this tab's
 * own rest box, not be clamped back up to it — every clamp below takes an explicit `minScale`
 * for exactly this, defaulting to this constant so an ordinary gesture call site is unaffected.
 */
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
  | {
      kind: 'unprojectable'
      reason: 'rotate-after-crop' | 'multiple-crops' | 'resize-before-final-operation'
    }

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
 * How much of each axis of the drawn image the box can show, as a fraction of that axis, capped at
 * the whole image. On the axis the fit scale is set by, this is exactly `1 / scale`; on the other it
 * is larger, which is why the clamp below has to be per-axis.
 */
function visibleFraction(restBox: PixelSize, host: PixelSize, scale: number): ViewportPoint {
  return {
    x: Math.min(1, host.width / (restBox.width * scale)),
    y: Math.min(1, host.height / (restBox.height * scale)),
  }
}

function clampAxis(value: number, visible: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(visible)) {
    return 0.5
  }

  const half = visible / 2

  return Math.min(Math.max(value, half), 1 - half)
}

/**
 * Clamps a zoom factor to the inspector's range. `maxScale` defaults to the fixed
 * `MAX_VIEWPORT_SCALE` ceiling, but a caller inspecting a large image passes `effectiveMaxScale`'s
 * result instead, so the ceiling can rise past it (see that function's own comment for why).
 * `minScale` is the same idea at the other end: defaults to `MIN_VIEWPORT_SCALE` (an ordinary
 * in-tab gesture has nothing below its own fit), but a caller rendering a cross-tab pixel-density
 * match passes that match's own scale instead, so a legitimately-sub-1 value is not clamped back up
 * to fit (R-P9).
 */
export function clampViewportScale(
  scale: number,
  maxScale: number = MAX_VIEWPORT_SCALE,
  minScale: number = MIN_VIEWPORT_SCALE,
): number {
  if (!Number.isFinite(scale)) {
    return minScale
  }

  return Math.min(Math.max(scale, minScale), maxScale)
}

/**
 * Clamps a centre to what the image can actually show in `host` at this scale, per axis.
 *
 * At scale 1 the visible fraction is the whole image on both axes, so this collapses the centre to
 * `(0.5, 0.5)` — which is why `resolveViewportFrameRect` at `DEFAULT_VIEWPORT` is plain contain-fit
 * with no special case anywhere (R-P6). The same collapse happens, just as correctly, for any scale
 * below 1 that still leaves the drawn box no bigger than `host` on an axis — nothing further from
 * `visibleFraction`'s own `Math.min(1, ...)` cap is needed for that case.
 */
export function clampViewportCenter(
  center: ViewportPoint,
  restBox: PixelSize,
  host: PixelSize,
  scale: number,
  maxScale: number = MAX_VIEWPORT_SCALE,
  minScale: number = MIN_VIEWPORT_SCALE,
): ViewportPoint {
  if (!isUsableSize(restBox) || !isUsableSize(host)) {
    return { x: 0.5, y: 0.5 }
  }

  const visible = visibleFraction(restBox, host, clampViewportScale(scale, maxScale, minScale))

  return { x: clampAxis(center.x, visible.x), y: clampAxis(center.y, visible.y) }
}

/**
 * The box the image occupies at rest (`scale` 1): downscale to fit `host`, but never upscale past
 * the image's own pixel size — an image already smaller than the host is shown at its true size
 * rather than blown up to fill it. `MIN_VIEWPORT_SCALE`'s "fit" is a ceiling on the rest state, not
 * a target.
 */
export function restBoxSize(natural: PixelSize, host: PixelSize): PixelSize {
  if (!isUsableSize(natural) || !isUsableSize(host)) {
    return { width: 0, height: 0 }
  }

  const scale = Math.min(1, fitScale(natural, host))

  return { width: natural.width * scale, height: natural.height * scale }
}

/**
 * The scale at which the active tab's image renders at its true pixel size. `restBox` already
 * encodes whatever fit-shrink was applied (never upscaled — see `restBoxSize`), so this is exactly
 * the inverse of that shrink: 1 when the image already fit at its own size, >1 when it had to
 * shrink to fit. Not clamped to `MAX_VIEWPORT_SCALE`: a photo shrunk hard to fit a small preview can
 * need well past 8x just to reach its own true size, and "Actual size" has to be able to reach it —
 * `effectiveMaxScale` is what keeps that reachable by manual zoom too.
 */
export function pixelPerfectScale(restBox: PixelSize, natural: PixelSize): number {
  if (!isUsableSize(restBox) || !isUsableSize(natural)) {
    return MIN_VIEWPORT_SCALE
  }

  return Math.max(MIN_VIEWPORT_SCALE, natural.width / restBox.width)
}

/**
 * The inspector's zoom ceiling for one particular image: at least `MAX_VIEWPORT_SCALE`, but never
 * less than twice `pixelPerfectScale` — so a large photo shrunk hard to fit a small preview can
 * still be inspected at a true 200%+ by hand, rather than topping out below (or barely above) its
 * own actual size. `MAX_VIEWPORT_SCALE` alone is a scale *relative to the rest box*, and the rest
 * box can be shrunk by an arbitrary factor relative to the image's own pixels, so a fixed scale
 * ceiling does not translate to a fixed "how far past true size can you zoom" guarantee across
 * images — this does.
 */
export function effectiveMaxScale(restBox: PixelSize, natural: PixelSize): number {
  if (!isUsableSize(restBox) || !isUsableSize(natural)) {
    return MAX_VIEWPORT_SCALE
  }

  return Math.max(MAX_VIEWPORT_SCALE, pixelPerfectScale(restBox, natural) * 2)
}

/**
 * How much of the image's true pixel size is currently on screen, for a zoom readout. Not simply
 * `scale * 100`: at rest (`scale` 1) this is only 100 when the image already fit without shrinking —
 * a large image shrunk to fit reads less than 100 at rest, which is the whole point of
 * distinguishing "fit" from "actual size".
 */
export function displayedZoomPercent(
  restBox: PixelSize,
  natural: PixelSize,
  scale: number,
): number {
  if (!isUsableSize(restBox) || !isUsableSize(natural)) {
    return 0
  }

  const safeScale = Number.isFinite(scale) ? scale : MIN_VIEWPORT_SCALE

  return ((safeScale * restBox.width) / natural.width) * 100
}

/**
 * Native pixels per canonical (rotated, uncropped source) pixel, along width. Always 1 for
 * `'original'`: that tab is never cropped or resized, and rotation only reshuffles axes, so it has
 * exact 1:1 pixel correspondence with canonical space by definition. For `'compressed'`, the
 * resize+crop ratio: how many of the output's own pixels cover one canonical pixel. Resize is a
 * single uniform scale over the whole (possibly cropped) region, so this is one scalar for the
 * entire image, not something that varies by position.
 *
 * Needs `sizes.original.natural` (not just the compressed side) because canonical space is the
 * *rotated* source: on an odd quarter turn, canonical's width axis is the Original's own height
 * axis, and `rotateSize` is what re-expresses that correctly rather than assuming width stays width.
 *
 * Falls back to `1` (plain passthrough, same as before this ratio existed) rather than `NaN` or
 * `Infinity` when either natural size or the crop rect isn't usable yet — e.g. before either raster
 * has been measured, which is exactly the state the inspector starts in.
 */
export function nativePixelsPerCanonicalPixel(
  tab: 'original' | 'compressed',
  sizes: ViewportTabSizes,
  quarterTurns: QuarterTurns,
  cropRect: NormalisedRect | null,
): number {
  if (tab === 'original') {
    return 1
  }

  if (!isUsableSize(sizes.compressed.natural) || !isUsableSize(sizes.original.natural)) {
    return 1
  }

  const rotatedSourceWidth = rotateSize(sizes.original.natural, quarterTurns).width
  const canonicalWidthCovered =
    cropRect !== null && isUsableRect(cropRect)
      ? cropRect.width * rotatedSourceWidth
      : rotatedSourceWidth

  if (!Number.isFinite(canonicalWidthCovered) || canonicalWidthCovered <= 0) {
    return 1
  }

  return sizes.compressed.natural.width / canonicalWidthCovered
}

/**
 * Converts a scale from the Original tab's own convention (which canonical scale is pinned to) into
 * the Compressed tab's. Falls back to plain passthrough when either tab's geometry isn't usable yet,
 * so a not-yet-measured raster never produces `NaN` mid-gesture.
 */
function scaleToCompressed(scale: number, sizes: ViewportTabSizes, ratio: number): number {
  if (
    !isUsableSize(sizes.original.restBox) ||
    !isUsableSize(sizes.original.natural) ||
    !isUsableSize(sizes.compressed.restBox) ||
    !isUsableSize(sizes.compressed.natural) ||
    ratio <= 0
  ) {
    return scale
  }

  return (
    (scale *
      (sizes.original.restBox.width / sizes.original.natural.width) *
      (sizes.compressed.natural.width / sizes.compressed.restBox.width)) /
    ratio
  )
}

/** The inverse of `scaleToCompressed`: Compressed's own scale back into the Original convention. */
function scaleToOriginal(scale: number, sizes: ViewportTabSizes, ratio: number): number {
  if (
    !isUsableSize(sizes.original.restBox) ||
    !isUsableSize(sizes.original.natural) ||
    !isUsableSize(sizes.compressed.restBox) ||
    !isUsableSize(sizes.compressed.natural)
  ) {
    return scale
  }

  return (
    scale *
    (sizes.compressed.restBox.width / sizes.compressed.natural.width) *
    ratio *
    (sizes.original.natural.width / sizes.original.restBox.width)
  )
}

/**
 * The box the inspector actually clips and pans within, at a given zoom `scale`: exactly `restBox`
 * at rest, growing proportionally toward `host` as `scale` increases, capped there per axis since
 * there is no more host to use. Below saturation `box.axis == restBox.axis * scale` exactly, so the
 * drawn image exactly fills the box and there is nothing to pan yet — only once an axis saturates
 * does that axis start revealing previously-unused host space.
 */
export function resolveViewportBox(restBox: PixelSize, host: PixelSize, scale: number): PixelSize {
  if (!isUsableSize(restBox) || !isUsableSize(host) || !Number.isFinite(scale)) {
    return { width: 0, height: 0 }
  }

  return {
    width: Math.min(host.width, restBox.width * scale),
    height: Math.min(host.height, restBox.height * scale),
  }
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
  restBox: PixelSize,
  host: PixelSize,
  viewport: InspectorViewport,
  maxScale: number = MAX_VIEWPORT_SCALE,
  minScale: number = MIN_VIEWPORT_SCALE,
): FrameRect | null {
  if (!isUsableSize(restBox) || !isUsableSize(host)) {
    return null
  }

  const scale = clampViewportScale(viewport.scale, maxScale, minScale)
  const box = resolveViewportBox(restBox, host, scale)
  // The one place the centred placement is computed, shared with Edit mode's own arithmetic.
  // `restBox` stands in for Edit's `source`: `restBox.width * scale` is the drawn width.
  const centred = imageRectInFrame(restBox, box, scale)
  const center = clampViewportCenter(viewport.center, restBox, host, scale, maxScale, minScale)
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
  restBox: PixelSize,
  host: PixelSize,
  viewport: InspectorViewport,
  point: FramePoint,
  nextScale: number,
  maxScale: number = MAX_VIEWPORT_SCALE,
  minScale: number = MIN_VIEWPORT_SCALE,
): InspectorViewport {
  const scale = clampViewportScale(nextScale, maxScale, minScale)
  const current = resolveViewportFrameRect(restBox, host, viewport, maxScale, minScale)

  if (current === null) {
    return { center: { x: 0.5, y: 0.5 }, scale }
  }

  const fraction = viewportFractionAt(current, point)
  // The box is centred in `host` on both the current and next scale, so if it grows or shrinks
  // between them its top-left corner physically shifts by half the size delta even though the
  // pointer hasn't moved. Re-express `point` (measured against the box as currently rendered)
  // in the next box's own coordinate space before solving for the centre that keeps `fraction`
  // under it — otherwise every tick while the box is resizing drifts the content from the
  // cursor instead of keeping it pinned.
  const currentBox = resolveViewportBox(
    restBox,
    host,
    clampViewportScale(viewport.scale, maxScale, minScale),
  )
  const nextBox = resolveViewportBox(restBox, host, scale)
  const adjustedPoint: FramePoint = {
    left: point.left + (nextBox.width - currentBox.width) / 2,
    top: point.top + (nextBox.height - currentBox.height) / 2,
  }
  const nextWidth = restBox.width * scale
  const nextHeight = restBox.height * scale
  // Inverse of resolveViewportFrameRect: a rect's left edge sits at `box.width / 2 - center.x *
  // width`, so the centre that puts `fraction` at `adjustedPoint` (in the next box's space) is
  // this.
  const center = {
    x: fraction.x + (nextBox.width / 2 - adjustedPoint.left) / nextWidth,
    y: fraction.y + (nextBox.height / 2 - adjustedPoint.top) / nextHeight,
  }

  return { center: clampViewportCenter(center, restBox, host, scale, maxScale, minScale), scale }
}

/** Pans by a frame-pixel delta, so the content tracks the pointer 1:1 (docs/ui-design.md §15). */
export function panViewport(
  restBox: PixelSize,
  host: PixelSize,
  viewport: InspectorViewport,
  delta: FramePoint,
  maxScale: number = MAX_VIEWPORT_SCALE,
  minScale: number = MIN_VIEWPORT_SCALE,
): InspectorViewport {
  const scale = clampViewportScale(viewport.scale, maxScale, minScale)
  const rect = resolveViewportFrameRect(restBox, host, viewport, maxScale, minScale)

  if (rect === null) {
    return { center: { x: 0.5, y: 0.5 }, scale }
  }

  // From the *clamped* centre, which is the one on screen — otherwise a drag that ran into an edge
  // would have to be dragged back out of an offset the user never saw.
  const base = clampViewportCenter(viewport.center, restBox, host, scale, maxScale, minScale)
  const center = {
    x: base.x - delta.left / rect.width,
    y: base.y - delta.top / rect.height,
  }

  return { center: clampViewportCenter(center, restBox, host, scale, maxScale, minScale), scale }
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
 * Canonical into the Compressed tab's space. Centre: identity without a crop; otherwise the
 * canonical point expressed as a fraction of the crop rect, which is what the output raster actually
 * contains. Scale: converted so pixel density survives the switch (see module doc comment), via
 * `nativePixelsPerCanonicalPixel` — this is the one tab whose density ratio isn't 1.
 *
 * A canonical point outside the crop clamps to the nearest edge rather than resetting: the user was
 * looking at part of the source this output does not contain, and the honest answer is the closest
 * part of the output to it.
 */
export function projectViewportToCompressed(
  viewport: InspectorViewport,
  cropRect: NormalisedRect | null,
  quarterTurns: QuarterTurns,
  sizes: ViewportTabSizes,
): InspectorViewport {
  const ratio = nativePixelsPerCanonicalPixel('compressed', sizes, quarterTurns, cropRect)
  const scale = scaleToCompressed(viewport.scale, sizes, ratio)

  if (cropRect === null || !isUsableRect(cropRect)) {
    return { center: { x: viewport.center.x, y: viewport.center.y }, scale }
  }

  return {
    center: {
      x: clamp01((viewport.center.x - cropRect.x) / cropRect.width),
      y: clamp01((viewport.center.y - cropRect.y) / cropRect.height),
    },
    scale,
  }
}

/** The Compressed tab's space back into canonical. */
export function unprojectViewportFromCompressed(
  viewport: InspectorViewport,
  cropRect: NormalisedRect | null,
  quarterTurns: QuarterTurns,
  sizes: ViewportTabSizes,
): InspectorViewport {
  const ratio = nativePixelsPerCanonicalPixel('compressed', sizes, quarterTurns, cropRect)
  const scale = scaleToOriginal(viewport.scale, sizes, ratio)

  if (cropRect === null || !isUsableRect(cropRect)) {
    return { center: { x: viewport.center.x, y: viewport.center.y }, scale }
  }

  return {
    center: {
      x: cropRect.x + clamp01(viewport.center.x) * cropRect.width,
      y: cropRect.y + clamp01(viewport.center.y) * cropRect.height,
    },
    scale,
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

  const ops = edit?.ops ?? []

  for (const [index, op] of ops.entries()) {
    if (op.kind === 'rotate') {
      if (cropRect !== null) {
        return { kind: 'unprojectable', reason: 'rotate-after-crop' }
      }

      quarterTurns = addQuarterTurns(quarterTurns, op.quarterTurns)
      continue
    }

    if (op.kind === 'resize') {
      if (index !== ops.length - 1) {
        return { kind: 'unprojectable', reason: 'resize-before-final-operation' }
      }

      continue
    }

    if (cropRect !== null) {
      return { kind: 'unprojectable', reason: 'multiple-crops' }
    }

    cropRect = op.rect
  }

  return { kind: 'projectable', quarterTurns, cropRect }
}
