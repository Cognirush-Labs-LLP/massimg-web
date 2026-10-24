import { describe, expect, it } from 'vitest'
import { operator } from '@/config/site'
import { loadRawContent, substituteOperatorTokens } from './content'

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

describe('substituteOperatorTokens', () => {
  it('replaces every occurrence, including inside a link target', () => {
    const out = substituteOperatorTokens(
      '[{{supportEmail}}](mailto:{{supportEmail}}) and [src]({{sourceUrl}})',
    )

    expect(out).toBe(
      `[${operator.supportEmail}](mailto:${operator.supportEmail}) and [src](${operator.sourceUrl})`,
    )
  })

  it('resolves all four operator values', () => {
    const out = substituteOperatorTokens(
      '{{legalName}}|{{supportEmail}}|{{sourceUrl}}|{{desktopDownloadUrl}}',
    )

    expect(out).toBe(
      [operator.legalName, operator.supportEmail, operator.sourceUrl, operator.desktopDownloadUrl].join('|'),
    )
  })

  it('throws on an unknown token instead of rendering it', () => {
    expect(() => substituteOperatorTokens('write to {{supportEmal}}')).toThrow(/supportEmal/)
  })

  it('leaves text without tokens untouched', () => {
    expect(substituteOperatorTokens('no tokens, {single} braces')).toBe('no tokens, {single} braces')
  })
})

describe('shipped content pages', () => {
  it.each(['faq', 'privacy', 'terms', 'desktop'] as const)(
    '%s has no unresolved token after loading',
    (page) => {
      expect(loadRawContent('en', page)).not.toMatch(/\{\{\w*\}\}/)
    },
  )
})
