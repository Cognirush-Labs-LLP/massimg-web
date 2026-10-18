import { afterEach, describe, expect, it } from 'vitest'
import { t } from './t'
import { getLocale, isRtl, setLocale } from './locale'

afterEach(() => {
  setLocale('en')
})

describe('locale switching', () => {
  it('defaults to "en", which is not RTL', () => {
    expect(getLocale()).toBe('en')
    expect(isRtl()).toBe(false)
  })

  it('switches t() output to the pseudo locale', () => {
    expect(t('gallery.title')).toBe('SELECTED IMAGES')
    setLocale('pseudo')
    expect(getLocale()).toBe('pseudo')
    const pseudo = t('gallery.title')
    expect(pseudo).not.toBe('SELECTED IMAGES')
    // Bidi override marks wrap the literal English text rather than replacing it, so a
    // translator-less pseudo render still contains the real characters (R-L4's RTL test
    // mirrors layout, not legibility).
    expect(pseudo).toContain('SELECTED IMAGES')
  })

  it('still interpolates {param} placeholders under the pseudo locale (R-L5)', () => {
    setLocale('pseudo')
    expect(t('action.compressLabel', { count: 6 })).toContain('Compress (6)')
  })

  it('reports the pseudo locale as RTL and "en" as not', () => {
    expect(isRtl('pseudo')).toBe(true)
    expect(isRtl('en')).toBe(false)
  })
})
