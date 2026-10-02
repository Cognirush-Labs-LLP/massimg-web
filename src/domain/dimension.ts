import type { PixelSize } from './edit'
import type { ResolvedDimension } from './types'

function assertPixelValue(pixels: number): void {
  if (!Number.isInteger(pixels) || pixels < 1) {
    throw new RangeError(`dimension value must be a positive whole number of pixels, got ${pixels}`)
  }
}

/** Scales one edge in proportion to another edge becoming `target`, never below one pixel. */
function derivedEdge(edge: number, from: number, target: number): number {
  return Math.max(1, Math.round((edge * target) / from))
}

/**
 * Resolves the output size a dimension rule produces for an image of `size` (Functional Design §4.2,
 * R-N1, R-N2). The constrained edge is set to the requested value exactly, not reached through a
 * floating-point scale, and only the other edge is rounded.
 *
 * A crop override (R-D1) is not handled here: `resolveSettings` has already turned the rule into
 * `original` for a cropped image. Rotation is (R-D4): pass the edited size.
 */
export function resolveResizedSize(size: PixelSize, dimension: ResolvedDimension): PixelSize {
  switch (dimension.kind) {
    case 'original':
      return { width: size.width, height: size.height }
    case 'fit-long-edge': {
      assertPixelValue(dimension.pixels)

      // Only ever downscales. An image already inside the limit is untouched.
      if (Math.max(size.width, size.height) <= dimension.pixels) {
        return { width: size.width, height: size.height }
      }

      return size.width >= size.height
        ? {
            width: dimension.pixels,
            height: derivedEdge(size.height, size.width, dimension.pixels),
          }
        : {
            width: derivedEdge(size.width, size.height, dimension.pixels),
            height: dimension.pixels,
          }
    }
    case 'fixed-width':
      assertPixelValue(dimension.pixels)

      // Upscales as well as downscales (R-N2).
      return {
        width: dimension.pixels,
        height: derivedEdge(size.height, size.width, dimension.pixels),
      }
    case 'fixed-height':
      assertPixelValue(dimension.pixels)

      return {
        width: derivedEdge(size.width, size.height, dimension.pixels),
        height: dimension.pixels,
      }
    case 'exact':
      assertPixelValue(dimension.width)
      assertPixelValue(dimension.height)

      return { width: dimension.width, height: dimension.height }
    default: {
      const unknown: never = dimension
      throw new RangeError(`unsupported dimension rule: ${JSON.stringify(unknown)}`)
    }
  }
}

/** Reports whether a dimension rule changes the size of an image, i.e. whether pixels are resampled. */
export function needsResize(size: PixelSize, dimension: ResolvedDimension): boolean {
  const target = resolveResizedSize(size, dimension)

  return target.width !== size.width || target.height !== size.height
}
