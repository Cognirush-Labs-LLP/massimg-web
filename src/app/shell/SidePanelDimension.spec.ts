import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidePanelDimension from './SidePanelDimension.vue'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import type { ImageId, ImageRecord } from '@/domain/types'

let nextId = 0

function image(overrides: Partial<ImageRecord> = {}): ImageRecord {
  nextId += 1

  return {
    id: `image-${nextId}` as ImageId,
    name: 'photo.jpg',
    relativePath: null,
    sizeBytes: 500_000,
    width: 4000,
    height: 3000,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: false,
    edit: null,
    status: 'ready',
    failure: null,
    skipReason: null,
    ...overrides,
  }
}

const CROP_EDIT = {
  ops: [
    {
      kind: 'crop' as const,
      rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      zoom: 1.25,
      background: { r: 255, g: 255, b: 255, a: 1 },
    },
  ],
  version: 1,
}

beforeEach(() => {
  setActivePinia(createPinia())
  nextId = 0
})

describe('SidePanelDimension', () => {
  it('defaults to Original size selected, no note, accordion enabled', () => {
    const wrapper = mount(SidePanelDimension)

    expect(
      wrapper.find<HTMLInputElement>('[data-testid="dimension-row-original"]').element.checked,
    ).toBe(true)
    expect(wrapper.find('[data-testid="dimension-note-single"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dimension-note-multi"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dimension-row-fit-long-edge"]').attributes('disabled')).toBe(
      undefined,
    )
  })

  it('selecting Fit within long edge writes the default pixel value to the store', async () => {
    const wrapper = mount(SidePanelDimension)

    await wrapper.find('[data-testid="dimension-row-fit-long-edge"]').trigger('change')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fit-long-edge', pixels: 1920 })
    expect(wrapper.find('[data-testid="dimension-field-fit-long-edge"]').exists()).toBe(true)
  })

  it('selecting a different row collapses the previous row (mutual exclusivity)', async () => {
    const wrapper = mount(SidePanelDimension)
    await wrapper.find('[data-testid="dimension-row-fit-long-edge"]').trigger('change')

    await wrapper.find('[data-testid="dimension-row-fixed-width"]').trigger('change')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fixed-width', pixels: 1080 })
    expect(wrapper.find('[data-testid="dimension-field-fit-long-edge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dimension-field-fixed-width"]').exists()).toBe(true)
  })

  it('typing into the numeric field writes the store', async () => {
    const wrapper = mount(SidePanelDimension)
    await wrapper.find('[data-testid="dimension-row-fixed-height"]').trigger('change')

    await wrapper.find('[data-testid="dimension-field-fixed-height"]').setValue('900')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fixed-height', pixels: 900 })
  })

  it('a chip sets the field value and writes the store', async () => {
    const wrapper = mount(SidePanelDimension)
    await wrapper.find('[data-testid="dimension-row-fixed-width"]').trigger('change')

    await wrapper.find('[data-testid="dimension-chip-fixed-width-1200"]').trigger('click')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fixed-width', pixels: 1200 })
    expect(
      wrapper.find<HTMLInputElement>('[data-testid="dimension-field-fixed-width"]').element.value,
    ).toBe('1200')
  })

  it('shows an exact long-edge value written externally by a recovery action', async () => {
    const wrapper = mount(SidePanelDimension)

    useSettingsStore().dimension = { kind: 'fit-long-edge', pixels: 2997 }
    await nextTick()

    expect(
      wrapper.find<HTMLInputElement>('[data-testid="dimension-field-fit-long-edge"]').element.value,
    ).toBe('2997')
  })

  it('switching back to a previously visited row keeps its last typed value', async () => {
    const wrapper = mount(SidePanelDimension)
    await wrapper.find('[data-testid="dimension-row-fit-long-edge"]').trigger('change')
    await wrapper.find('[data-testid="dimension-field-fit-long-edge"]').setValue('2200')
    await wrapper.find('[data-testid="dimension-row-fixed-width"]').trigger('change')

    await wrapper.find('[data-testid="dimension-row-fit-long-edge"]').trigger('change')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fit-long-edge', pixels: 2200 })
  })

  it('R-D2: shows the multi-crop note (not disabled) with more than one image and some cropped', () => {
    useBatchStore().addImages([image({ edit: CROP_EDIT }), image(), image()])

    const wrapper = mount(SidePanelDimension)

    expect(wrapper.find('[data-testid="dimension-note-multi"]').text()).toContain(
      'Crop applied to 1 images',
    )
    expect(wrapper.find('[data-testid="dimension-row-fit-long-edge"]').attributes('disabled')).toBe(
      undefined,
    )
  })

  it('R-D3: disables the accordion with a note when the sole image is cropped', () => {
    useBatchStore().addImages([image({ edit: CROP_EDIT })])

    const wrapper = mount(SidePanelDimension)

    expect(wrapper.find('[data-testid="dimension-note-single"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="dimension-row-fit-long-edge"]').attributes('disabled')).toBe(
      '',
    )
  })

  it('a disabled accordion ignores row-selection attempts', async () => {
    useBatchStore().addImages([image({ edit: CROP_EDIT })])
    const wrapper = mount(SidePanelDimension)

    await wrapper.find('[data-testid="dimension-row-fit-long-edge"]').trigger('change')

    expect(useSettingsStore().dimension).toEqual({ kind: 'original' })
  })

  it('does not show the multi note or disable when no image is cropped', () => {
    useBatchStore().addImages([image(), image()])

    const wrapper = mount(SidePanelDimension)

    expect(wrapper.find('[data-testid="dimension-note-multi"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dimension-row-fit-long-edge"]').attributes('disabled')).toBe(
      undefined,
    )
  })
})
