import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import browserslistToEsbuild from 'browserslist-to-esbuild'
import { VitePWA } from 'vite-plugin-pwa'
// Pulls in vite-ssg's `ssgOptions` augmentation of Vite's UserConfig type — without this,
// `ssgOptions` below doesn't type-check as a known Vite config field.
import type {} from 'vite-ssg'

// Serves 3rd_party_licenses/** as readable plain text in dev and preview (T49, R-V4). The
// licence files are LICENSE/COPYING/PATENTS with no extension, so neither Vite's static
// middleware nor Apache gives them a Content-Type and a browser offers a download instead of
// displaying them. In production the files are real files under dist/ (copied by
// scripts/copy-licenses.mjs) and the header comes from .htaccess (T52); this plugin exists so
// that the URL behaves identically in `vite dev`, `vite preview` and the Playwright suites.
const serveThirdPartyLicenses = () => {
  const root = fileURLToPath(new URL('./3rd_party_licenses', import.meta.url))
  const middleware = (
    request: { url?: string },
    response: {
      setHeader: (name: string, value: string) => void
      statusCode: number
      end: (body?: string) => void
    },
    next: () => void,
  ): void => {
    const path = (request.url ?? '').split('?')[0]
    if (path === undefined || !path.startsWith('/3rd_party_licenses/')) return next()

    const relative = decodeURIComponent(path.slice('/3rd_party_licenses/'.length))
    // Reject traversal before touching the filesystem: this middleware maps a URL straight
    // onto a repository directory, so `..` must never be resolved, not merely cleaned up.
    // posix, not the host `normalize`: on Windows that rewrites every `/` to `\`, so the
    // comparison would fail — and 400 — for every legitimate URL.
    if (relative.includes('..') || posix.normalize(relative) !== relative) {
      response.statusCode = 400
      return response.end('Bad request')
    }
    // Only `<component>/<file>` is licence text. components.json sits at the root of the tree
    // and is a module the credits page imports through Vite (componentsManifest.ts) — serving
    // it as text/plain here would shadow that import and break the page.
    if (relative.split('/').length !== 2) return next()

    const file = join(root, relative)
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.statusCode = 404
      return response.end('Not found')
    }

    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    createReadStream(file).pipe(response as unknown as NodeJS.WritableStream)
  }

  return {
    name: 'serve-third-party-licenses',
    configureServer(server: { middlewares: { use: (fn: typeof middleware) => void } }) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server: { middlewares: { use: (fn: typeof middleware) => void } }) {
      server.middlewares.use(middleware)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Absolute template URLs (`/icons/...`) point into public/ and need no bundling. Left as
    // imports, Vitest resolves them to a drive-less `file:///icons/...` that Node rejects on
    // Windows, failing every spec that mounts a header.
    vue({ template: { transformAssetUrls: { includeAbsolute: false } } }),
    serveThirdPartyLicenses(),
    // T46, Technical Design §12.6. `manifest: false`: T43 already hand-authored and linked
    // public/manifest.json with the real icon set — this plugin's only job here is the service
    // worker. `injectRegister: 'auto'` injects a plain registration script into every
    // vite-ssg-prerendered route page (the same per-route HTML-transform pass useRouteSeo.ts's
    // `useHead` calls already ride); nothing here calls `virtual:pwa-register` from app code, so
    // there's no SSR/Node-prerender hazard to guard against the way `scheduleImageMagickPreload`
    // (src/app/main.ts) has to for code that touches real browser APIs.
    VitePWA({
      manifest: false,
      injectRegister: 'auto',
      registerType: 'autoUpdate',
      workbox: {
        // Workbox's own default (`**/*.{js,wasm,css,html}`) would put every `.wasm` codec file,
        // including the 14MB ImageMagick build, in scope for precaching at install time — well
        // past the 2MB default ceiling, which this plugin version turns into a hard build
        // error rather than a warning. Codec WASM is deliberately left out of precache and
        // picked up by the runtimeCaching rule below instead: T22 already lazy-loads every
        // codec (ImageMagick on idle-after-first-paint, the rest on first use of that format),
        // so the first real fetch is enough to get it cached for the next offline visit.
        globPatterns: ['**/*.{js,css,html}', 'manifest.json', 'icons/*.png'],
        // The navigation fallback answers every browser navigation with the app shell, whose
        // router renders "Page not found" for anything it has no route for. Static files opened
        // directly (sitemap.xml, robots.txt, llms.txt, the extensionless license texts the
        // Credits page links to) must reach the network instead. Prerendered pages are
        // unaffected: the precache route, registered ahead of this fallback, already serves
        // `/faq` from its precached `faq.html`.
        navigateFallbackDenylist: [/^\/3rd_party_licenses\//, /\/[^/]+\.[^/]+$/],
        runtimeCaching: [
          {
            // Technical Design §12.6: Cloudflare injects its analytics script at the edge, so
            // the build never mentions this domain. An explicit exclusion, rather than
            // relying on that silence, keeps a later runtime-caching change from swallowing
            // the script's requests.
            urlPattern: /^https:\/\/static\.cloudflareinsights\.com\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'codec-wasm',
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Derived from .browserslistrc (the app's feature-driven minimum browser baseline) rather
    // than left on Vite's own default, which is date-pinned per major version and would
    // otherwise silently raise or lower the real floor on a future Vite upgrade.
    target: browserslistToEsbuild(),
  },
  worker: {
    // Every `new Worker(...)` in this codebase already requests `{ type: 'module' }`
    // (pool.ts, thumbnails.ts, dimension-probe.ts), and the declared browser baseline
    // requires module-worker support anyway (it's what pins Firefox at 114). Vite's
    // own default worker output format is 'iife' regardless of build.target, which
    // cannot express the top-level await the WASM codec glue (e.g. imagequant) uses —
    // 'es' matches what the runtime already asks for and is what production build needs.
    format: 'es',
  },
  // vite-ssg (T31, Technical Design §12.3): `vite-ssg build` reads this same config, so its
  // route-by-route Node prerender options live here rather than a separate file.
  ssgOptions: {
    script: 'async',
    formatting: 'minify',
    // `paths` includes the not-found route's wildcard pattern, which is not a page address, so
    // it is dropped and the route is rendered once at /404 instead. That writes dist/404.html,
    // the page the host serves for an unknown address.
    includedRoutes: (paths) => [...paths.filter((path) => !path.includes(':')), '/404'],
  },
  optimizeDeps: {
    // `imagequant` is a wasm-bindgen "bundler" target: `imagequant.js` imports the `.wasm`, hands the
    // instance's exports to `imagequant_bg.js` through `__wbg_set_wasm`, and re-exports it. The dev
    // dep-optimizer inlines a *copy* of `imagequant_bg.js` into `node_modules/.vite/deps`, while the
    // `.wasm` module's own imports still resolve to the original file — so two copies of the glue
    // exist, only one of them holding the instance. Measured (T27): every error the quantizer raises
    // then arrives as `TypeError: Cannot read properties of undefined (reading 'memory')` from the
    // copy that never received the instance, because `__wbindgen_throw` cannot reach the heap to
    // read its own message. libimagequant's `QUALITY_TOO_LOW` abort is a *normal* outcome for this
    // pipeline (Functional Design R-Q11: the floor is enforced by aborting, and the job falls back to
    // a lossless PNG), so losing the message means losing the difference between that and a real
    // failure. Excluding the package from pre-bundling serves the single original module and makes
    // the dev server behave like the production build, where Rollup emits exactly one copy.
    exclude: ['imagequant'],
  },
})
