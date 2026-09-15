// The ImageMagick thumbnail fallback (Technical Design §10.4): "For a supported input that the
// browser cannot decode natively, use ImageMagick's thumbnail operation as a fallback, not the full
// processing pipeline."
//
// T20 built `thumbnails.ts` with this as an unwired seam because there was no lazy codec loader
// yet; T22 supplied the loader and handed the body to T23 on the grounds that it is decode logic.
// This is that body.
//
// Two things it deliberately is not:
//
//   - It is not the pipeline. `pipeline/stages/decode.ts` produces an RGBA `Frame` for the encode
//     chain; this produces a small encoded Blob for a grid tile. Routing tiles through the pipeline
//     would decode at full resolution and pay §8.1's whole budget for a 384 px thumbnail.
//   - It does not apply the stored edit. `render()` in `thumbnail-render.ts` owns the edit ops and
//     runs them on a canvas; this path is reached only when the engine could not decode the source
//     at all, and it hands back the un-edited thumbnail rather than reimplementing the op walk in a
//     second place where the two could drift apart (Technical Design §6's warning). A tile whose
//     edit cannot be shown is still a better tile than a placeholder.
//
// Kept in its own module rather than inside `thumbnails.ts` so that importing the thumbnail service
// does not pull `codecs/loader.ts` — and through it every codec package — into the importing
// module's graph. `thumbnails.ts` reaches it through a dynamic import at the point of use, which is
// also what keeps §5.2's laziness intact: a batch of ordinary JPEGs never loads ImageMagick here.

import { ensureImageMagick } from '@/pipeline/codecs/loader'
import { fitWithin } from './thumbnail-render'
import type { FallbackDecoder } from './thumbnails'

/**
 * `ThumbnailFormat` is a MIME type; ImageMagick wants its own format name.
 *
 * Keyed by the property name on `MagickFormat`, not by the string value it holds: `MagickFormat` is
 * a const object whose keys are `Jpeg`/`WebP` while its values are `"JPEG"`/`"WEBP"`, so indexing it
 * with the value silently yields `undefined` — and `write(undefined, ...)` still produces bytes, in
 * the wrong format, with no error.
 */
const MAGICK_FORMAT_KEY_FOR: Record<string, 'Jpeg' | 'WebP'> = {
  'image/jpeg': 'Jpeg',
  'image/webp': 'WebP',
}

/**
 * The §10.4 fallback, as a `FallbackDecoder`.
 *
 * Resolves to a Blob in the requested thumbnail format, bounded on both axes by `maxEdge`. Throws
 * if ImageMagick cannot read the source either — `thumbnails.ts` turns that into a placeholder,
 * which R-G10 already declares is not an error.
 */
export function createImageMagickFallbackDecoder(): FallbackDecoder {
  return async ({ blob, source, maxEdge, format, quality }) => {
    const { ImageMagick, MagickFormat } = await ensureImageMagick()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const bound = fitWithin(source, maxEdge)

    const formatKey = MAGICK_FORMAT_KEY_FOR[format]
    if (formatKey === undefined) {
      throw new Error(`no ImageMagick format for ${format}`)
    }
    const magickFormat = MagickFormat[formatKey]

    return ImageMagick.read(bytes, (image) => {
      // Orientation is applied here too. A tile that ignores it is upright in the grid and sideways
      // in the Preview, which reads as a bug in the app rather than in one code path (R-I9).
      image.autoOrient()

      // `resize` rather than `thumbnail`: magick-wasm exposes no `thumbnail` operation, and
      // `thumbnail`'s extra work in the CLI is stripping metadata, which the tile does not carry
      // into anything anyway.
      image.resize(bound.width, bound.height)
      image.quality = Math.round(quality * 100)
      image.strip()

      let encoded: Uint8Array | null = null
      image.write(magickFormat, (data) => {
        // Copied out of the WASM heap before the callback returns: `data` is a view onto codec
        // memory and is invalid the moment ImageMagick reclaims it.
        encoded = new Uint8Array(data)
      })

      if (encoded === null) {
        throw new Error('ImageMagick produced no thumbnail bytes')
      }

      return new Blob([encoded], { type: format })
    })
  }
}
