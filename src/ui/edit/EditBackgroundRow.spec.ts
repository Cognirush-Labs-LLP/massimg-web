import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PixelSize } from '@/domain/edit'
import type { ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import EditBackgroundRow from './EditBackgroundRow.vue'

const FRAME: PixelSize = { width: 400, height: 400 }

function seedAndInit(overrides: Partial<ImageRecord> = {}): ImageRecord {
  const image: ImageRecord = { ...imageRecordFixture, edit: null, ...overrides }
  useBatchStore().addImages([image])
  useUiStore().openEdit(image.id)
  useEditDraftStore().initFor(image, FRAME)
  return image
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('EditBackgroundRow', () => {
  it('shows the Transparent swatch and no hint for an alpha-capable format (R-C13)', () => {
    seedAndInit({ sourceFormat: 'png' })
    useSettingsStore().format = 'dont-change'
    const wrapper = mount(EditBackgroundRow)

    expect(wrapper.find('[data-testid="edit-background-transparent"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="edit-background-jpeg-hint"]').exists()).toBe(false)
  })

  it('hides the Transparent swatch and shows the hint for JPEG (R-C14)', () => {
    seedAndInit({ sourceFormat: 'png' })
    useSettingsStore().format = 'jpeg'
    const wrapper = mount(EditBackgroundRow)

    expect(wrapper.find('[data-testid="edit-background-transparent"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="edit-background-jpeg-hint"]').text()).toBe(
      'JPEG has no transparency — pick a fill colour.',
    )
  })

  it('reacts live to a format change made while Edit mode is open', async () => {
    seedAndInit({ sourceFormat: 'png' })
    const settings = useSettingsStore()
    settings.format = 'dont-change'
    const wrapper = mount(EditBackgroundRow)
    expect(wrapper.find('[data-testid="edit-background-transparent"]').exists()).toBe(true)

    settings.format = 'jpeg'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="edit-background-transparent"]').exists()).toBe(false)
  })

  it('clicking a swatch writes that colour to the draft store', async () => {
    seedAndInit({ sourceFormat: 'png' })
    useSettingsStore().format = 'dont-change'
    const wrapper = mount(EditBackgroundRow)

    await wrapper.get('[data-testid="edit-background-white"]').trigger('click')

    expect(useEditDraftStore().background).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('the native colour picker always yields full opacity', async () => {
    seedAndInit({ sourceFormat: 'png' })
    useSettingsStore().format = 'dont-change'
    const wrapper = mount(EditBackgroundRow)
    const picker = wrapper.get('[data-testid="edit-background-picker"]')

    await picker.setValue('#336699')

    expect(useEditDraftStore().background).toEqual({ r: 0x33, g: 0x66, b: 0x99, a: 1 })
  })
})
