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

  // R-V1/R-V3. Two sentences in two elements, neither a link: the claim must be readable as
  // whole sentences (R-L5), and the footer on the same screen owns the Privacy link.
  it('states the privacy claim and the analytics disclosure as two separate sentences', async () => {
    getCapabilities.mockResolvedValue({
      opfs: true,
      folderPicker: true,
      crossOriginIsolated: false,
    })
    const wrapper = mount(GalleryEmptyState)
    const sentences = wrapper.findAll('.privacy p')

    expect(sentences).toHaveLength(2)
    expect(sentences[0]?.text()).toContain('never uploaded')
    expect(sentences[0]?.text()).toContain('Share')
    expect(sentences[1]?.text()).toContain('cookie-free analytics')
    expect(wrapper.find('.privacy a').exists()).toBe(false)
  })

  it('states the privacy claim whether or not the platform offers a folder picker', async () => {
    getCapabilities.mockResolvedValue({
      opfs: true,
      folderPicker: false,
      crossOriginIsolated: false,
    })
    const wrapper = mount(GalleryEmptyState)
    await flushCapabilityProbe()

    expect(wrapper.findAll('.privacy p')).toHaveLength(2)
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
