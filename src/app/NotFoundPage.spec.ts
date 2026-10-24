import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import SiteShell from './site/SiteShell.vue'
import { routes } from './router'
import { t } from '@/i18n/t'

// Same rationale as SiteShell.spec.ts: importing router.ts pulls in ToolPage.vue's real codec
// loader, which Vitest cannot transform.
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

async function mountAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(path)
  await router.isReady()

  return mount(SiteShell, { global: { plugins: [router, createPinia(), createHead()] } })
}

describe('NotFoundPage', () => {
  it.each(['/nope', '/a/b/c', '/faq.html'])(
    'at the unknown address %s shows its one heading and a link back to the home page',
    async (path) => {
      const wrapper = await mountAt(path)
      const page = wrapper.get('main')

      expect(page.findAll('h1')).toHaveLength(1)
      expect(page.get('h1').text()).toBe(t('notFound.heading'))

      const home = page.get('a')
      expect(home.text()).toBe(t('notFound.homeLink'))
      expect(home.attributes('href')).toBe('/')
    },
  )

  it('keeps the regular site header and footer around it, not the tool-only chrome', async () => {
    const wrapper = await mountAt('/nope')

    expect(wrapper.find('.site-header').exists()).toBe(true)
    expect(wrapper.find('.site-footer--compact').exists()).toBe(false)
  })
})
