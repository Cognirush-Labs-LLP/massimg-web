import { describe, expect, it } from 'vitest'
import { codecsForSettings } from './routing'

// Technical Design §5.2's table as a fixture. The `ensure*` functions themselves fetch real WASM and
// are proven in the browser (tests/e2e/codecs.spec.ts) — this is the pure routing rule underneath
// them, which is the part a unit test can check exhaustively and cheaply.
describe('codecsForSettings', () => {
  it('always needs ImageMagick', () => {
    expect(codecsForSettings({ format: 'jpeg', isAnimated: false })).toContain('imagemagick')
  })

  it('needs only ImageMagick for JPEG, WebP and AVIF', () => {
    for (const format of ['jpeg', 'webp', 'avif'] as const) {
      expect(codecsForSettings({ format, isAnimated: false })).toEqual(['imagemagick'])
      // Animation on these formats doesn't change the codec set — WebP animated stays a WebP encode,
      // not a PNG one.
      expect(codecsForSettings({ format, isAnimated: true })).toEqual(['imagemagick'])
    }
  })

  it('needs gifsicle for GIF output, regardless of animation', () => {
    expect(codecsForSettings({ format: 'gif', isAnimated: true })).toEqual([
      'imagemagick',
      'gifsicle',
    ])
    expect(codecsForSettings({ format: 'gif', isAnimated: false })).toEqual([
      'imagemagick',
      'gifsicle',
    ])
  })

  it('needs oxipng and the quantizer for still PNG output', () => {
    expect(codecsForSettings({ format: 'png', isAnimated: false })).toEqual([
      'imagemagick',
      'oxipng',
      'quantizer',
    ])
  })

  it('needs UPNG and apng-optimizer for animated PNG output, not oxipng or the quantizer', () => {
    const codecs = codecsForSettings({ format: 'png', isAnimated: true })
    expect(codecs).toEqual(['imagemagick', 'upng', 'apngOptimizer'])
    expect(codecs).not.toContain('oxipng')
    expect(codecs).not.toContain('quantizer')
  })
})
