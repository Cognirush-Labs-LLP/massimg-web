import { useHead } from '@unhead/vue'
import { beaconScriptSrc, cfBeaconToken } from '@/config/analytics'

/**
 * Mounted once from App.vue, not per route (unlike useRouteSeo.ts) — the beacon tag is
 * identical on every route. `useHead` is SSR-safe, so this script tag lands directly in
 * vite-ssg's prerendered HTML for every route (Technical Design §12.6): the beacon can
 * fire on load without waiting on the Vue app to hydrate, matching "fires from the page
 * itself on every load, cached shell or not" more closely than gating it behind a
 * client-only mount hook would.
 *
 * Only added for a production build (`import.meta.env.PROD`): `pnpm dev` and the main
 * e2e suite (tests/e2e/, run against the dev server) must never fire a real request at
 * Cloudflare — besides being pointless traffic, the dev server's origin gets the
 * request CORS-rejected, which several existing tests' console-error assertions caught
 * as a regression. `tests/e2e-pwa/pwa.spec.ts` runs against a real `pnpm build`, where
 * this is true, so F2's test is unaffected.
 */
export function useAnalyticsBeacon(): void {
  if (!import.meta.env.PROD) {
    return
  }

  useHead({
    script: [
      {
        src: beaconScriptSrc,
        defer: true,
        'data-cf-beacon': JSON.stringify({ token: cfBeaconToken }),
      },
    ],
  })
}
