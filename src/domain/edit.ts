import type { EditOp, NormalisedRect, Rgba } from './types'

/** Pixel dimensions of a source image, a frame, or an output raster. */
export interface PixelSize {
  width: number
  height: number
}

/**
 * A rectangle in frame pixels. The left and top naming keeps this unassignable to
 * NormalisedRect in either direction, so the two coordinate spaces cannot be mixed.
 */
export interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

/** Where the source lands inside the output raster; spill makes the offsets positive. */
export interface SourcePlacement {
  offsetX: number
  offsetY: number
  width: number
  height: number
}

/** Output pixels along each edge that contain no source and must be filled. */
export interface SpillBands {
  left: number
  top: number
  right: number
  bottom: number
}

export type QuarterTurns = Extract<EditOp, { kind: 'rotate' }>['quarterTurns']

export type RatioId = 'free' | '1:1' | '4:5' | '16:9' | '9:16'

export type AspectRatio = { kind: 'free' } | { kind: 'locked'; ratio: number }

export type RectAnchor = 'centre' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type TypedDimension = { kind: 'width'; pixels: number } | { kind: 'height'; pixels: number }

export interface CropLimits {
  /** The R-C12 floor, in output pixels. */
  minimumOutputPixels: number
  /** A usability floor in frame pixels, owned by the interface rather than by this module. */
  minimumFramePixels: number
}

export interface CropConstraints {
  frame: PixelSize
  drawScale: number
  ratio: AspectRatio
  limits: CropLimits
  anchor: RectAnchor
}

export interface CropInputContext {
  source: PixelSize
  frame: PixelSize
  quarterTurns: QuarterTurns
  ratio: AspectRatio
  limits: CropLimits
}

export interface CropGeometryInput {
  /** Source dimensions after EXIF orientation and before the quarter turns below. */
  source: PixelSize
  quarterTurns: QuarterTurns
  frame: PixelSize
  zoom: number
  rect: FrameRect
  ratio: AspectRatio
  limits: CropLimits
}

export interface CropOutput {
  size: PixelSize
  placement: SourcePlacement
  spill: SpillBands
}

export interface ResolvedCropGeometry {
  kind: 'resolved'
  quarterTurns: QuarterTurns
  /** Ws and Hs: the source after its quarter turns. */
  rotatedSource: PixelSize
  fitScale: number
  drawScale: number
  /** Where the image is drawn, centred in the frame. R-C3 refits this, never the frame itself. */
  imageRect: FrameRect
  rect: FrameRect
  /** Fractions of the source, which fall outside the unit square wherever the crop spills. */
  normalisedRect: NormalisedRect
  output: CropOutput
  minimumRect: PixelSize
  /** The same floor in output pixels, so the typed dimension inputs cannot advertise a lie. */
  minimumOutput: PixelSize
}

export type CropGeometry =
  | ResolvedCropGeometry
  | { kind: 'unresolvable'; reason: 'empty-frame' | 'empty-source' | 'invalid-zoom' }

const RATIO_VALUES = {
  free: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
} as const satisfies Record<RatioId, number | null>

/** The ratio row of Functional Design §3.4, in the order the interface presents it. */
export const RATIO_IDS = [
  'free',
  '1:1',
  '4:5',
  '16:9',
  '9:16',
] as const satisfies readonly RatioId[]

const QUARTER_TURNS = [0, 1, 2, 3] as const satisfies readonly QuarterTurns[]

interface AnchorFactors {
  x: number
  y: number
}

const ANCHOR_FACTORS = {
  centre: { x: 0.5, y: 0.5 },
  'top-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
} as const satisfies Record<RectAnchor, AnchorFactors>

export const DEFAULT_CROP_LIMITS = {
  minimumOutputPixels: 16,
  minimumFramePixels: 0,
} as const satisfies CropLimits

function isPositiveSize(size: PixelSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest)
}

function sanitiseLength(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sanitiseCoordinate(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function roundPixels(value: number): number {
  const rounded = Math.round(value)

  return rounded === 0 ? 0 : rounded
}

function minimumFrameSize(constraints: CropConstraints): PixelSize {
  const { frame, drawScale, limits } = constraints
  const floor = Math.max(limits.minimumOutputPixels * drawScale, limits.minimumFramePixels)

  return {
    width: Math.min(frame.width, floor),
    height: Math.min(frame.height, floor),
  }
}

function applyRatio(size: PixelSize, ratio: AspectRatio): PixelSize {
  return ratio.kind === 'free' ? size : { width: size.width, height: size.width / ratio.ratio }
}

function fitSize(
  size: PixelSize,
  minimum: PixelSize,
  frame: PixelSize,
  ratio: AspectRatio,
): PixelSize {
  if (ratio.kind === 'free') {
    return {
      width: clamp(size.width, minimum.width, frame.width),
      height: clamp(size.height, minimum.height, frame.height),
    }
  }

  const shrink = Math.min(1, frame.width / size.width, frame.height / size.height)
  const width = size.width * shrink
  const height = size.height * shrink
  const grow = Math.min(
    Math.max(1, minimum.width / width, minimum.height / height),
    Math.min(frame.width / width, frame.height / height),
  )

  return { width: width * grow, height: height * grow }
}

function sizedForTypedDimension(
  rect: FrameRect,
  typed: TypedDimension,
  drawScale: number,
  ratio: AspectRatio,
): FrameRect {
  const length = Math.max(0, typed.pixels) * drawScale

  if (typed.kind === 'width') {
    return {
      ...rect,
      width: length,
      height: ratio.kind === 'locked' ? length / ratio.ratio : rect.height,
    }
  }

  return {
    ...rect,
    height: length,
    width: ratio.kind === 'locked' ? length * ratio.ratio : rect.width,
  }
}

function assertExhaustive(op: never): void {
  void op
}

function applyOp(size: PixelSize, op: EditOp): PixelSize {
  if (op.kind === 'rotate') {
    return rotateSize(size, op.quarterTurns)
  }

  if (op.kind === 'crop') {
    return resolveCropOutput(op.rect, size).size
  }

  assertExhaustive(op)

  return size
}

/** Scales the source so the whole image fits the frame. */
export function fitScale(source: PixelSize, frame: PixelSize): number {
  return Math.min(frame.width / source.width, frame.height / source.height)
}

/** Applies quarter turns to a pixel size, swapping the axes on an odd turn. */
export function rotateSize(size: PixelSize, quarterTurns: QuarterTurns): PixelSize {
  return quarterTurns % 2 === 0
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width }
}

/** Adds clockwise quarter turns, wrapping at a full revolution. */
export function addQuarterTurns(turns: QuarterTurns, delta: QuarterTurns): QuarterTurns {
  return QUARTER_TURNS[(turns + delta) % 4]!
}

/** Resolves a ratio chip to the proportion it locks. */
export function aspectRatioFor(id: RatioId): AspectRatio {
  const ratio = RATIO_VALUES[id]

  return ratio === null ? { kind: 'free' } : { kind: 'locked', ratio }
}

/** Locates the drawn image inside the frame, centred, at the given draw scale. */
export function imageRectInFrame(
  source: PixelSize,
  frame: PixelSize,
  drawScale: number,
): FrameRect {
  const width = source.width * drawScale
  const height = source.height * drawScale

  return {
    left: (frame.width - width) / 2,
    top: (frame.height - height) / 2,
    width,
    height,
  }
}

/** Converts a frame rectangle into fractions of the drawn image. */
export function toNormalisedRect(rect: FrameRect, imageRect: FrameRect): NormalisedRect {
  return {
    x: (rect.left - imageRect.left) / imageRect.width,
    y: (rect.top - imageRect.top) / imageRect.height,
    width: rect.width / imageRect.width,
    height: rect.height / imageRect.height,
  }
}

/** Converts fractions of the drawn image back into a frame rectangle. */
export function toFrameRect(rect: NormalisedRect, imageRect: FrameRect): FrameRect {
  return {
    left: imageRect.left + rect.x * imageRect.width,
    top: imageRect.top + rect.y * imageRect.height,
    width: rect.width * imageRect.width,
    height: rect.height * imageRect.height,
  }
}

/**
 * Fits a rectangle to the frame, the locked ratio and the minimum size about its anchor.
 * The frame wins outright, the ratio survives next, and the minimum yields when they conflict.
 */
export function constrainCropRect(rect: FrameRect, constraints: CropConstraints): FrameRect {
  const { frame, ratio, anchor } = constraints
  const minimum = minimumFrameSize(constraints)
  const factors = ANCHOR_FACTORS[anchor]
  const startWidth = sanitiseLength(rect.width, minimum.width)
  const startHeight = sanitiseLength(rect.height, minimum.height)
  const { width, height } = fitSize(
    applyRatio({ width: startWidth, height: startHeight }, ratio),
    minimum,
    frame,
    ratio,
  )
  const anchorX = sanitiseCoordinate(rect.left) + factors.x * startWidth
  const anchorY = sanitiseCoordinate(rect.top) + factors.y * startHeight

  return {
    left: clamp(anchorX - factors.x * width, 0, Math.max(0, frame.width - width)),
    top: clamp(anchorY - factors.y * height, 0, Math.max(0, frame.height - height)),
    width,
    height,
  }
}

/**
 * Resolves the output raster of a crop over a source, with no frame involved. This is the
 * only place output size is computed, so the interface and the pipeline cannot disagree.
 */
export function resolveCropOutput(rect: NormalisedRect, source: PixelSize): CropOutput {
  const width = Math.max(1, Math.round(rect.width * source.width))
  const height = Math.max(1, Math.round(rect.height * source.height))
  const offsetX = roundPixels(-rect.x * source.width)
  const offsetY = roundPixels(-rect.y * source.height)

  return {
    size: { width, height },
    placement: { offsetX, offsetY, width: source.width, height: source.height },
    spill: {
      left: Math.max(0, offsetX),
      top: Math.max(0, offsetY),
      right: Math.max(0, width - offsetX - source.width),
      bottom: Math.max(0, height - offsetY - source.height),
    },
  }
}

/** Reports whether any output pixel falls outside the source and needs background fill. */
export function hasSpill(spill: SpillBands): boolean {
  return spill.left > 0 || spill.top > 0 || spill.right > 0 || spill.bottom > 0
}

/**
 * Builds the default editing state: zoom 1, the whole rotated image, refitted to any locked
 * ratio. Shared by fresh entry, restore, stepping to another image, and rotation.
 */
export function resolveCropInput(context: CropInputContext): CropGeometryInput {
  const rotatedSource = rotateSize(context.source, context.quarterTurns)

  return {
    source: context.source,
    quarterTurns: context.quarterTurns,
    frame: context.frame,
    zoom: 1,
    rect: imageRectInFrame(rotatedSource, context.frame, fitScale(rotatedSource, context.frame)),
    ratio: context.ratio,
    limits: context.limits,
  }
}

/** Resolves every derived value of a crop from one snapshot of the editing controls. */
export function resolveCropGeometry(input: CropGeometryInput): CropGeometry {
  if (!isPositiveSize(input.frame)) {
    return { kind: 'unresolvable', reason: 'empty-frame' }
  }

  if (!isPositiveSize(input.source)) {
    return { kind: 'unresolvable', reason: 'empty-source' }
  }

  if (!Number.isFinite(input.zoom) || input.zoom <= 0) {
    return { kind: 'unresolvable', reason: 'invalid-zoom' }
  }

  const rotatedSource = rotateSize(input.source, input.quarterTurns)
  const scale = fitScale(rotatedSource, input.frame)
  const drawScale = scale * input.zoom
  const imageRect = imageRectInFrame(rotatedSource, input.frame, drawScale)
  const constraints: CropConstraints = {
    frame: input.frame,
    drawScale,
    ratio: input.ratio,
    limits: input.limits,
    anchor: 'centre',
  }
  const rect = constrainCropRect(input.rect, constraints)
  const normalisedRect = toNormalisedRect(rect, imageRect)
  const minimumRect = minimumFrameSize(constraints)
  const minimumNormalised = toNormalisedRect(
    { left: imageRect.left, top: imageRect.top, ...minimumRect },
    imageRect,
  )

  return {
    kind: 'resolved',
    quarterTurns: input.quarterTurns,
    rotatedSource,
    fitScale: scale,
    drawScale,
    imageRect,
    rect,
    normalisedRect,
    output: resolveCropOutput(normalisedRect, rotatedSource),
    minimumRect,
    minimumOutput: resolveCropOutput(minimumNormalised, rotatedSource).size,
  }
}

/** Resizes the crop rectangle so that a typed output dimension is the one produced. */
export function cropRectForTypedDimension(
  input: CropGeometryInput,
  typed: TypedDimension,
): FrameRect {
  const rotatedSource = rotateSize(input.source, input.quarterTurns)
  const drawScale = fitScale(rotatedSource, input.frame) * input.zoom

  return constrainCropRect(sizedForTypedDimension(input.rect, typed, drawScale, input.ratio), {
    frame: input.frame,
    drawScale,
    ratio: input.ratio,
    limits: input.limits,
    anchor: 'centre',
  })
}

/**
 * Turns the edit a quarter clockwise and resets the crop, because rotation discards the
 * placed rectangle and returns to the fit point (R-C3).
 */
export function rotateCropInput(input: CropGeometryInput, delta: QuarterTurns): CropGeometryInput {
  return resolveCropInput({
    source: input.source,
    frame: input.frame,
    quarterTurns: addQuarterTurns(input.quarterTurns, delta),
    ratio: input.ratio,
    limits: input.limits,
  })
}

/**
 * Whether a normalised rect covers the whole (rotated) source exactly, with no pan or zoom —
 * the shape `resolveCropInput`'s untouched default always resolves to.
 */
function isIdentityCrop(rect: NormalisedRect): boolean {
  return rect.x === 0 && rect.y === 0 && rect.width === 1 && rect.height === 1
}

/**
 * Builds the stored operations for an applied edit, rotation before crop. A crop rectangle that
 * still covers the whole source is omitted rather than stored as a no-op `crop` op (R-D4): a
 * stored crop op is what tells `resolveDimension` the batch dimension rule was overridden, so a
 * rotation-only edit must not produce one.
 */
export function editOpsFor(
  geometry: ResolvedCropGeometry,
  zoom: number,
  background: Rgba,
): EditOp[] {
  const ops: EditOp[] = []

  if (geometry.quarterTurns !== 0) {
    ops.push({ kind: 'rotate', quarterTurns: geometry.quarterTurns })
  }

  if (!isIdentityCrop(geometry.normalisedRect)) {
    ops.push({ kind: 'crop', rect: geometry.normalisedRect, zoom, background })
  }

  return ops
}

/**
 * Walks an operation list in order and returns the output size it produces. Stored zoom is
 * interface state only; the rectangle alone determines the size.
 */
export function resolveEditedSize(source: PixelSize, ops: readonly EditOp[]): PixelSize {
  return ops.reduce(applyOp, { width: source.width, height: source.height })
}

/** Reports whether an operation list crops, which is what overrides the batch dimension rule. */
export function hasCropOp(ops: readonly EditOp[]): boolean {
  return ops.some((op) => op.kind === 'crop')
}
