// `apng-optimizer` ships no types (§7.1 chose it anyway: ISC, 276 KB, and the only APNG optimiser
// in the set — A6). Declared here the same way `upng-js.d.ts` is: only the surface this codebase
// actually calls.
//
// Two things the declaration cannot express and the call sites must know (both measured in T29):
//
//   - **`optAPNG` strips an `iCCP` chunk** from the APNG it is given, along with `sRGB`. The profile
//     is attached afterwards, which is D3's recorded ordering.
//   - **`minQuality` is a request, not a floor.** Unlike libimagequant's own API, which refuses to
//     produce anything it cannot bring up to its `minimum` (T27, D8), this one neither throws nor
//     reports when the request cannot be met — it returns a file regardless, sometimes a much larger
//     one. `optAPNG` throws only when the optimiser produced nothing at all.

declare module 'apng-optimizer' {
  export interface OptAPNGOptions {
    /** 0 zlib, 1 7zip (the library default), 2 zopfli. See `APNG_DEFLATE_METHOD`. */
    deflateMethod?: number
    /** Deflate iterations; the library default is 15. See `APNG_DEFLATE_ITERATIONS`. */
    iter?: number
    /** libimagequant's lower quality bound, 0-100. **Not enforced** — see the note above. */
    minQuality?: number
    /** libimagequant's upper quality bound, 0-100. */
    maxQuality?: number
    /** `true` turns the quantizer off entirely, which is the lossless branch. */
    disabledQuant?: boolean
    processCallback?: (progress: number) => void
  }

  export class APNGOptimizer {
    static createOptimizer(modulePath: string): Promise<APNGOptimizer>
    checkReady(): Promise<unknown>
    /** Throws only when the optimiser returned no bytes at all. */
    optAPNG(apng: Uint8Array, options?: OptAPNGOptions): Uint8Array
  }
}
