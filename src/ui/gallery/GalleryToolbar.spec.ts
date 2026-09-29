import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const addViaFilePicker = vi.fn()
const addViaFolderPicker = vi.fn()
const clearGallery = vi.fn()
vi.mock('./ingest', () => ({ addViaFilePicker, addViaFolderPicker, clearGallery }))

const getCapabilities = vi.fn()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilities() }))

const GalleryToolbar = (await import('./GalleryToolbar.vue')).default

beforeEach(() => {
  addViaFilePicker.mockReset()
  addViaFolderPicker.mockReset()
  clearGallery.mockReset()
  getCapabilities.mockResolvedValue({ opfs: true, folderPicker: true, crossOriginIsolated: false })
})

describe('GalleryToolbar', () => {
  it("renders Add images and Clear, with no grid/list toggle (that is T34's job)", () => {
    const wrapper = mount(GalleryToolbar)
    expect(wrapper.text()).toContain('Add images')
    expect(wrapper.text()).toContain('Clear')
    expect(wrapper.find('[data-testid="gallery-view-toggle"]').exists()).toBe(false)
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
})
