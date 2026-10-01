import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import ToolPage from './ToolPage.vue'
import { useUiStore } from '@/stores/ui'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import type { ImageId, ImageRecord } from '@/domain/types'
import PrimaryActionButton from './shell/PrimaryActionButton.vue'
import Gallery from '@/ui/gallery/Gallery.vue'
import Preview from '@/ui/preview/Preview.vue'
import Processing from '@/ui/processing/Processing.vue'

// See App.spec.ts for why this is mocked: the real implementation fetches WASM in a real
// browser and has no place to do that safely inside a jsdom unit test.
vi.mock('@/pipeline/codecs/loader', () => ({
  scheduleImageMagickPreload: vi.fn(),
}))

// jsdom has no matchMedia. `matches` is read fresh on every call, so a test can set it before
// mounting to choose which breakpoint useBreakpoint.ts's onMounted resolves to.
let matches = true

beforeEach(() => {
  matches = true
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountToolPage(): Promise<VueWrapper> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ToolPage, { global: { plugins: [pinia] } })
  // useBreakpoint's real matchMedia value only lands after onMounted's reactive update flushes.
  await nextTick()
  return wrapper
}

describe('ToolPage stage-mode mounting', () => {
  it('mounts exactly the component matching the current stage mode', async () => {
    const wrapper = await mountToolPage()
    expect(wrapper.findComponent(Gallery).exists()).toBe(true)
    expect(wrapper.findComponent(Preview).exists()).toBe(false)
  })

  it('unmounts the outgoing mode and mounts the incoming one on a mode switch', async () => {
    const wrapper = await mountToolPage()

    expect(wrapper.findComponent(Gallery).exists()).toBe(true)

    useUiStore().openPreview('image-1' as ImageId)
    await nextTick()

    // A real unmount, not a hidden-but-alive tree: <component :is> swapping destroys the
    // outgoing instance instead of hiding it (Technical Design §1.1, R-M4).
    expect(wrapper.findComponent(Gallery).exists()).toBe(false)
    expect(wrapper.findComponent(Preview).exists()).toBe(true)
  })
})

describe('ToolPage panel layout', () => {
  it('shows the static side panel and no Options button at >=900px', async () => {
    matches = true
    const wrapper = await mountToolPage()
    expect(wrapper.find('.side-panel-static').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="options-button"]').exists()).toBe(false)
  })

  it('hides the static side panel and shows the Options button at <900px', async () => {
    matches = false
    const wrapper = await mountToolPage()
    expect(wrapper.find('.side-panel-static').exists()).toBe(false)
    expect(wrapper.find('[data-testid="options-button"]').exists()).toBe(true)
  })

  it('opens the drawer from the Options button and closes it via the Hide button', async () => {
    matches = false
    const wrapper = await mountToolPage()

    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)

    await wrapper.find('[data-testid="options-button"]').trigger('click')
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-scrim"]').exists()).toBe(true)

    await wrapper.find('.drawer-hide-button').trigger('click')
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })

  it('hides the panel entirely — static or drawer — while Processing is mounted', async () => {
    const wrapper = await mountToolPage()

    useUiStore().enterProcessing()
    await nextTick()

    expect(wrapper.findComponent(Processing).exists()).toBe(true)
    expect(wrapper.find('.side-panel-static').exists()).toBe(false)
    expect(wrapper.find('[data-testid="options-button"]').exists()).toBe(false)
  })

  it('entering Processing force-closes an open drawer', async () => {
    matches = false
    const wrapper = await mountToolPage()
    const ui = useUiStore()

    await wrapper.find('[data-testid="options-button"]').trigger('click')
    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(true)

    ui.enterProcessing()
    await nextTick()

    expect(wrapper.find('[data-testid="drawer-panel"]').exists()).toBe(false)
  })
})

describe('ToolPage primary action', () => {
  it('is visible on desktop, pinned to the panel footer', async () => {
    matches = true
    const wrapper = await mountToolPage()
    expect(wrapper.find('.side-panel-footer').text()).toContain('Compress')
  })

  it('is visible on mobile, as a fixed bottom bar outside the drawer', async () => {
    matches = false
    const wrapper = await mountToolPage()
    expect(wrapper.find('.mobile-action-bar').text()).toContain('Compress')
  })

  it('is disabled while the batch is empty', async () => {
    const wrapper = await mountToolPage()
    const button = wrapper.findComponent(PrimaryActionButton)

    expect(button.props('count')).toBe(0)
    expect(button.props('disabled')).toBe(true)
  })

  it('is not rendered while Processing is mounted, on either layout', async () => {
    const wrapper = await mountToolPage()

    useUiStore().enterProcessing()
    await nextTick()

    // Not a text-content check: the wordmark "Compressor" itself contains "Compress" as a
    // substring, so this asserts the button component's absence directly instead.
    expect(wrapper.findComponent(PrimaryActionButton).exists()).toBe(false)
  })
})

let nextId = 0

function image(overrides: Partial<ImageRecord> = {}): ImageRecord {
  nextId += 1

  return {
    id: `image-${nextId}` as ImageId,
    name: 'photo.jpg',
    relativePath: null,
    sizeBytes: 500_000,
    width: 1920,
    height: 1080,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: false,
    edit: null,
    status: 'ready',
    failure: null,
    ...overrides,
  }
}

describe('ToolPage primary action meta line (R-A2, R-F4, T35)', () => {
  beforeEach(() => {
    nextId = 0
  })

  it('is empty while the batch is empty', async () => {
    const wrapper = await mountToolPage()

    expect(wrapper.findComponent(PrimaryActionButton).props('metaLine')).toBe('')
  })

  it('names the setting, not "images", for a multi-image "Don\'t change" batch', async () => {
    const wrapper = await mountToolPage()
    useBatchStore().addImages([image(), image()])
    await nextTick()

    expect(wrapper.findComponent(PrimaryActionButton).props('metaLine')).toBe(
      '2 images · Original formats · ZIP',
    )
  })

  it('names the chosen format for a multi-image batch with a concrete format', async () => {
    const wrapper = await mountToolPage()
    useBatchStore().addImages([image(), image(), image()])
    useSettingsStore().format = 'webp'
    await nextTick()

    expect(wrapper.findComponent(PrimaryActionButton).props('metaLine')).toBe(
      '3 images · WEBP · ZIP',
    )
  })

  it('shows format and dimensions for a single-image batch with a concrete format', async () => {
    const wrapper = await mountToolPage()
    useSettingsStore().format = 'avif'
    useBatchStore().addImages([image()])
    await nextTick()

    expect(wrapper.findComponent(PrimaryActionButton).props('metaLine')).toBe('AVIF · 1920×1080')
  })

  it('reads "Original formats" even for a single image under "Don\'t change" (R-F4)', async () => {
    const wrapper = await mountToolPage()
    useBatchStore().addImages([image()])
    await nextTick()

    expect(wrapper.findComponent(PrimaryActionButton).props('metaLine')).toBe(
      'Original formats · 1920×1080',
    )
  })
})
