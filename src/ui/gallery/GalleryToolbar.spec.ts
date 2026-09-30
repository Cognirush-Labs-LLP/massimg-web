import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useUiStore } from '@/stores/ui'

const addViaFilePicker = vi.fn()
const addViaFolderPicker = vi.fn()
const clearGallery = vi.fn()
vi.mock('./ingest', () => ({ addViaFilePicker, addViaFolderPicker, clearGallery }))

const getCapabilities = vi.fn()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilities() }))

const GalleryToolbar = (await import('./GalleryToolbar.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  addViaFilePicker.mockReset()
  addViaFolderPicker.mockReset()
  clearGallery.mockReset()
  getCapabilities.mockResolvedValue({ opfs: true, folderPicker: true, crossOriginIsolated: false })
})

describe('GalleryToolbar', () => {
  it('renders Add images, Clear, and the grid/list view toggle (R-G7)', () => {
    const wrapper = mount(GalleryToolbar)
    expect(wrapper.text()).toContain('Add images')
    expect(wrapper.text()).toContain('Clear')
    expect(wrapper.find('[data-testid="gallery-view-toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-view-toggle-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-view-toggle-list"]').exists()).toBe(true)
  })

  it('wires each button to the matching ingest.ts action', async () => {
    const wrapper = mount(GalleryToolbar)
    await nextTick()
    await nextTick()

    await wrapper.find('.toolbar-button').trigger('click')
    expect(addViaFilePicker).toHaveBeenCalledOnce()

    await wrapper.find('.clear-button').trigger('click')
    expect(clearGallery).toHaveBeenCalledOnce()
  })

  it('defaults to grid pressed, and clicking List switches the store view and aria-pressed state', async () => {
    const wrapper = mount(GalleryToolbar)
    const gridButton = wrapper.find('[data-testid="gallery-view-toggle-grid"]')
    const listButton = wrapper.find('[data-testid="gallery-view-toggle-list"]')
    expect(gridButton.attributes('aria-pressed')).toBe('true')
    expect(listButton.attributes('aria-pressed')).toBe('false')

    await listButton.trigger('click')

    expect(useUiStore().galleryView).toBe('list')
    expect(listButton.attributes('aria-pressed')).toBe('true')
    expect(gridButton.attributes('aria-pressed')).toBe('false')
  })

  it('clicking Grid after List switches back and marks it a manual override', async () => {
    const wrapper = mount(GalleryToolbar)
    useUiStore().setGalleryView('list')
    await nextTick()

    await wrapper.find('[data-testid="gallery-view-toggle-grid"]').trigger('click')

    const uiStore = useUiStore()
    expect(uiStore.galleryView).toBe('grid')
    expect(uiStore.galleryViewOverridden).toBe(true)
  })
})
