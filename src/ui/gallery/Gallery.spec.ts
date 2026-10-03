import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'

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

const serviceMock = {
  setVisible: vi.fn(),
  urlFor: vi.fn(() => null as string | null),
  stop: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
  stats: vi.fn(),
  whenIdle: vi.fn(),
}
vi.mock('./thumbnail-service', () => ({
  getThumbnailService: () => serviceMock,
  thumbnailTick: { value: 0 },
}))

const Gallery = (await import('./Gallery.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  ingestDrop.mockReset()
  removeIngestedImage.mockReset()
  dimensionErrors.clear()
  getCapabilities.mockResolvedValue({ opfs: true, folderPicker: false, crossOriginIsolated: false })
  serviceMock.setVisible.mockReset()
  serviceMock.urlFor.mockReset().mockReturnValue(null)
  serviceMock.stop.mockReset()
})

describe('Gallery', () => {
  it('shows the empty state when the batch has no images', () => {
    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(false)
  })

  it('shows the header and the virtualized grid once the batch has images', () => {
    useBatchStore().addImages([
      { ...imageRecordFixture, id: 'a' as ImageId, edit: null, relativePath: null },
    ])

    const wrapper = mount(Gallery)
    expect(wrapper.find('[data-testid="gallery-empty-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('SELECTED IMAGES')
  })

  it('forwards a drop event to ingestDrop', async () => {
    const wrapper = mount(Gallery)
    const dataTransfer = {} as DataTransfer

    await wrapper.find('[data-testid="gallery-root"]').trigger('drop', { dataTransfer })

    expect(ingestDrop).toHaveBeenCalledWith(dataTransfer)
  })

  it('renders the grid, not the list, by default (R-G8)', () => {
    useBatchStore().addImages([
      { ...imageRecordFixture, id: 'a' as ImageId, edit: null, relativePath: null },
    ])

    const wrapper = mount(Gallery)

    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-list"]').exists()).toBe(false)
  })

  it('renders the list instead of the grid once galleryView is list (R-G7)', async () => {
    useBatchStore().addImages([
      { ...imageRecordFixture, id: 'a' as ImageId, edit: null, relativePath: null },
    ])
    const wrapper = mount(Gallery)

    useUiStore().setGalleryView('list')
    await nextTick()

    expect(wrapper.find('[data-testid="gallery-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gallery-grid"]').exists()).toBe(false)
  })

  it('stops grid thumbnail generation when switching to list mode (R-G12)', async () => {
    useBatchStore().addImages([
      { ...imageRecordFixture, id: 'a' as ImageId, edit: null, relativePath: null },
    ])
    mount(Gallery)
    await nextTick()

    useUiStore().setGalleryView('list')
    await nextTick()

    expect(serviceMock.stop).toHaveBeenCalledTimes(1)
    const callsAfterStop = serviceMock.setVisible.mock.calls.length
    await nextTick()
    expect(serviceMock.setVisible.mock.calls.length).toBe(callsAfterStop)
  })
})
