// The resize stage (Technical Design §4.2; Functional Design §4.2, R-N1, R-N2, R-D1, R-D4). One
// edited `Frame` in, the frame at the dimension rule's size out.
//
// Three properties this module is responsible for:
//
//   1. **The output size is `resolveResizedSize`'s, exactly.** The arithmetic lives in
//      `domain/dimension.ts` so that the Preview readout and R-X45 get the same numbers without
//      decoding, and ImageMagick is told to hit that size with the aspect ratio ignored — it never
//      rounds a second time.
//   2. **An image that needs no resize is not touched.** The same frame object comes back, no pixel
//      is resampled and ImageMagick is not even loaded. That covers every cropped image (R-D1 —
//      `resolveSettings` has already made the rule `original`), an image already inside a
//      fit-within limit, and a fixed edge the image already has.
//   3. **The filter is chosen here, not by ImageMagick.** Lanczos to shrink, Mitchell to enlarge:
//      ImageMagick's own recommendation, pinned because its automatic choice falls back to Mitchell
//      for any image with an alpha channel, and a raw RGBA read always has one.
//
// Resampling happens on the frame's encoded values. No color conversion, linear light included,
// happens here (R-I15). ImageMagick weights by alpha while resizing, so fully transparent pixels
// do not bleed their color into the edges of a `preserve` output.
//
// This module imports `codecs/loader.ts`, so it cannot be unit-tested under Vitest (T22's note); the
// arithmetic is unit-tested in `domain/dimension.spec.ts` and this module is proven in
// `tests/e2e/resize.spec.ts` on all three engines.
//
// **Ownership.** Like `edit.ts`, `applyResize` consumes the frame it is given. A new frame's pixels
// are an owned buffer, so `pipeline/worker.ts` may transfer them.

import { resolveResizedSize } from '@/domain/dimension'
import type { ResolvedDimension } from '@/domain/types'
import { ensureImageMagick } from '@/pipeline/codecs/loader'
import { ownsWholeBuffer } from './frame'
import type { Frame } from './frame'

/** Raised when ImageMagick produced no usable pixels. */
export class ResizeError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'ResizeError'
  }
}

/**
 * Applies a resolved dimension rule to a frame.
 *
 * `dimension` is `ResolvedSettings.dimension`, already `original` for a cropped image. Pass the
 * frame the edit stage returned, so a rotated image is measured on its rotated size (R-D4).
 */
export async function applyResize(frame: Frame, dimension: ResolvedDimension): Promise<Frame> {
  const target = resolveResizedSize(frame, dimension)

  if (target.width === frame.width && target.height === frame.height) {
    return frame
  }

  const { ImageMagick, MagickFormat, MagickGeometry, MagickReadSettings, FilterType } =
    await ensureImageMagick()
  const enlarging = target.width * target.height > frame.width * frame.height
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: frame.width,
    height: frame.height,
    depth: 8,
  })

  const pixels = ImageMagick.read(frame.pixels, settings, (image) => {
    const geometry = new MagickGeometry(target.width, target.height)
    // The domain has already fixed both edges; ImageMagick must not refit them to the aspect ratio.
    geometry.ignoreAspectRatio = true
    image.resize(geometry, enlarging ? FilterType.Mitchell : FilterType.Lanczos)

    if (image.width !== target.width || image.height !== target.height) {
      throw new ResizeError(
        `resized to ${image.width}x${image.height}, expected ${target.width}x${target.height}`,
      )
    }

    return image.getPixels((collection) =>
      collection.toByteArray(0, 0, target.width, target.height, 'RGBA'),
    )
  })

  if (pixels === null) {
    throw new ResizeError('ImageMagick returned no pixels')
  }

  // Same guard as `decode.ts`: a view onto the codec heap, transferred by the worker, would detach
  // all of ImageMagick's memory rather than just this frame.
  if (!ownsWholeBuffer(pixels)) {
    throw new ResizeError('resized pixels are a view onto codec memory, not an owned buffer')
  }

  if (pixels.byteLength !== target.width * target.height * 4) {
    throw new ResizeError(
      `resized to ${pixels.byteLength} bytes for a ${target.width}x${target.height} RGBA frame`,
    )
  }

  return { ...frame, width: target.width, height: target.height, pixels }
}
