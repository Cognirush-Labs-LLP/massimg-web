// The decode stage (Technical Design §4.2's first stage for every output path; Functional Design
// R-I9 to R-I16, R-I35). Source bytes in, one upright RGBA `Frame` out.
//
// Three properties this module is responsible for, each of which is quiet when it goes wrong:
//
//   1. **EXIF orientation is applied to the pixels here, before anything else** (R-I9). User
//      rotation composes on the result rather than on the stored pixels (R-I11), which is true by
//      construction: `edit.ts` (T24) only ever sees a frame that is already upright.
//   2. **The output carries no orientation tag** (R-I10). Structural rather than conventional:
//      `Frame` has nowhere to put one, so no later stage can copy one forward.
//   3. **Colour is read as an ICC profile, or as CICP, or as neither** — three states, not two
//      (R-I35, §7.7). ImageMagick reports the first and is silent about the second, so the second
//      is parsed from the source bytes by `colour.ts`.
//
// HEIC is decoded as ordinary input: there is no format switch anywhere below, no capability probe
// and no browser branch (A8 settled that; §10.3).
//
// This module imports `codecs/loader.ts`, so it cannot be unit-tested under Vitest — Vitest
// statically resolves the loader's dynamic `import()` specifiers and `imagequant`'s bare `.wasm`
// import fails under its Node-targeted transform (T22's note). The pure logic therefore lives in
// `frame.ts` and `colour.ts`, which have unit tests, and this module is proven in
// `tests/e2e/decode.spec.ts` on all three engines.

import { ensureImageMagick } from '@/pipeline/codecs/loader'
import { resolveFrameColour } from './colour'
import { classifySourceOrientation, ownsWholeBuffer } from './frame'
import type { Frame } from './frame'

/** Raised when ImageMagick produced no pixels. The worker maps this to `decode-failed`. */
export class DecodeError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'DecodeError'
  }
}

/**
 * Decodes one still image to an upright RGBA frame.
 *
 * `source` is the raw file, exactly as the job carries it — not a re-encoded copy — because the
 * CICP box has to be read from the container and a re-encode is where such a box gets dropped.
 */
export async function decodeFrame(source: Uint8Array): Promise<Frame> {
  const { ImageMagick } = await ensureImageMagick()

  return ImageMagick.read(source, (image) => {
    // Read before `autoOrient()`, which rewrites the field to TopLeft once it has acted. `0` here is
    // `Orientation.Undefined` — no tag at all — and is a different state from a tag that says `1`.
    const sourceOrientation = classifySourceOrientation(image.orientation)

    // ImageMagick's own auto-orientation, measured correct for all eight values including the four
    // mirrored ones (D4). A no-op when the tag is absent or already TopLeft.
    image.autoOrient()

    const profile = image.getColorProfile()
    const colour = resolveFrameColour(
      // Copied, not referenced. `getColorProfile()` hands back `HEAPU8.subarray(...)` — a live
      // window onto ImageMagick's heap — which goes stale the moment the image is disposed or the
      // heap is resized, and whose `.buffer` is the whole codec heap rather than the profile. A
      // frame that outlives this callback holding that view carries bytes that quietly stop being
      // the profile. The e2e caught exactly this: the profile read back was not the one embedded.
      profile ? { profile: new Uint8Array(profile.data), description: profile.description } : null,
      source,
    )

    const width = image.width
    const height = image.height

    const pixels = image.getPixels((collection) =>
      collection.toByteArray(0, 0, width, height, 'RGBA'),
    )

    if (pixels === null) {
      throw new DecodeError('ImageMagick returned no pixels')
    }

    // The frame outlives this callback and the `MagickImage` it came from, and `pipeline/worker.ts`
    // transfers result buffers rather than copying them. A `Uint8Array` that was a window onto the
    // codec heap would, when transferred, detach the whole of ImageMagick's memory and break every
    // later job in this worker. `toByteArray` allocates (it is `HEAPU8.slice`), so this holds today
    // — it is asserted rather than assumed because nothing else in the pipeline would notice if a
    // future version of the binding stopped copying.
    if (!ownsWholeBuffer(pixels)) {
      throw new DecodeError('decoded pixels are a view onto codec memory, not an owned buffer')
    }

    if (colour.kind === 'icc' && !ownsWholeBuffer(colour.profile)) {
      throw new DecodeError('ICC profile is a view onto codec memory, not an owned buffer')
    }

    if (pixels.byteLength !== width * height * 4) {
      throw new DecodeError(
        `decoded ${pixels.byteLength} bytes for a ${width}x${height} RGBA frame`,
      )
    }

    return { width, height, pixels, colour, sourceOrientation }
  })
}
