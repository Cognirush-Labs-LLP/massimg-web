import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'

const dimensionErrors = new Set<ImageId>()
const removeIngestedImage = vi.fn()
vi.mock('./ingest', () => ({ dimensionErrors, removeIngestedImage }))

const getThumbnailService = vi.fn(() => {
  throw new Error('list mode must never touch the thumbnail service (R-G9)')
})
vi.mock('./thumbnail-service', () => ({ getThumbnailService }))

const GalleryList = (await import('./GalleryList.vue')).default

function image(id: string, relativePath: string | null) {
  return { ...imageRecordFixture, id: id as ImageId, edit: null, relativePath }
}

beforeEach(() => {
  setActivePinia(createPinia())
  dimensionErrors.clear()
  removeIngestedImage.mockReset()
  getThumbnailService.mockClear()
})

describe('GalleryList', () => {
  it('renders every row with no group header for a flat batch', () => {
    useBatchStore().addImages([image('a', null), image('b', null)])

    const wrapper = mount(GalleryList)

    expect(wrapper.findAll('[data-testid="gallery-list-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="gallery-list-group-header"]').exists()).toBe(false)
  })

  it('groups folder-sourced rows under directory headers, in first-seen order', () => {
    useBatchStore().addImages([
      image('a', 'root.jpg'),
      image('b', 'sub/b.jpg'),
      image('c', 'sub2/c.jpg'),
    ])

    const wrapper = mount(GalleryList)

    const headers = wrapper.findAll('[data-testid="gallery-list-group-header"]')
    expect(headers.map((h) => h.text())).toEqual(['sub', 'sub2'])
    expect(wrapper.findAll('[data-testid="gallery-list-row"]')).toHaveLength(3)
  })

  it('splits a mixed batch: loose/root-level images ungrouped, subdirectory images headered', () => {
    useBatchStore().addImages([image('a', null), image('b', 'sub/b.jpg')])

    const wrapper = mount(GalleryList)

    expect(wrapper.findAll('[data-testid="gallery-list-group-header"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="gallery-list-row"]')).toHaveLength(2)
  })

  it('never touches the thumbnail service (R-G9, R-G12)', () => {
    useBatchStore().addImages([image('a', null)])

    mount(GalleryList)

    expect(getThumbnailService).not.toHaveBeenCalled()
  })
})
