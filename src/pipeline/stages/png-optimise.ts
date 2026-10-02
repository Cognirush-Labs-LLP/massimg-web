// The raw-byte half of PNG encoding: lossless recompression through oxipng without decoding the
// image. Still PNG uses this after ImageMagick or libimagequant writes a candidate; APNG uses it
// after its animation-specific optimiser; and R-Q2 uses it directly when a PNG source already
// satisfies a generous size target. Keeping one entry point prevents those paths from drifting on
// oxipng options or ownership checks.

import { ensureOxipng } from '@/pipeline/codecs/loader'
import { EncodeError } from './encode'
import { ownsWholeBuffer } from './frame'
import { oxipngOptions } from './png-plan'

/** Losslessly recompresses a complete PNG or APNG file with the shipped oxipng build. */
export async function optimisePngBytes(png: Uint8Array): Promise<Uint8Array> {
  const oxipng = await ensureOxipng()
  const bytes = new Uint8Array(
    await oxipng.optimiseWithOxipng(
      png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
      oxipngOptions(),
    ),
  )

  if (bytes.byteLength === 0) {
    throw new EncodeError('oxipng produced no bytes')
  }

  if (!ownsWholeBuffer(bytes)) {
    throw new EncodeError('oxipng bytes are a view onto codec memory, not an owned buffer')
  }

  return bytes
}

/**
 * Applies oxipng but never lets the optimisation make a PNG larger. A tie keeps the input, both to
 * avoid a pointless byte replacement and so R-Q2 can report `original-kept` truthfully.
 */
export async function optimisePngBytesKeepingSmaller(png: Uint8Array): Promise<Uint8Array> {
  const optimised = await optimisePngBytes(png)
  return optimised.byteLength < png.byteLength ? optimised : png
}
