import { describe, expect, it } from 'vitest'

import { defaultLocale, resolveSiteBaseUrl, supportedLocales } from './site'

describe('resolveSiteBaseUrl', () => {
  it('falls back to a non-production placeholder when unset', () => {
    expect(resolveSiteBaseUrl(undefined)).toBe('https://site-base-url-not-set.invalid')
    expect(resolveSiteBaseUrl('')).toBe('https://site-base-url-not-set.invalid')
    expect(resolveSiteBaseUrl('   ')).toBe('https://site-base-url-not-set.invalid')
  })

  it('trims a trailing slash so paths can be appended without double slashes', () => {
    expect(resolveSiteBaseUrl('https://massimg.com/')).toBe('https://massimg.com')
    expect(resolveSiteBaseUrl('https://massimg.com///')).toBe('https://massimg.com')
  })

  it('trims surrounding whitespace and passes a clean URL through unchanged', () => {
    expect(resolveSiteBaseUrl('  https://massimg.com  ')).toBe('https://massimg.com')
    expect(resolveSiteBaseUrl('https://massimg.com')).toBe('https://massimg.com')
  })
})

describe('supportedLocales / defaultLocale', () => {
  it('lists the default locale among the supported locales', () => {
    expect(supportedLocales.some((locale) => locale.code === defaultLocale)).toBe(true)
  })

  it('ships only English today, matching src/i18n/ and content/', () => {
    expect(supportedLocales.map((locale) => locale.code)).toEqual(['en'])
  })
})
