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
  it('renders Add Images, Clear, and the grid/list view toggle (R-G7)', () => {
    const wrapper = mount(GalleryToolbar)
    expect(wrapper.text()).toContain('Add Images')
    expect(wrapper.text()).toContain('Clear')
    expect(wrapper.find('[data-testid="gallery-view-toggle"]').exists()).toBe(true)
  })

  it('wires each button to the matching ingest.ts action', async () => {
    const wrapper = mount(GalleryToolbar)
    await nextTick()
    await nextTick()

    await wrapper.find('.toolbar-button').trigger('click')
    expect(addViaFilePicker).toHaveBeenCalledOnce()

    await wrapper.find('.quiet').trigger('click')
    expect(clearGallery).toHaveBeenCalledOnce()
  })

  it('is one switch that defaults to grid (unchecked) and announces the active view (R-K6)', () => {
    const wrapper = mount(GalleryToolbar)
    const toggle = wrapper.get('[data-testid="gallery-view-toggle"]')

    expect(toggle.attributes('role')).toBe('switch')
    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('clicking anywhere on the toggle switches the store view and aria-checked state', async () => {
    const wrapper = mount(GalleryToolbar)
    const toggle = wrapper.get('[data-testid="gallery-view-toggle"]')

    await toggle.trigger('click')

    expect(useUiStore().galleryView).toBe('list')
    expect(toggle.attributes('aria-checked')).toBe('true')
  })

  it('clicking again switches back to grid and marks it a manual override', async () => {
    const wrapper = mount(GalleryToolbar)
    useUiStore().setGalleryView('list')
    await nextTick()

    await wrapper.get('[data-testid="gallery-view-toggle"]').trigger('click')

    const uiStore = useUiStore()
    expect(uiStore.galleryView).toBe('grid')
    expect(uiStore.galleryViewOverridden).toBe(true)
  })
})
