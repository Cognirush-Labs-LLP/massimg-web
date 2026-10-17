import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import browserslistToEsbuild from 'browserslist-to-esbuild'
import { VitePWA } from 'vite-plugin-pwa'
// Pulls in vite-ssg's `ssgOptions` augmentation of Vite's UserConfig type — without this,
// `ssgOptions` below doesn't type-check as a known Vite config field.
import type {} from 'vite-ssg'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
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
        runtimeCaching: [
          {
            // Technical Design §12.6: an explicit exclusion for the analytics domain, not
            // reliance on the precache manifest simply never mentioning it, so a later
            // runtime-caching change can't silently start swallowing these requests.
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
