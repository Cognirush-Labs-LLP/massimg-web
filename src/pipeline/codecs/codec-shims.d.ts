// Ambient types for the codec packages that ship none of their own (same pattern as
// `src/js-yaml.d.ts`: only the shape `loader.ts` actually uses, not the whole library surface —
// T26+ extends these when it needs more).

declare module 'gifsicle-wasm-browser' {
  /**
   * One input file. `name` is how the command line refers to it, and the wrapper rejects anything
   * that is not a URL string, a `Blob`, a `File` or an `ArrayBuffer` — **a `Uint8Array` included**,
   * which it reports as `<input.file> types:uint8array`. `gif.ts` passes the underlying buffer.
   */
  export interface GifsicleInput {
    file: ArrayBuffer | Blob
    name: string
  }

  export interface GifsicleRunOptions {
    input: GifsicleInput[]
    /** One entry per gifsicle invocation, run in order. The last must write into `/out`. */
    command: string[]
    /** End on the first error or warning rather than carrying on. Defaults to `false`. */
    isStrict?: boolean
  }

  /**
   * Everything the run left in `/out`.
   *
   * `null` rather than a rejection is what the wrapper resolves with when its internal Worker raises
   * `onerror`, and a *string* rather than an `Error` is what it rejects with when gifsicle itself
   * fails — so `gif.ts` treats all three shapes as one failure.
   */
  const gifsicle: {
    run(options: GifsicleRunOptions): Promise<File[] | null>
  }

  export default gifsicle
}

declare module 'upng-js' {
  const UPNG: unknown
  export default UPNG
}

declare module 'apng-optimizer' {
  export class APNGOptimizer {
    static createOptimizer(modulePath: string): Promise<APNGOptimizer>
  }
}
