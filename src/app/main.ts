import { ViteSSG } from 'vite-ssg'
import { createPinia } from 'pinia'
import '@/styles/index.css'
import App from './App.vue'
import { routes } from './router'

// vite-ssg (Technical Design §12.3) renders each route once in Node at build time and writes
// real HTML to disk, then mounts the same app on the client — no Node server ever runs. Pinia
// installs inside this context callback rather than a bare `.use()` chain: stores are plain
// reactive JS with no DOM/WASM dependency, so this is safe on both the prerender pass and the
// client (only *consuming* browser APIs inside a store or component is the actual hazard).
//
// `scheduleImageMagickPreload()` no longer lives here — it moved into ToolPage.vue's
// `onMounted` hook, which never fires during the Node prerender pass. See docs/task-notes/T31.md.
export const createApp = ViteSSG(App, { routes }, ({ app }) => {
  app.use(createPinia())
})
