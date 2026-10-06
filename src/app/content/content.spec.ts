import { describe, expect, it } from 'vitest'
import { loadRawContent } from './content'

describe('loadRawContent', () => {
  it('loads the English file for a known page', () => {
    const raw = loadRawContent('en', 'faq')

    expect(raw).toContain('Frequently Asked Questions')
  })

  it('falls back to the default locale when the requested locale has no file (R-S5)', () => {
    const fallback = loadRawContent('xx-not-a-real-locale', 'faq')
    const english = loadRawContent('en', 'faq')

    expect(fallback).toBe(english)
  })

  it('throws if even the default locale is missing the page (authoring bug)', () => {
    // @ts-expect-error — deliberately an invalid page id to exercise the error path.
    expect(() => loadRawContent('en', 'not-a-real-page')).toThrow()
  })
})
