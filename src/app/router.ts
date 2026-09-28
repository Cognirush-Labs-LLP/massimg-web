import type { RouteRecordRaw, RouteRecordSingleView } from 'vue-router'
import { defaultLocale, supportedLocales } from '@/config/site'
import ToolPage from './ToolPage.vue'

// One entry per logical page, locale-agnostic. T44 appends /faq, /privacy, /terms, /desktop
// entries here — this shape doesn't need to change to accommodate that (Technical Design §12.3).
interface PageRoute {
  /** No leading slash. '' means the site root. */
  path: string
  name: string
  component: RouteRecordSingleView['component']
}

const pages: PageRoute[] = [{ path: '', name: 'tool', component: ToolPage }]

/**
 * Expands `pages` into one route per supported locale. The default locale is unprefixed
 * (`/`); every other locale gets a `/<code>/...` prefix (Technical Design §11/§12.2 — the
 * canonical URL is the bare domain). Looping now, even though `supportedLocales` has only one
 * entry today, is what lets T44/T48 add routes and locales without restructuring this file —
 * see docs/task-notes/T31.md, Decisions made.
 */
function expandLocales(list: PageRoute[]): RouteRecordRaw[] {
  return supportedLocales.flatMap(({ code }) => {
    const prefix = code === defaultLocale ? '' : `/${code}`
    return list.map(({ path, name, component }) => ({
      path: (prefix + '/' + path).replace(/\/+$/, '') || '/',
      name: code === defaultLocale ? name : `${name}-${code}`,
      component,
    }))
  })
}

export const routes: RouteRecordRaw[] = expandLocales(pages)
