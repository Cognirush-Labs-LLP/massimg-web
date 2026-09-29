import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'

const ingestDrop = vi.fn()
vi.mock('./ingest', () => ({ ingestDrop, addViaFilePicker: vi.fn(), addViaFolderPicker: vi.fn() }))

const getCapabilities = vi.fn()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilities() }))

const Gallery = (await import('./Gallery.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  ingestDrop.mockReset()
  getCapabilities.mockResolvedValue({ opfs: true, folderPicker: false, crossOriginIsolated: false })
})

describe('Gallery', () => {
  it('shows the empty state when the batch has no images', () => {
    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-placeholder"]').exists()).toBe(false)
  })

  it('shows the (still-placeholder) populated view once the batch has images', () => {
    useBatchStore().addImages([{ ...imageRecordFixture, id: 'a' as ImageId, edit: null }])

    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gallery-placeholder"]').exists()).toBe(true)
  })

  it('forwards a drop event to ingestDrop', async () => {
    const wrapper = mount(Gallery)
    const dataTransfer = {} as DataTransfer

    await wrapper.find('[data-testid="gallery-root"]').trigger('drop', { dataTransfer })

    expect(ingestDrop).toHaveBeenCalledWith(dataTransfer)
  })
})
