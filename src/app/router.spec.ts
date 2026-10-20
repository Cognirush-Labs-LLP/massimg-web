import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from './router'
import { supportedLocales } from '@/config/site'
import ToolPage from './ToolPage.vue'
import FaqPage from './FaqPage.vue'
import PrivacyPage from './PrivacyPage.vue'
import TermsPage from './TermsPage.vue'
import CreditsPage from './credits/CreditsPage.vue'
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
  it('has one route per page, per supported locale (today: 6 pages × "en")', () => {
    expect(routes).toHaveLength(6 * supportedLocales.length)
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
    ['/credits', 'credits', CreditsPage],
    ['/desktop', 'desktop', DesktopPage],
  ])('resolves %s to the %s page, not marked as the app route', (path, name, component) => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    const resolved = router.resolve(path as string)

    expect(resolved.name).toBe(name)
    expect(resolved.matched[0]?.components?.default).toBe(component)
    expect(resolved.meta.isApp).toBe(false)
  })

  it('marks only the FAQ route as isFaq (R-S7)', () => {
    const router = createRouter({ history: createMemoryHistory(), routes })

    expect(router.resolve('/faq').meta.isFaq).toBe(true)
    for (const path of ['/', '/privacy', '/terms', '/credits', '/desktop']) {
      expect(router.resolve(path).meta.isFaq).toBe(false)
    }
  })

  it('gives every route a non-empty title and description, no two routes sharing either (R-S6)', () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    const resolved = ['/', '/faq', '/privacy', '/terms', '/credits', '/desktop'].map((path) =>
      router.resolve(path),
    )

    for (const route of resolved) {
      expect(typeof route.meta.title).toBe('string')
      expect(route.meta.title).not.toBe('')
      expect(typeof route.meta.description).toBe('string')
      expect(route.meta.description).not.toBe('')
    }

    expect(new Set(resolved.map((route) => route.meta.title)).size).toBe(resolved.length)
    expect(new Set(resolved.map((route) => route.meta.description)).size).toBe(resolved.length)
  })
})
