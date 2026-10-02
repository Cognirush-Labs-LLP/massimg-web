// The edit stage (Technical Design §4.2, §6; Functional Design R-C1 to R-C17). One upright `Frame`
// in, the edited frame out, with any transparency flattened for an output format that has no alpha.
//
// Three properties this module is responsible for:
//
//   1. **`EditRecord.ops` is walked in array order, generically** (§3.5). Each op sees the frame the
//      previous op produced, exactly as `resolveEditedSize` in `domain/edit.ts` walks sizes, so the
//      pipeline and the arithmetic cannot disagree about what a list of ops produces. Nothing here
//      assumes the rotate-then-crop pair the interface happens to store.
//   2. **Crop placement comes from `resolveCropOutput`** — the only place a crop's output size and
//      offsets are computed. The same function sizes the thumbnail and the Edit-mode readout, so
//      the output is the size the user was shown, to the pixel, spill included (R-C9).
//   3. **Alpha is flattened after the ops, and only surviving transparency is disclosed** (R-C14,
//      R-C17, R-X46). Under `flatten` the spill is filled opaque, so a transparent stored background
//      cannot raise the caveat and neither can a transparent region the crop discarded.
//
// Pure TypeScript over the RGBA buffer, no codec: quarter turns, offset copies and a solid fill are
// integer byte moves, and doing them here keeps this module out of `codecs/loader.ts` and therefore
// unit-testable. The frame arriving here is already EXIF-upright (T23), so user rotation composes on
// the corrected image by construction (R-I11).
//
// **Ownership.** `applyEdit` consumes the frame it is given: flattening writes into whichever buffer
// is current, which is the input's own when no op replaced it. Decoded pixels are the binding memory
// cost (§8.1) and a defensive copy of a 50 MP frame is 200 MB. Every buffer this stage allocates is
// owned outright, so `pipeline/worker.ts` may transfer it.

import { hasSpill, resolveCropOutput } from '@/domain/edit'
import type { AlphaHandling, Caveat, EditOp, EditRecord, Rgba } from '@/domain/types'
import { ownsWholeBuffer } from './frame'
import type { Frame } from './frame'

/** Raised for an operation this build does not understand. A silently unedited output is worse. */
export class EditError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'EditError'
  }
}

export interface EditStageResult {
  frame: Frame
  /** At most `transparency-flattened`; the stage produces no other caveat. */
  caveats: Caveat[]
}

type CropOp = Extract<EditOp, { kind: 'crop' }>

/**
 * A 32-bit view of the frame's pixels, one element per pixel. Byte order is irrelevant because whole
 * pixels are only ever moved, never interpreted, through this view.
 */
function pixelView(pixels: Uint8Array): Uint32Array {
  return new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4)
}

/**
 * Guarantees the `Frame` contract before anything is written: an owned buffer, which is also
 * 4-byte aligned as a `Uint32Array` view requires. A frame from `decodeFrame` already is, so this
 * copies nothing on the pipeline's own path; it stops a view onto someone else's memory from being
 * flattened in place or passed on as if it were owned.
 */
function owned(frame: Frame): Frame {
  return ownsWholeBuffer(frame.pixels) ? frame : { ...frame, pixels: new Uint8Array(frame.pixels) }
}

function channelByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)))
}

/** `Rgba` carries r, g, b as 0-255 and alpha as 0-1 (the CSS convention the colour picker uses). */
function rgbaBytes({ r, g, b, a }: Rgba): [number, number, number, number] {
  return [channelByte(r), channelByte(g), channelByte(b), channelByte(a * 255)]
}

/** Packs four bytes into one pixel value in this platform's byte order. */
function packPixel(bytes: readonly number[]): number {
  const packed = new Uint32Array(1)
  new Uint8Array(packed.buffer).set(bytes)
  return packed[0]!
}

/** Clockwise quarter turns, matching `rotateSize` in `domain/edit.ts` and the thumbnail renderer. */
function rotate(frame: Frame, quarterTurns: 0 | 1 | 2 | 3): Frame {
  if (quarterTurns === 0) {
    return frame
  }

  const { width, height } = frame
  const source = pixelView(frame.pixels)
  const pixels = new Uint8Array(frame.pixels.byteLength)
  const target = pixelView(pixels)

  if (quarterTurns === 2) {
    target.set(source)
    target.reverse()
    return { ...frame, pixels }
  }

  // Output is `height` wide. A source pixel (x, y) lands at column `height - 1 - y`, row `x` on a
  // clockwise turn, and at column `y`, row `width - 1 - x` on an anticlockwise one.
  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width
    const column = quarterTurns === 1 ? height - 1 - y : y

    for (let x = 0; x < width; x += 1) {
      const row = quarterTurns === 1 ? x : width - 1 - x
      target[row * height + column] = source[sourceRow + x]!
    }
  }

  return { ...frame, width: height, height: width, pixels }
}

function crop(frame: Frame, op: CropOp, alpha: AlphaHandling): Frame {
  const output = resolveCropOutput(op.rect, { width: frame.width, height: frame.height })
  const { width, height } = output.size
  const { offsetX, offsetY } = output.placement

  if (width === frame.width && height === frame.height && offsetX === 0 && offsetY === 0) {
    return frame
  }

  const pixels = new Uint8Array(width * height * 4)

  if (hasSpill(output.spill)) {
    // R-C14/R-C15: the stored alpha is kept in the record but exported opaque while the output
    // format has none, which is `opaque()` in `domain/job.ts` applied at the point of use.
    const fill = alpha.kind === 'flatten' ? { ...op.background, a: 1 } : op.background
    pixelView(pixels).fill(packPixel(rgbaBytes(fill)))
  }

  // The intersection of the placed source with the output raster, in output coordinates. It can be
  // empty: at low zoom R-C12 keeps the rectangle inside the frame, not over the image, so a crop can
  // sit wholly beside the image and produce nothing but fill. An empty span must copy nothing —
  // a negative length would turn `subarray`'s end into a from-the-end index.
  const firstColumn = Math.max(0, offsetX)
  const endColumn = Math.min(width, offsetX + frame.width)
  const firstRow = Math.max(0, offsetY)
  const endRow = Math.min(height, offsetY + frame.height)

  if (endColumn <= firstColumn || endRow <= firstRow) {
    return { ...frame, width, height, pixels }
  }

  for (let row = firstRow; row < endRow; row += 1) {
    const sourceStart = ((row - offsetY) * frame.width + (firstColumn - offsetX)) * 4
    const sourceEnd = sourceStart + (endColumn - firstColumn) * 4
    pixels.set(frame.pixels.subarray(sourceStart, sourceEnd), (row * width + firstColumn) * 4)
  }

  return { ...frame, width, height, pixels }
}

function applyOp(frame: Frame, op: EditOp, alpha: AlphaHandling): Frame {
  switch (op.kind) {
    case 'rotate':
      return rotate(frame, op.quarterTurns)
    case 'crop':
      return crop(frame, op, alpha)
    case 'resize':
      throw new EditError('a recovery resize must be resolved after geometry editing')
    default: {
      const unknown: never = op
      throw new EditError(`unsupported edit operation: ${JSON.stringify(unknown)}`)
    }
  }
}

/**
 * Composites every non-opaque pixel over `background`, in place, in straight alpha and in the
 * frame's encoded values. Returns whether any pixel was non-opaque, which is what R-X46 means by
 * "had transparent pixels" — a pixel-level test, never a channel check (D5).
 */
function flatten(pixels: Uint8Array, background: Rgba): boolean {
  const [red, green, blue] = rgbaBytes(background)
  let flattened = false

  for (let index = 3; index < pixels.length; index += 4) {
    const a = pixels[index]!

    if (a === 255) {
      continue
    }

    flattened = true
    const inverse = 255 - a
    // round(n / 255) for a non-negative integer n is exactly floor((n + 127) / 255).
    pixels[index - 3] = ((pixels[index - 3]! * a + red * inverse + 127) / 255) | 0
    pixels[index - 2] = ((pixels[index - 2]! * a + green * inverse + 127) / 255) | 0
    pixels[index - 1] = ((pixels[index - 1]! * a + blue * inverse + 127) / 255) | 0
    pixels[index] = 255
  }

  return flattened
}

/**
 * Applies an image's stored edit, then the output format's alpha handling.
 *
 * `alpha` is `ResolvedSettings.alpha`, already resolved per image by `domain/job.ts`: `flatten`
 * carries the opaque fill (the crop background, or white outside Edit mode per R-C17). The colour
 * is written as given, in the frame's own colour space — never converted (R-I15).
 *
 * Consumes `frame`; see the ownership note at the top of this module.
 */
export function applyEdit(
  frame: Frame,
  edit: EditRecord | null,
  alpha: AlphaHandling,
): EditStageResult {
  let current = owned(frame)

  for (const op of edit?.ops ?? []) {
    current = applyOp(current, op, alpha)
  }

  if (alpha.kind === 'flatten' && flatten(current.pixels, alpha.background)) {
    return {
      frame: current,
      caveats: [{ kind: 'transparency-flattened', fill: alpha.background }],
    }
  }

  return { frame: current, caveats: [] }
}
