import { useHead } from '@unhead/vue'
import { useRoute } from 'vue-router'
import { buildRouteSeo } from './buildRouteSeo'
import { extractFaqEntries } from '@/app/content/extractFaqEntries'
import { loadRawContent } from '@/app/content/content'
import { defaultLocale } from '@/config/site'

function metaString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Mounted once (SiteShell.vue), not per page component, so every route sets its title,
 * description, canonical, Open Graph/Twitter and structured data through this one mechanism
 * (Technical Design §12.5) instead of five near-identical per-page calls. Reads title/
 * description/isApp/isFaq/noindex from the current route's meta, set by `src/app/router.ts`.
 */
export function useRouteSeo(): void {
  const route = useRoute()

  useHead(() =>
    buildRouteSeo({
      path: route.path,
      title: metaString(route.meta.title),
      description: metaString(route.meta.description),
      isApp: route.meta.isApp === true,
      noindex: route.meta.noindex === true,
      faqEntries:
        route.meta.isFaq === true
          ? extractFaqEntries(loadRawContent(defaultLocale, 'faq'))
          : undefined,
    }),
  )
}
