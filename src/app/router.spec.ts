import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from './router'
import { supportedLocales } from '@/config/site'
import ToolPage from './ToolPage.vue'

// Importing router.ts pulls in ToolPage.vue, which pulls in the real
// @/pipeline/codecs/loader.ts. Its ensureQuantizer() dynamic-imports "imagequant" — a package
// vite.config.ts deliberately excludes from pre-bundling (T27, wasm-bindgen double-instance
// workaround) — and Vite's import-analysis plugin fails to resolve that specifier at transform
// time under Vitest even though the function is never called here. See docs/task-notes/T31.md,
// Surprises. Mocked for the same reason App.spec.ts/ToolPage.spec.ts mock it.
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

describe('router', () => {
  it('has one route per supported locale (today: just "en")', () => {
    expect(routes).toHaveLength(supportedLocales.length)
  })

  it('resolves "/" to the tool page under the default (unprefixed) locale', () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    const resolved = router.resolve('/')

    expect(resolved.name).toBe('tool')
    expect(resolved.matched[0]?.components?.default).toBe(ToolPage)
  })
})
