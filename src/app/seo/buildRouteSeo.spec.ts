import { describe, expect, it } from 'vitest'
import type { Script } from '@unhead/vue'
import { buildRouteSeo } from './buildRouteSeo'
import { siteBaseUrl, siteName } from '@/config/site'

// Scripts in this test are always ones buildRouteSeo built itself from a JSON.stringify call, so
// `innerHTML` is always a non-empty string here even though Unhead's own type allows more.
function scriptJson<T = unknown>(script: Script): T {
  return JSON.parse(script.innerHTML as string) as T
}

describe('buildRouteSeo', () => {
  it('sets title, description, canonical and Open Graph/Twitter tags from its input', () => {
    const head = buildRouteSeo({
      path: '/faq',
      title: 'FAQ — Example',
      description: 'FAQ description.',
      isApp: false,
    })

    expect(head.title).toBe('FAQ — Example')
    expect(head.link).toEqual([{ rel: 'canonical', href: `${siteBaseUrl}/faq` }])

    const byProperty = (property: string) => head.meta.find((m) => m.property === property)?.content
    const byName = (name: string) => head.meta.find((m) => m.name === name)?.content

    expect(byName('description')).toBe('FAQ description.')
    expect(byProperty('og:title')).toBe('FAQ — Example')
    expect(byProperty('og:description')).toBe('FAQ description.')
    expect(byProperty('og:url')).toBe(`${siteBaseUrl}/faq`)
    expect(byProperty('og:type')).toBe('website')
    expect(byProperty('og:site_name')).toBe(siteName)
    expect(byName('twitter:card')).toBe('summary')
    expect(byName('twitter:title')).toBe('FAQ — Example')
    expect(byName('twitter:description')).toBe('FAQ description.')
  })

  it('tells search engines to skip a noindex route and names no canonical URL for it', () => {
    const head = buildRouteSeo({
      path: '/some/unknown/address',
      title: 'Not found',
      description: 'Not found description.',
      isApp: false,
      noindex: true,
    })

    expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex' })
    expect(head.link).toEqual([])
    expect(head.meta.find((m) => m.property === 'og:url')).toBeUndefined()
    expect(head.script).toHaveLength(0)
  })

  it('leaves ordinary routes indexable', () => {
    const head = buildRouteSeo({
      path: '/faq',
      title: 'FAQ',
      description: 'FAQ description.',
      isApp: false,
    })

    expect(head.meta.find((m) => m.name === 'robots')).toBeUndefined()
  })

  it('adds no JSON-LD for an ordinary content route', () => {
    const head = buildRouteSeo({
      path: '/privacy',
      title: 'Privacy',
      description: 'Privacy description.',
      isApp: false,
    })

    expect(head.script).toHaveLength(0)
  })

  it('adds WebApplication JSON-LD for the tool route (R-S7)', () => {
    const head = buildRouteSeo({
      path: '/',
      title: 'Tool',
      description: 'Tool description.',
      isApp: true,
    })

    expect(head.script).toHaveLength(1)
    const data = scriptJson<{
      '@type': string
      name: string
      url: string
      isAccessibleForFree: boolean
      license: string
    }>(head.script[0]!)
    expect(data['@type']).toBe('WebApplication')
    expect(data.name).toBe(siteName)
    expect(data.url).toBe(siteBaseUrl + '/')
    expect(data.isAccessibleForFree).toBe(true)
    expect(data.license).toBe('https://www.gnu.org/licenses/agpl-3.0.html')
  })

  it('adds FAQPage JSON-LD built from the given entries (R-S7), without duplicating them by hand', () => {
    const head = buildRouteSeo({
      path: '/faq',
      title: 'FAQ',
      description: 'FAQ description.',
      isApp: false,
      faqEntries: [
        { question: 'What is this?', answer: 'A thing.' },
        { question: 'Does it work?', answer: 'Yes.' },
      ],
    })

    const faqScript = head.script.find(
      (entry) => scriptJson<{ '@type': string }>(entry)['@type'] === 'FAQPage',
    )
    expect(faqScript).toBeDefined()
    const data = scriptJson<{ url: string; mainEntity: unknown }>(faqScript!)
    expect(data.url).toBe(`${siteBaseUrl}/faq`)
    expect(data.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'What is this?',
        acceptedAnswer: { '@type': 'Answer', text: 'A thing.' },
      },
      {
        '@type': 'Question',
        name: 'Does it work?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes.' },
      },
    ])
  })

  it('escapes "<" in JSON-LD so a crafted answer cannot close the script tag early', () => {
    const head = buildRouteSeo({
      path: '/faq',
      title: 'FAQ',
      description: 'FAQ description.',
      isApp: false,
      faqEntries: [{ question: 'Safe?', answer: 'Yes </script><script>alert(1)</script>' }],
    })

    expect(head.script[0]!.innerHTML as string).not.toContain('</script>')
  })
})
