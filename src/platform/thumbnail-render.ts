// Thumbnail rendering: the decode/edit/encode work itself, and the protocol the worker speaks.
// Kept separate from thumbnail-worker.ts so the service and the unit tests can import the geometry
// helpers without importing a module whose top level installs a worker message listener.

import { hasSpill, resolveCropOutput, resolveEditedSize, rotateSize } from '@/domain/edit'
import type { PixelSize, QuarterTurns } from '@/domain/edit'
import type { EditOp, Rgba } from '@/domain/types'

export type ThumbnailFormat = 'image/jpeg' | 'image/webp'

export interface ThumbnailJobRequest {
  /** Echoed back so the service can discard a completion that raced a cancellation (R-G12). */
  token: number
  id: string
  blob: Blob
  /** Source pixel dimensions, known from the ImageRecord — avoids a probe decode. */
  source: PixelSize
  ops: readonly EditOp[]
  maxEdge: number
  format: ThumbnailFormat
  quality: number
  /**
   * Whether the generation context should fall back to ImageMagick when the engine cannot decode
   * the source natively (Technical Design §10.4).
   *
   * Carried in the request rather than read from configuration inside the worker so that the
   * service's `fallbackDecoder: null` ("no fallback") is honoured by the context that would do the
   * work, not just by the one that receives the answer.
   */
  allowFallback: boolean
}

export type ThumbnailJobResponse =
  | { token: number; id: string; ok: true; blob: Blob; width: number; height: number }
  | { token: number; id: string; ok: false; reason: ThumbnailFailure }

/**
 * `unsupported` is the ImageMagick fallback's trigger (Technical Design §10.4): a supported input
 * the engine cannot decode natively. `failed` is everything else. Both end in a placeholder while
 * no fallback decoder is wired, but they are not the same condition and are not merged.
 */
export type ThumbnailFailure = 'unsupported' | 'failed'

/** Never upscales. Both axes bounded, not width alone (R-G3). */
export function scaleToFit(size: PixelSize, maxEdge: number): number {
  return Math.min(1, maxEdge / size.width, maxEdge / size.height)
}

/**
 * Bounds both axes. `createImageBitmap`'s `resizeWidth`/`resizeHeight` stretch to whatever they are
 * given rather than fitting, so the aspect-preserving fit is computed here and both values passed.
 */
export function fitWithin(size: PixelSize, maxEdge: number): PixelSize {
  const scale = scaleToFit(size, maxEdge)

  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/** The finished thumbnail's dimensions for a source and its stored edit, without decoding anything. */
export function thumbnailSize(
  source: PixelSize,
  ops: readonly EditOp[],
  maxEdge: number,
): PixelSize {
  return fitWithin(resolveEditedSize(source, ops), maxEdge)
}

type Drawable = ImageBitmap | OffscreenCanvas

function sizeOf(source: Drawable): PixelSize {
  return { width: source.width, height: source.height }
}

function canvasOf(size: PixelSize): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, size.width), Math.max(1, size.height))
}

function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('OffscreenCanvas 2D context unavailable')
  }
  return context
}

function cssColour({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Clockwise quarter turns, matching `rotateSize`/`addQuarterTurns` in domain/edit.ts. */
function drawRotated(source: Drawable, quarterTurns: QuarterTurns): Drawable {
  if (quarterTurns === 0) {
    return source
  }

  const output = rotateSize(sizeOf(source), quarterTurns)
  const canvas = canvasOf(output)
  const context = contextOf(canvas)

  if (quarterTurns === 1) {
    context.translate(output.width, 0)
  } else if (quarterTurns === 2) {
    context.translate(output.width, output.height)
  } else {
    context.translate(0, output.height)
  }
  context.rotate((quarterTurns * Math.PI) / 2)
  context.drawImage(source, 0, 0)

  return canvas
}

function drawCropped(source: Drawable, op: Extract<EditOp, { kind: 'crop' }>): Drawable {
  // resolveCropOutput is the only place a crop's output size is computed (domain/edit.ts), so the
  // thumbnail and the real pipeline cannot disagree about what a crop produces.
  const output = resolveCropOutput(op.rect, sizeOf(source))
  const canvas = canvasOf(output.size)
  const context = contextOf(canvas)

  if (hasSpill(output.spill)) {
    context.fillStyle = cssColour(op.background)
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(source, output.placement.offsetX, output.placement.offsetY)

  return canvas
}

function toCanvas(source: Drawable): OffscreenCanvas {
  if (source instanceof OffscreenCanvas) {
    return source
  }

  const canvas = canvasOf(sizeOf(source))
  contextOf(canvas).drawImage(source, 0, 0)
  return canvas
}

export interface RenderedThumbnail {
  blob: Blob
  width: number
  height: number
}

export async function render(request: ThumbnailJobRequest): Promise<RenderedThumbnail> {
  const { source, ops, maxEdge } = request

  // Decode straight to the resolution the finished thumbnail needs, so peak decoded cost is
  // source x scale^2 rather than a full-resolution bitmap (R-B2/R-B3, Technical Design §8.1).
  const scale = scaleToFit(resolveEditedSize(source, ops), maxEdge)
  const bitmap = await createImageBitmap(request.blob, {
    resizeWidth: Math.max(1, Math.round(source.width * scale)),
    resizeHeight: Math.max(1, Math.round(source.height * scale)),
    resizeQuality: 'high',
  })

  try {
    let drawable: Drawable = bitmap
    for (const op of ops) {
      if (op.kind === 'rotate') {
        drawable = drawRotated(drawable, op.quarterTurns)
      } else if (op.kind === 'crop') {
        drawable = drawCropped(drawable, op)
      } else {
        // An operation this build does not understand must not yield a silently wrong thumbnail.
        throw new Error('unsupported edit operation')
      }
    }

    // Rounding through the op chain can leave the result a pixel off the bound; a final fit-draw
    // makes R-G3's bound exact rather than approximate.
    const bound = fitWithin(sizeOf(drawable), maxEdge)
    if (drawable.width !== bound.width || drawable.height !== bound.height) {
      const canvas = canvasOf(bound)
      contextOf(canvas).drawImage(drawable, 0, 0, bound.width, bound.height)
      drawable = canvas
    }

    const canvas = toCanvas(drawable)
    const blob = await canvas.convertToBlob({ type: request.format, quality: request.quality })

    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close()
  }
}

/**
 * A decode the engine simply cannot do rejects with a DOMException; anything else is a real failure.
 * This is what decides whether the fallback decoder is worth calling.
 */
export function failureFor(error: unknown): ThumbnailFailure {
  return error instanceof DOMException ? 'unsupported' : 'failed'
}
