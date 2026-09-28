// Site configuration (T31, Technical Design §12.2). Single source of truth for the canonical
// production base URL, the supported-locale list and the default locale — router base paths,
// canonical/OG URLs, JSON-LD `url` fields, sitemap.xml, robots.txt's Sitemap line and the
// hreflang alternates (§11) all read from this module rather than repeating either value per file.
//
// Distinct from Vite's own `build.base` option, which is a deployment sub-path for built assets
// and has nothing to do with which URL the site is canonicalized to or which locales exist.

export interface SiteLocale {
  /** Matches the directory name under src/i18n/ and content/ for this locale. */
  code: string
  /** Human-readable name, for a future locale switcher (not built yet). */
  label: string
}

// Only English exists today (T08). Additional entries arrive as their src/i18n/<code>/ and
// content/<code>/ directories do (T48 and later) — nothing about the router (src/app/router.ts)
// or this module's shape changes to accommodate that, only this list grows.
export const supportedLocales: readonly SiteLocale[] = [{ code: 'en', label: 'English' }] as const

export const defaultLocale: SiteLocale['code'] = 'en'

/**
 * Normalises a raw base-URL string: trims whitespace and any trailing slashes. Exported
 * separately from `siteBaseUrl` so it's testable against arbitrary input without having to vary
 * `import.meta.env` per test case.
 *
 * Falls back to an unmistakably-non-production placeholder rather than throwing, so `pnpm dev`
 * and `pnpm build` both work with no `.env` changes — but the placeholder can never be mistaken
 * for a real canonical URL if it leaks into a canonical tag, JSON-LD or sitemap.xml (T45/T52).
 */
export function resolveSiteBaseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return 'https://site-base-url-not-set.invalid'
  }
  return trimmed.replace(/\/+$/, '')
}

// Read from an env var (Vite convention: `import.meta.env.*`, statically replaced at build
// time) rather than hardcoded, so a local or staging build never claims to be the production
// canonical URL in canonical tags, JSON-LD or sitemap.xml. See .env.example.
export const siteBaseUrl = resolveSiteBaseUrl(import.meta.env.VITE_SITE_BASE_URL)
