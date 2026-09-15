// The intermediate representation every pipeline stage shares (Technical Design §4.2): "an RGBA
// frame buffer with dimensions and an optional ICC profile". §7.7 and R-I35 widen the last part —
// colour is carried as *either* an ICC profile *or* CICP values, because HEIC and AVIF commonly
// signal colour with an `nclx` box and no profile at all.
//
// Pure types and pure functions only. Nothing here imports `codecs/loader.ts`, so this module stays
// unit-testable under Vitest; `decode.ts` is the half that touches ImageMagick and is proven in the
// browser instead (the same split as `thumbnail-render.ts` / `thumbnail-worker.ts`).

/**
 * CICP colour signalling: the code points of ITU-T H.273, carried in a HEIF `colr` box of type
 * `nclx`. Values are stored exactly as read — not interpreted, not normalised — so that an encoder
 * that can express them writes back what the source said (R-I35).
 */
export interface Cicp {
  /** H.273 colour primaries. 1 = BT.709, 9 = BT.2020, 12 = Display P3, 2 = unspecified. */
  primaries: number
  /** H.273 transfer characteristics. 13 = sRGB, 16 = PQ, 18 = HLG, 2 = unspecified. */
  transfer: number
  /** H.273 matrix coefficients. 0 = identity/GBR, 1 = BT.709, 6 = BT.601, 2 = unspecified. */
  matrix: number
  /** The `full_range_flag`: whether luma/chroma use the full 0-255 range or the video range. */
  fullRange: boolean
}

/**
 * The value H.273 uses for "unspecified" in all three of its code point tables.
 *
 * An `nclx` box that says this carries no information. It is still a *present* colour signal and is
 * reported as one — collapsing it to `untagged` at decode would throw away the difference between
 * "this file says nothing about its colour" and "this file has no colour box", which is the same
 * class of mistake R-I35 exists to prevent. The encoder decides what to do with it; see
 * `isUnspecifiedCicp`.
 */
export const CICP_UNSPECIFIED = 2

/**
 * Whether every CICP field is "unspecified", i.e. the box is present but describes nothing.
 *
 * For an encoder (T26): writing these values through is faithful to the source and costs nothing;
 * treating them as a reason to convert pixels would be a conversion R-I15 forbids.
 */
export function isUnspecifiedCicp(cicp: Cicp): boolean {
  return (
    cicp.primaries === CICP_UNSPECIFIED &&
    cicp.transfer === CICP_UNSPECIFIED &&
    cicp.matrix === CICP_UNSPECIFIED
  )
}

/**
 * How the source described its colour. Three cases, never two nullable fields:
 *
 * - `icc` — an embedded ICC profile. Preserved verbatim where the output format can carry one
 *   (R-I12), used to convert to sRGB where it cannot (R-I13).
 * - `cicp` — an `nclx` box and no profile. Honoured and carried, or resolved into the pixels
 *   (R-I35). **Not** the same as untagged: treating it as untagged sRGB is the silent colour shift
 *   §7.7 is written to prevent.
 * - `untagged` — neither. Treated as sRGB, and no profile is added to the output (R-I14).
 *
 * Pixel values are never converted between colour spaces on the strength of this (R-I15). It
 * travels with the frame and the encoder reads it.
 */
export type FrameColour =
  | { kind: 'icc'; profile: Uint8Array; description: string | null }
  | { kind: 'cicp'; cicp: Cicp }
  | { kind: 'untagged' }

/**
 * Which of the three EXIF orientation states the source was in.
 *
 * Absent, present-and-default and present-and-unusual are three different things, and the
 * characteristic bug in this territory is code that collapses them. Nothing downstream reads this —
 * the pixels are already upright by the time a `Frame` exists — it is carried so the distinction is
 * observable rather than implicit.
 */
export type SourceOrientation =
  /** No EXIF orientation tag at all. */
  | { kind: 'absent' }
  /** A tag was present. `1` says upright; `2` to `8` asked for a transform, four of them mirrored. */
  | { kind: 'present'; value: OrientationValue }

export type OrientationValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** The four orientation values whose transform includes a reflection. */
const MIRRORED_ORIENTATIONS: ReadonlySet<number> = new Set([2, 4, 5, 7])

/** Whether this value's transform is a reflection rather than a rotation. */
export function isMirroredOrientation(value: OrientationValue): boolean {
  return MIRRORED_ORIENTATIONS.has(value)
}

/**
 * Reads ImageMagick's `Orientation` enum into the three-state form.
 *
 * `Orientation.Undefined` is `0`, which is what a file with no EXIF orientation tag reports — and
 * also what a file whose EXIF has no orientation entry reports. Both are genuinely "absent". A
 * value outside 0-8 cannot come from a conforming file and is treated as absent rather than trusted.
 */
export function classifySourceOrientation(value: number): SourceOrientation {
  return Number.isInteger(value) && value >= 1 && value <= 8
    ? { kind: 'present', value: value as OrientationValue }
    : { kind: 'absent' }
}

/**
 * One decoded image, upright, in 8-bit RGBA.
 *
 * There is deliberately **no orientation field**: EXIF orientation has already been applied to the
 * pixels by the time a frame exists (R-I9), and a representation with nowhere to put a tag is what
 * structurally guarantees R-I10 — no later stage can copy one to the output, because there is
 * nothing to copy.
 *
 * There is also no `hasAlpha`: an alpha *channel* is not evidence of transparency (D5, and the
 * reason R-C13 requires a pixel-level test), so a boolean here would be read as an answer to a
 * question it does not answer.
 */
export interface Frame {
  width: number
  height: number
  /**
   * Row-major RGBA, 4 bytes per pixel, `width * height * 4` long.
   *
   * **Owned.** Never a view onto a codec's WASM heap. `pipeline/worker.ts` transfers result buffers
   * in its `postMessage` transfer list, and transferring a view onto ImageMagick's memory would
   * detach the entire codec heap rather than just the output, breaking every later job in that
   * worker. `decode.ts` asserts this rather than trusting it.
   */
  pixels: Uint8Array
  colour: FrameColour
  sourceOrientation: SourceOrientation
}

/** Whether `pixels` owns its whole buffer, i.e. is not a window onto something larger. */
export function ownsWholeBuffer(pixels: Uint8Array): boolean {
  return pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength
}
