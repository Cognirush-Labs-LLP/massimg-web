import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from './router'
import { supportedLocales } from '@/config/site'
import ToolPage from './ToolPage.vue'
import FaqPage from './FaqPage.vue'
import PrivacyPage from './PrivacyPage.vue'
import TermsPage from './TermsPage.vue'
import DesktopPage from './DesktopPage.vue'

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
  it('has one route per page, per supported locale (today: 5 pages × "en")', () => {
    expect(routes).toHaveLength(5 * supportedLocales.length)
  })

  it('resolves "/" to the tool page under the default (unprefixed) locale, marked as the app route', () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    const resolved = router.resolve('/')

    expect(resolved.name).toBe('tool')
    expect(resolved.matched[0]?.components?.default).toBe(ToolPage)
    expect(resolved.meta.isApp).toBe(true)
  })

  it.each([
    ['/faq', 'faq', FaqPage],
    ['/privacy', 'privacy', PrivacyPage],
    ['/terms', 'terms', TermsPage],
    ['/desktop', 'desktop', DesktopPage],
  ])('resolves %s to the %s page, not marked as the app route', (path, name, component) => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    const resolved = router.resolve(path as string)

    expect(resolved.name).toBe(name)
    expect(resolved.matched[0]?.components?.default).toBe(component)
    expect(resolved.meta.isApp).toBe(false)
  })
})
