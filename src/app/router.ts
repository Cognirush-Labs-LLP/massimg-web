import type { RouteRecordRaw, RouteRecordSingleView } from 'vue-router'
import { defaultLocale, supportedLocales } from '@/config/site'
import ToolPage from './ToolPage.vue'
import FaqPage from './FaqPage.vue'
import PrivacyPage from './PrivacyPage.vue'
import TermsPage from './TermsPage.vue'
import DesktopPage from './DesktopPage.vue'

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
}

const pages: PageRoute[] = [
  { path: '', name: 'tool', component: ToolPage, isApp: true },
  { path: 'faq', name: 'faq', component: FaqPage },
  { path: 'privacy', name: 'privacy', component: PrivacyPage },
  { path: 'terms', name: 'terms', component: TermsPage },
  { path: 'desktop', name: 'desktop', component: DesktopPage },
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
    return list.map(({ path, name, component, isApp }) => ({
      path: (prefix + '/' + path).replace(/\/+$/, '') || '/',
      name: code === defaultLocale ? name : `${name}-${code}`,
      component,
      meta: { isApp: isApp === true },
    }))
  })
}

export const routes: RouteRecordRaw[] = expandLocales(pages)
