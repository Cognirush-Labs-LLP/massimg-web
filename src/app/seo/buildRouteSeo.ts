import type { Link, Meta, Script } from '@unhead/vue'
import { siteBaseUrl, siteName } from '@/config/site'
import type { FaqEntry } from '@/app/content/extractFaqEntries'

export interface RouteSeoInput {
  /** Router path, e.g. '/', '/faq'. Combined with siteBaseUrl for the canonical URL and JSON-LD `url`. */
  path: string
  title: string
  description: string
  /** True only for the tool route — adds WebApplication structured data (R-S7). */
  isApp: boolean
  /**
   * True only for the not-found page: tells search engines to skip it, and leaves out the
   * canonical URL and `og:url`, which would name an address that is not a page.
   */
  noindex?: boolean
  /** Present only for the FAQ route — adds FAQPage structured data built from the real FAQ content. */
  faqEntries?: FaqEntry[]
}

// Unhead's own tag input types (Meta/Link/Script), not hand-rolled shapes, so the object this
// function returns is guaranteed assignable straight into useHead() — see useRouteSeo.ts.
export interface RouteSeoHead {
  title: string
  meta: Meta[]
  link: Link[]
  script: Script[]
}

function jsonLd(data: Record<string, unknown>): string {
  // Escapes '<' so a literal "</script>" (or any tag-open sequence) inside the stringified
  // content can never prematurely close this script element — one line, applies to any future
  // content source feeding this, not just the current static/FAQ strings.
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/**
 * Builds the single Unhead input object every route's `useRouteSeo()` call passes to `useHead()`
 * (Technical Design §12.5): title, description, canonical, Open Graph, Twitter card, and
 * route-appropriate JSON-LD. Kept as a pure function of its input so it is unit-testable without
 * mounting a component or a router.
 */
export function buildRouteSeo(input: RouteSeoInput): RouteSeoHead {
  const canonical = `${siteBaseUrl}${input.path}`

  const meta: RouteSeoHead['meta'] = [
    { name: 'description', content: input.description },
    { property: 'og:title', content: input.title },
    { property: 'og:description', content: input.description },
    ...(input.noindex ? [] : [{ property: 'og:url', content: canonical }]),
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: siteName },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: input.title },
    { name: 'twitter:description', content: input.description },
    ...(input.noindex ? [{ name: 'robots', content: 'noindex' }] : []),
  ]

  const script: RouteSeoHead['script'] = []

  if (input.isApp) {
    script.push({
      type: 'application/ld+json',
      innerHTML: jsonLd({
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: siteName,
        url: canonical,
        description: input.description,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isAccessibleForFree: true,
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      }),
    })
  }

  if (input.faqEntries && input.faqEntries.length > 0) {
    script.push({
      type: 'application/ld+json',
      innerHTML: jsonLd({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        url: canonical,
        mainEntity: input.faqEntries.map((entry) => ({
          '@type': 'Question',
          name: entry.question,
          acceptedAnswer: { '@type': 'Answer', text: entry.answer },
        })),
      }),
    })
  }

  return {
    title: input.title,
    meta,
    link: input.noindex ? [] : [{ rel: 'canonical', href: canonical }],
    script,
  }
}
