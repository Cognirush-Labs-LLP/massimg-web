import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const addViaFilePicker = vi.fn()
const addViaFolderPicker = vi.fn()
vi.mock('./ingest', () => ({ addViaFilePicker, addViaFolderPicker }))

const getCapabilities = vi.fn()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilities() }))

const GalleryEmptyState = (await import('./GalleryEmptyState.vue')).default

beforeEach(() => {
  addViaFilePicker.mockReset()
  addViaFolderPicker.mockReset()
  getCapabilities.mockReset()
})

describe('GalleryEmptyState', () => {
  it('shows the headline, formats line and Select images button; hides Select folder until capability resolves', async () => {
    getCapabilities.mockResolvedValue({
      opfs: true,
      folderPicker: true,
      crossOriginIsolated: false,
    })
    const wrapper = mount(GalleryEmptyState)

    expect(wrapper.text()).toContain('Drop images to compress')
    expect(wrapper.find('.select-images').exists()).toBe(true)
    // R-I31: hidden until the capability probe resolves, SSR-safe default is false.
    expect(wrapper.find('.select-folder').exists()).toBe(false)

    await flushCapabilityProbe()
    expect(wrapper.find('.select-folder').exists()).toBe(true)
  })

  it('never shows Select folder when the platform has no folder picker', async () => {
    getCapabilities.mockResolvedValue({
      opfs: true,
      folderPicker: false,
      crossOriginIsolated: false,
    })
    const wrapper = mount(GalleryEmptyState)
    await flushCapabilityProbe()

    expect(wrapper.find('.select-folder').exists()).toBe(false)
  })

  it('calls addViaFilePicker/addViaFolderPicker on click', async () => {
    getCapabilities.mockResolvedValue({
      opfs: true,
      folderPicker: true,
      crossOriginIsolated: false,
    })
    const wrapper = mount(GalleryEmptyState)
    await flushCapabilityProbe()

    await wrapper.find('.select-images').trigger('click')
    expect(addViaFilePicker).toHaveBeenCalledOnce()

    await wrapper.find('.select-folder').trigger('click')
    expect(addViaFolderPicker).toHaveBeenCalledOnce()
  })
})

async function flushCapabilityProbe(): Promise<void> {
  // getCapabilities() resolves a microtask after onMounted; two ticks is enough for both the
  // promise resolution and the reactive re-render it triggers.
  await nextTick()
  await nextTick()
}
