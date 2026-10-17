// Cloudflare Web Analytics beacon configuration (T46, Technical Design §12.6). Same
// env-var pattern as src/config/site.ts's siteBaseUrl: read from a `VITE_` env var,
// falling back to an unmistakably-non-production placeholder rather than throwing, so
// dev and CI builds work with no `.env` changes. The real token is filled in by T51-A.

export const beaconScriptSrc = 'https://static.cloudflareinsights.com/beacon.min.js'

/**
 * Exported separately from `cfBeaconToken` so it's testable against arbitrary input
 * without having to vary `import.meta.env` per test case (mirrors
 * `resolveSiteBaseUrl` in src/config/site.ts).
 */
export function resolveCfBeaconToken(raw: string | undefined): string {
  const trimmed = raw?.trim()
  return trimmed || 'cf-beacon-token-not-set'
}

export const cfBeaconToken = resolveCfBeaconToken(import.meta.env.VITE_CF_BEACON_TOKEN)
