import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'

const ingestDrop = vi.fn()
const removeIngestedImage = vi.fn()
const dimensionErrors = reactive(new Set<ImageId>())
vi.mock('./ingest', () => ({
  ingestDrop,
  addViaFilePicker: vi.fn(),
  addViaFolderPicker: vi.fn(),
  removeIngestedImage,
  dimensionErrors,
}))

const getCapabilities = vi.fn()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilities() }))

const Gallery = (await import('./Gallery.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  ingestDrop.mockReset()
  removeIngestedImage.mockReset()
  dimensionErrors.clear()
  getCapabilities.mockResolvedValue({ opfs: true, folderPicker: false, crossOriginIsolated: false })
})

describe('Gallery', () => {
  it('shows the empty state when the batch has no images', () => {
    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(false)
  })

  it('shows the header and the virtualized grid once the batch has images', () => {
    useBatchStore().addImages([{ ...imageRecordFixture, id: 'a' as ImageId, edit: null }])

    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Your Images')
  })

  it('forwards a drop event to ingestDrop', async () => {
    const wrapper = mount(Gallery)
    const dataTransfer = {} as DataTransfer

    await wrapper.find('[data-testid="gallery-root"]').trigger('drop', { dataTransfer })

    expect(ingestDrop).toHaveBeenCalledWith(dataTransfer)
  })
})
