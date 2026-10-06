import { defaultLocale } from '@/config/site'

export type ContentPageId = 'faq' | 'privacy' | 'terms' | 'desktop'

// Eagerly bundled as raw text at build time — identical behaviour in `pnpm dev`, the client
// build and vite-ssg's Node prerender pass, since nothing here is a runtime fetch (Technical
// Design §12.4). Glob is rooted at the project root, matching `content/<locale>/<page>.md`.
const rawFiles = import.meta.glob('/content/*/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

function keyFor(locale: string, page: ContentPageId): string {
  return `/content/${locale}/${page}.md`
}

/**
 * Returns the raw markdown for `page` in `locale`, falling back to the default locale's file
 * when `locale` has none (R-S5). Throws only if the default locale is also missing the file,
 * which is an authoring bug (every page must exist at least in the default locale).
 */
export function loadRawContent(locale: string, page: ContentPageId): string {
  const localized = rawFiles[keyFor(locale, page)]
  if (localized !== undefined) {
    return localized
  }

  const fallback = rawFiles[keyFor(defaultLocale, page)]
  if (fallback === undefined) {
    throw new Error(`content: no "${page}" page found for locale "${locale}" or fallback "${defaultLocale}"`)
  }
  return fallback
}
