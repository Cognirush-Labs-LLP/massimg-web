import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import SiteFooter from './SiteFooter.vue'
import { routes } from '@/app/router'

// Same rationale as SiteShell.spec.ts: importing router.ts pulls in ToolPage.vue's real
// pipeline/codecs/loader.ts, which Vitest can't transform (T31 Surprises).
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

async function mountFooter(compact: boolean) {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/')
  await router.isReady()

  return mount(SiteFooter, { props: { compact }, global: { plugins: [router] } })
}

function hrefs(wrapper: Awaited<ReturnType<typeof mountFooter>>): string[] {
  return wrapper.findAll('a').map((link) => link.attributes('href') ?? '')
}

describe('SiteFooter', () => {
  // R-V1's reachability half. A longer privacy line in the compact footer was tried and
  // removed: below ~600px it wrapped the row onto a second line and took 30px off the stage,
  // visible as a shorter Preview frame. The claim itself lives in the Gallery empty state;
  // this link is how it stays reachable once images are loaded.
  it.each([true, false])(
    'links the Privacy page with a plain label in both variants (compact: %s)',
    async (compact) => {
      const wrapper = await mountFooter(compact)

      expect(wrapper.text()).toContain('Privacy')
      expect(hrefs(wrapper)).toContain('/privacy')
    },
  )

  it('keeps every compact-footer label short enough that the row does not wrap', async () => {
    // The compact variant exists so the tool fits the viewport; a wrapped footer takes its
    // height out of the stage rather than making the page scroll.
    const wrapper = await mountFooter(true)

    for (const link of wrapper.findAll('a')) {
      expect(link.text().length).toBeLessThanOrEqual(14)
    }
  })

  it.each([true, false])(
    'links the credits page in both variants (compact: %s)',
    async (compact) => {
      const wrapper = await mountFooter(compact)

      expect(hrefs(wrapper)).toContain('/credits')
      expect(wrapper.text()).toContain('Credits')
    },
  )

  // R-V4's other half, built in T43 — guarded here so neither edit above drops it.
  it.each([true, false])(
    'keeps the application source link, opened safely (compact: %s)',
    async (compact) => {
      const link = (await mountFooter(compact)).find('.github-link')

      expect(link.attributes('href')).toBe('https://github.com/Cognirush-Labs-LLP/massimg-web')
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noopener')
    },
  )
})
