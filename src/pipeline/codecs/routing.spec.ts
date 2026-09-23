import { describe, expect, it } from 'vitest'
import { codecsForSettings } from './routing'
import type { Format } from '@/domain/types'

// Technical Design §5.2's table as a fixture. The `ensure*` functions themselves fetch real WASM and
// are proven in the browser (tests/e2e/codecs.spec.ts) — this is the pure routing rule underneath
// them, which is the part a unit test can check exhaustively and cheaply.
//
// Most rows are keyed off the *output* format. The exception, added in T29, is an animated PNG
// source: it needs UPNG to be decoded at all, whatever it is written as.
const JPEG_SOURCE: Format = 'jpeg'

describe('codecsForSettings', () => {
  it('always needs ImageMagick', () => {
    expect(
      codecsForSettings({ format: 'jpeg', sourceFormat: JPEG_SOURCE, isAnimated: false }),
    ).toContain('imagemagick')
  })

  it('needs only ImageMagick for JPEG, WebP and AVIF', () => {
    for (const format of ['jpeg', 'webp', 'avif'] as const) {
      expect(codecsForSettings({ format, sourceFormat: JPEG_SOURCE, isAnimated: false })).toEqual([
        'imagemagick',
      ])
      // Animation on these formats doesn't change the codec set — WebP animated stays a WebP encode,
      // not a PNG one.
      expect(codecsForSettings({ format, sourceFormat: 'gif', isAnimated: true })).toEqual([
        'imagemagick',
      ])
    }
  })

  it('needs gifsicle for GIF output, regardless of animation', () => {
    expect(codecsForSettings({ format: 'gif', sourceFormat: 'gif', isAnimated: true })).toEqual([
      'imagemagick',
      'gifsicle',
    ])
    expect(codecsForSettings({ format: 'gif', sourceFormat: 'gif', isAnimated: false })).toEqual([
      'imagemagick',
      'gifsicle',
    ])
  })

  it('needs oxipng and the quantizer for still PNG output', () => {
    expect(codecsForSettings({ format: 'png', sourceFormat: 'png', isAnimated: false })).toEqual([
      'imagemagick',
      'oxipng',
      'quantizer',
    ])
  })

  it('needs UPNG and apng-optimizer for animated PNG output, not oxipng or the quantizer', () => {
    const codecs = codecsForSettings({ format: 'png', sourceFormat: 'gif', isAnimated: true })
    expect(codecs).toEqual(['imagemagick', 'upng', 'apngOptimizer'])
    expect(codecs).not.toContain('oxipng')
    expect(codecs).not.toContain('quantizer')
  })

  // T29: ImageMagick returns one frame from a six-frame APNG without raising anything, so UPNG is
  // the *decoder* on that path. An APNG going to animated WebP therefore needs it even though the
  // output has nothing to do with PNG.
  it('needs UPNG for an animated PNG source whatever the output format is', () => {
    for (const format of ['webp', 'gif'] as const) {
      expect(codecsForSettings({ format, sourceFormat: 'png', isAnimated: true })).toContain('upng')
    }
  })

  it('does not add UPNG twice when the source and the output are both animated PNG', () => {
    const codecs = codecsForSettings({ format: 'png', sourceFormat: 'png', isAnimated: true })

    expect(codecs).toEqual(['imagemagick', 'upng', 'apngOptimizer'])
    expect(codecs.filter((name) => name === 'upng')).toHaveLength(1)
  })

  // A still PNG decodes through ImageMagick like anything else; only the animated one needs UPNG.
  it('does not need UPNG for a still PNG source', () => {
    expect(codecsForSettings({ format: 'webp', sourceFormat: 'png', isAnimated: false })).toEqual([
      'imagemagick',
    ])
  })
})
