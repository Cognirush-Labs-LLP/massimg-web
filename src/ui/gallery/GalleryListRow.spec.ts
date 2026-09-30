import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useUiStore } from '@/stores/ui'

const removeIngestedImage = vi.fn()
const dimensionErrors = new Set<ImageId>()
vi.mock('./ingest', () => ({ removeIngestedImage, dimensionErrors }))

const getThumbnailService = vi.fn(() => {
  throw new Error('list mode must never touch the thumbnail service (R-G9)')
})
vi.mock('./thumbnail-service', () => ({ getThumbnailService }))

const GalleryListRow = (await import('./GalleryListRow.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  removeIngestedImage.mockReset()
  dimensionErrors.clear()
  getThumbnailService.mockClear()
})

describe('GalleryListRow', () => {
  it('shows the relative directory plus filename for a folder-sourced image', () => {
    const wrapper = mount(GalleryListRow, {
      props: { image: { ...imageRecordFixture, relativePath: 'photos/sub/portrait.PNG' } },
    })
    expect(wrapper.find('.directory').text()).toBe('photos/sub/')
    expect(wrapper.find('.filename').text()).toContain('portrait.PNG')
  })

  it('shows only the filename for a loose (non-folder) image', () => {
    const wrapper = mount(GalleryListRow, {
      props: { image: { ...imageRecordFixture, relativePath: null } },
    })
    expect(wrapper.find('.directory').exists()).toBe(false)
    expect(wrapper.find('.filename').text()).toBe(imageRecordFixture.name)
  })

  it('shows only the filename for a folder-root image with no subdirectory', () => {
    const wrapper = mount(GalleryListRow, {
      props: { image: { ...imageRecordFixture, relativePath: 'portrait.PNG' } },
    })
    expect(wrapper.find('.directory').exists()).toBe(false)
  })

  it('shows EDITED then ANIMATED then FAILED badges in that fixed order', () => {
    const wrapper = mount(GalleryListRow, {
      props: { image: { ...imageRecordFixture, isAnimated: true, status: 'failed' } },
    })
    const badgeTexts = wrapper.findAll('.badge').map((badge) => badge.text())
    expect(badgeTexts).toEqual(['EDITED', 'ANIMATED', 'FAILED'])
  })

  it('shows the pending placeholder for width/height still at 0', () => {
    const wrapper = mount(GalleryListRow, {
      props: { image: { ...imageRecordFixture, width: 0, height: 0 } },
    })
    expect(wrapper.find('.meta').text()).toContain('–×–')
  })

  it('shows an error in place of dimensions when the probe failed for this image', () => {
    dimensionErrors.add(imageRecordFixture.id)
    const wrapper = mount(GalleryListRow, { props: { image: imageRecordFixture } })
    expect(wrapper.find('.meta').text()).toContain('Error')
  })

  it('clicking the row opens Preview for that image (R-G1)', async () => {
    const wrapper = mount(GalleryListRow, { props: { image: imageRecordFixture } })
    await wrapper.find('[data-testid="gallery-list-row-open"]').trigger('click')

    const uiStore = useUiStore()
    expect(uiStore.stageMode).toBe('preview')
    expect(uiStore.currentImageId).toBe(imageRecordFixture.id)
  })

  it('clicking remove calls removeIngestedImage and does not open Preview (R-G2)', async () => {
    const wrapper = mount(GalleryListRow, { props: { image: imageRecordFixture } })
    await wrapper.find('[data-testid="gallery-list-row-remove"]').trigger('click')

    expect(removeIngestedImage).toHaveBeenCalledWith(imageRecordFixture.id)
    expect(useUiStore().stageMode).toBe('gallery')
  })

  it('never calls into the thumbnail service (R-G9)', async () => {
    const wrapper = mount(GalleryListRow, { props: { image: imageRecordFixture } })
    await wrapper.find('[data-testid="gallery-list-row-open"]').trigger('click')

    expect(getThumbnailService).not.toHaveBeenCalled()
  })
})
