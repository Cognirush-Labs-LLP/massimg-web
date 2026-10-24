import type { RouteRecordRaw, RouteRecordSingleView } from 'vue-router'
import { defaultLocale, supportedLocales } from '@/config/site'
import { t } from '@/i18n/t'
import ToolPage from './ToolPage.vue'
import FaqPage from './FaqPage.vue'
import PrivacyPage from './PrivacyPage.vue'
import TermsPage from './TermsPage.vue'
import CreditsPage from './credits/CreditsPage.vue'
import DesktopPage from './DesktopPage.vue'
import NotFoundPage from './NotFoundPage.vue'

// One entry per logical page, locale-agnostic.
interface PageRoute {
  /** No leading slash. '' means the site root. */
  path: string
  name: string
  component: RouteRecordSingleView['component']
  /**
   * True only for the tool page. Read by SiteShell.vue to decide between the compact
   * mobile app chrome and the regular site chrome (T43) — distinct from name-matching
   * because locale-prefixed tool routes are named `tool-<code>`, not `tool`.
   */
  isApp?: boolean
  /**
   * True only for the FAQ page. Read by useRouteSeo() to attach FAQPage JSON-LD (R-S7) — kept
   * as its own meta flag, the same convention as isApp, rather than name-matching across
   * locale-prefixed route names.
   */
  isFaq?: boolean
  /**
   * Per-route title and meta description (R-S6, Technical Design §12.5), sourced from the i18n
   * catalogue like any other interface string. English only today; a real per-locale pair
   * arrives with T48, the same as every other interface string.
   */
  title: string
  description: string
}

const pages: PageRoute[] = [
  {
    path: '',
    name: 'tool',
    component: ToolPage,
    isApp: true,
    title: t('site.seo.tool.title'),
    description: t('site.seo.tool.description'),
  },
  {
    path: 'faq',
    name: 'faq',
    component: FaqPage,
    isFaq: true,
    title: t('site.seo.faq.title'),
    description: t('site.seo.faq.description'),
  },
  {
    path: 'privacy',
    name: 'privacy',
    component: PrivacyPage,
    title: t('site.seo.privacy.title'),
    description: t('site.seo.privacy.description'),
  },
  {
    path: 'terms',
    name: 'terms',
    component: TermsPage,
    title: t('site.seo.terms.title'),
    description: t('site.seo.terms.description'),
  },
  {
    // Generated from 3rd_party_licenses/components.json rather than markdown, so it is not a
    // content page and takes no locale fallback (T49, R-V4).
    path: 'credits',
    name: 'credits',
    component: CreditsPage,
    title: t('site.seo.credits.title'),
    description: t('site.seo.credits.description'),
  },
  {
    path: 'desktop',
    name: 'desktop',
    component: DesktopPage,
    title: t('site.seo.desktop.title'),
    description: t('site.seo.desktop.description'),
  },
]

/**
 * Expands `pages` into one route per supported locale. The default locale is unprefixed
 * (`/`); every other locale gets a `/<code>/...` prefix (Technical Design §11/§12.2 — the
 * canonical URL is the bare domain). Looping now, even though `supportedLocales` has only one
 * entry today, is what lets T48 add locales without restructuring this file — see
 * docs/task-notes/T31.md, Decisions made.
 */
function expandLocales(list: PageRoute[]): RouteRecordRaw[] {
  return supportedLocales.flatMap(({ code }) => {
    const prefix = code === defaultLocale ? '' : `/${code}`
    return list.map(({ path, name, component, isApp, isFaq, title, description }) => ({
      path: (prefix + '/' + path).replace(/\/+$/, '') || '/',
      name: code === defaultLocale ? name : `${name}-${code}`,
      component,
      meta: { isApp: isApp === true, isFaq: isFaq === true, title, description },
    }))
  })
}

// Any address that is not a page above. The server answers such requests with the prerendered
// 404.html (see public/.htaccess), and this record is what makes the client render the same
// page for the address the browser is actually on. One record for every locale prefix: the
// page has no per-locale content to fall back from. `noindex` keeps it out of search results
// and drops its canonical URL (see buildRouteSeo.ts).
const notFoundRoute: RouteRecordRaw = {
  path: '/:pathMatch(.*)*',
  name: 'not-found',
  component: NotFoundPage,
  meta: {
    isApp: false,
    isFaq: false,
    noindex: true,
    title: t('site.seo.notFound.title'),
    description: t('site.seo.notFound.description'),
  },
}

export const routes: RouteRecordRaw[] = [...expandLocales(pages), notFoundRoute]
