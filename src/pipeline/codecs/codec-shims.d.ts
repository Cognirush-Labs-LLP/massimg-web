// Ambient types for the codec packages that ship none of their own (same pattern as
// `src/js-yaml.d.ts`: only the shape `loader.ts` actually uses, not the whole library surface —
// T26+ extends these when it needs more).

declare module 'gifsicle-wasm-browser' {
  const gifsicle: unknown
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
