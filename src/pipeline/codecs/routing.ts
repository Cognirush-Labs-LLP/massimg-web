// The pure half of §5.2's table — which codec modules a job's settings require. Kept separate from
// `loader.ts`, which does the actual (WASM-fetching) loading, for the same reason
// `platform/thumbnail-render.ts` is kept separate from `platform/thumbnail-worker.ts`: a Vitest run
// statically resolves every import a test file's module graph touches, including the dynamic
// `import()` specifiers inside `loader.ts`, and at least one of those packages (`imagequant`, a
// wasm-bindgen "bundler" target module with a bare `import * as wasm from './x_bg.wasm'`) fails to
// resolve under Vitest's Node-targeted transform even though it resolves correctly for the real
// browser build. Keeping the pure routing rule in its own module lets it be unit-tested without ever
// reaching that import.

import type { ResolvedSettings } from '@/domain/types'

export type CodecName =
  'imagemagick' | 'gifsicle' | 'oxipng' | 'quantizer' | 'upng' | 'apngOptimizer'

/**
 * Technical Design §5.2's table, as code. Pure. ImageMagick decodes, orients, edits and resizes
 * almost every path in §4.2's stage table, so it is always required; the rest are additive per
 * output format — with one exception, which is the source format rather than the output.
 *
 * **An animated PNG *source* needs UPNG whatever it is written as.** ImageMagick's WASM build
 * returns one frame from a six-frame APNG and raises nothing (measured, T29; D6 predicted it of the
 * still reader), so `stages/animation.ts` decodes APNG through UPNG — which makes UPNG a decoder on
 * that path and not only the assembler §5.2's table describes. Without this row an APNG going to
 * animated WebP would reach `decodeAnimation` with UPNG unloaded; the stage's own `ensureUpng()`
 * would then load it mid-job, which works but defeats the point of loading codecs up front.
 */
export function codecsForSettings(
  settings: Pick<ResolvedSettings, 'format' | 'isAnimated' | 'sourceFormat'>,
): CodecName[] {
  const codecs: CodecName[] = ['imagemagick']

  if (settings.format === 'gif') {
    codecs.push('gifsicle')
  } else if (settings.format === 'png') {
    if (settings.isAnimated) {
      codecs.push('upng', 'apngOptimizer')
    } else {
      codecs.push('oxipng', 'quantizer')
    }
  }

  if (settings.isAnimated && settings.sourceFormat === 'png' && !codecs.includes('upng')) {
    codecs.push('upng')
  }

  return codecs
}
