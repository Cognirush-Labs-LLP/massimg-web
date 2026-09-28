import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import App from '@/app/App.vue'
import { routes } from '@/app/router'

// ToolPage.vue's onMounted calls scheduleImageMagickPreload(), which in a real browser fetches
// ImageMagick's WASM (§12.1). jsdom has no requestIdleCallback and no usable fetch for a wasm
// asset, so mounting the real implementation here would schedule a timer that either hangs the
// test environment or triggers a real dynamic import outside a real page — mock the module
// boundary instead, same as any other heavy external side effect a component test shouldn't
// actually exercise.
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

// jsdom has no matchMedia; ToolPage's useBreakpoint() calls it inside onMounted regardless of
// which breakpoint this test cares about. This test only asserts content renders, so the exact
// value doesn't matter — it just needs to exist and not throw.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

// Proves module resolution matches the real Vite build (the "@" alias, exercised through both
// this import and the router's dynamic route components) and that the root route renders the
// tool shell — replacing T04's placeholder-text assertion now that T31 has real routing (§12.3).
describe('App', () => {
  it('renders the tool page at the root route', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: { plugins: [router, createPinia()] },
    })

    expect(wrapper.text()).toContain('Compressor')
  })
})
