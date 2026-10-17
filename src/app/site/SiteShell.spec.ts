import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import SiteShell from './SiteShell.vue'
import { routes } from '@/app/router'

// Same rationale as App.spec.ts: importing router.ts pulls in ToolPage.vue's real
// pipeline/codecs/loader.ts, which Vitest can't transform (T31 Surprises).
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

// jsdom has no matchMedia; ToolPage's useBreakpoint() calls it inside onMounted regardless of
// which breakpoint a given test cares about.
function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

async function mountAt(path: string) {
  stubMatchMedia()
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  return mount(SiteShell, {
    global: { plugins: [router, createPinia(), createHead()] },
  })
}

// Verifies the chrome selection the user asked for (T43): purely route-based, not viewport-
// based. The tool route gets no outer header at all and a compact footer; every other route
// gets the regular header and footer.
describe('SiteShell', () => {
  it('shows no outer header and a compact footer on the tool route', async () => {
    const wrapper = await mountAt('/')

    expect(wrapper.find('.site-header').exists()).toBe(false)
    expect(wrapper.find('.site-footer--compact').exists()).toBe(true)
  })

  it('shows the regular header and footer on a content route', async () => {
    const wrapper = await mountAt('/faq')

    expect(wrapper.find('.site-header').exists()).toBe(true)
    expect(wrapper.find('.site-footer--compact').exists()).toBe(false)
  })
})
