// `upng-js` ships no types (§7.1 chose it anyway: pure JS, MIT, and the only APNG assembler in the
// set — A5). Declared here the same way `js-yaml.d.ts` is: only the surface this codebase actually
// calls, so an unused corner of the library cannot be typed wrongly without anyone noticing.
//
// `decode` and `toRGBA8` are here because **ImageMagick's WASM build cannot decode an APNG** —
// `readCollection` returns one frame from a six-frame file, silently (measured; D6 warned of it for
// the still reader). `encode` is the assembler §4.2's animated-PNG row is built on (A5).

declare module 'upng-js' {
  /** The `fcTL` fields, as UPNG reports them after its own parse. */
  export interface UpngFrame {
    /** Milliseconds. UPNG has already resolved `delay_num`/`delay_den`, including `den === 0`. */
    delay: number
    /** APNG `dispose_op`: 0 none, 1 background, 2 previous. */
    dispose: number
    /** APNG `blend_op`: 0 source, 1 over. */
    blend: number
    rect: { x: number; y: number; width: number; height: number }
  }

  export interface UpngImage {
    width: number
    height: number
    depth: number
    /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
    ctype: number
    frames: UpngFrame[]
    /** Ancillary chunks UPNG understood. `acTL` is absent for a still PNG. */
    tabs: { acTL?: { num_frames: number; num_plays: number } }
  }

  export function decode(buffer: ArrayBuffer): UpngImage

  /**
   * One RGBA `ArrayBuffer` per frame, each `width * height * 4` bytes and **already composited**:
   * UPNG applies `dispose_op` and `blend_op` itself, so these are coalesced full-canvas frames and
   * not the stored sub-rectangles.
   *
   * Each buffer is its own allocation — UPNG copies between frames — so a frame may be handed on
   * without a defensive copy.
   */
  export function toRGBA8(image: UpngImage): ArrayBuffer[]

  /**
   * Assembles RGBA frames into an APNG (A5).
   *
   * `dels` are **milliseconds**, written as `delay_num` with `delay_den` fixed at 1000 — so a delay
   * past 65,535 wraps silently in the `uint16`, which is what `setApngFrameDelays` exists to repair.
   * `cnum` of 0 is lossless; quantization is apng-optimizer's job here (A6, §7.1).
   *
   * **`acTL.num_plays` is hardcoded to 0**, whatever the animation asked for, so every file this
   * produces loops for ever until `setApngLoopCount` patches it.
   */
  export function encode(
    frames: ArrayBuffer[],
    width: number,
    height: number,
    cnum: number,
    delaysMs: number[],
  ): ArrayBuffer

  const UPNG: {
    decode: typeof decode
    toRGBA8: typeof toRGBA8
    encode: typeof encode
  }

  export default UPNG
}
