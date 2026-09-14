import { describe, expect, it } from 'vitest'
import { t } from './t'

describe('t()', () => {
  it('looks up a plain string key with no interpolation', () => {
    expect(t('gallery.title')).toBe('Your Images')
  })

  it('renders an uppercase section-heading-style key verbatim', () => {
    expect(t('panel.section.quality')).toBe('QUALITY')
  })

  it('interpolates a single {param} placeholder (R-L5)', () => {
    expect(t('action.compressLabel', { count: 6 })).toBe('Compress (6)')
  })

  it('re-interpolates with a different value, proving it is not hardcoded', () => {
    expect(t('action.compressLabel', { count: 1 })).toBe('Compress (1)')
  })

  it('throws when a required interpolation param is missing', () => {
    expect(() => t('action.compressLabel', {})).toThrow(/count/)
  })

  it('throws for an unknown key at runtime', () => {
    // @ts-expect-error deliberately passing a key that does not exist in
    // messages.json, to exercise the runtime guard — MessageKey rejects this
    // at compile time for any real caller.
    expect(() => t('nonexistent.key')).toThrow(/nonexistent\.key/)
  })
})
