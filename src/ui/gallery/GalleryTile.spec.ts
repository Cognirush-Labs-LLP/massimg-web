import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

const removeIngestedImage = vi.fn()
const dimensionErrors = new Set<ImageId>()
vi.mock('./ingest', () => ({ removeIngestedImage, dimensionErrors }))

const GalleryTile = (await import('./GalleryTile.vue')).default

beforeEach(() => {
  setActivePinia(createPinia())
  removeIngestedImage.mockReset()
  dimensionErrors.clear()
})

describe('GalleryTile', () => {
  it('renders the thumbnail image when a URL is available', () => {
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: 'blob:thumb', thumbSize: 200 },
    })
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('blob:thumb')
    expect(wrapper.find('.thumb').classes()).not.toContain('placeholder')
  })

  it('sizes the thumbnail box from the thumbSize prop, not the tile width', () => {
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: 'blob:thumb', thumbSize: 150 },
    })
    const style = wrapper.find('.thumb').attributes('style') ?? ''
    expect(style).toContain('150px')
  })

  it('renders a neutral placeholder, not an error, when no thumbnail URL is available', () => {
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: null, thumbSize: 200 },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.thumb').classes()).toContain('placeholder')
  })

  it('shows EDITED then ANIMATED then FAILED badges in that fixed order', () => {
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, isAnimated: true, status: 'failed' },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })
    const badgeTexts = wrapper.findAll('.badge').map((badge) => badge.text())
    expect(badgeTexts).toEqual(['EDITED', 'ANIMATED', 'FAILED'])
  })

  it('shows a completed size-ceiling skip distinctly from failure', () => {
    const wrapper = mount(GalleryTile, {
      props: {
        image: {
          ...imageRecordFixture,
          status: 'skipped',
          skipReason: {
            kind: 'size-target-unreachable',
            targetBytes: 100,
            achievedBytes: 150,
            format: 'png',
            width: 1000,
            height: 750,
          },
        },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })

    expect(wrapper.findAll('.badge').map((badge) => badge.text())).toContain('SKIPPED')
    expect(wrapper.text()).not.toContain('FAILED')
  })

  it('shows no badges for a plain, unedited, non-animated, successful image', () => {
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, edit: null, isAnimated: false },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })
    expect(wrapper.findAll('.badge')).toHaveLength(0)
  })

  it('swaps ANIMATED for FIRST FRAME when the format cannot animate and WebP is off', () => {
    const settings = useSettingsStore()
    settings.format = 'jpeg'
    settings.animatedAsWebp = false
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, edit: null, sourceFormat: 'gif', isAnimated: true },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })

    const badges = wrapper.findAll('.badge').map((badge) => badge.text())
    expect(badges).toContain('FIRST FRAME')
    expect(badges).not.toContain('ANIMATED')
  })

  it('keeps ANIMATED when the animation survives, including as WebP', () => {
    const settings = useSettingsStore()
    settings.format = 'jpeg'
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, edit: null, sourceFormat: 'gif', isAnimated: true },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })

    expect(wrapper.findAll('.badge').map((badge) => badge.text())).toEqual(['ANIMATED'])
  })

  it('shows the pending placeholder for width/height still at 0', () => {
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, width: 0, height: 0 },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })
    expect(wrapper.find('.meta').text()).toContain('–×–')
  })

  it('shows an error in place of dimensions when the probe failed for this image', () => {
    dimensionErrors.add(imageRecordFixture.id)
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: null, thumbSize: 200 },
    })
    expect(wrapper.find('.meta').text()).toContain('Error')
  })

  it('shows real W×H and the UI-formatted size once resolved', () => {
    const wrapper = mount(GalleryTile, {
      props: {
        image: { ...imageRecordFixture, width: 1600, height: 1200 },
        thumbnailUrl: null,
        thumbSize: 200,
      },
    })
    expect(wrapper.find('.meta').text()).toContain('1600×1200')
  })

  it('clicking the tile opens Preview for that image (R-G1)', async () => {
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: null, thumbSize: 200 },
    })
    await wrapper.find('.open-button').trigger('click')

    const uiStore = useUiStore()
    expect(uiStore.stageMode).toBe('preview')
    expect(uiStore.currentImageId).toBe(imageRecordFixture.id)
  })

  it('clicking remove calls removeIngestedImage and does not open Preview (R-G2)', async () => {
    const wrapper = mount(GalleryTile, {
      props: { image: imageRecordFixture, thumbnailUrl: null, thumbSize: 200 },
    })
    await wrapper.find('[data-testid="gallery-tile-remove"]').trigger('click')

    expect(removeIngestedImage).toHaveBeenCalledWith(imageRecordFixture.id)
    expect(useUiStore().stageMode).toBe('gallery')
  })
})
