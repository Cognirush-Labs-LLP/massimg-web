import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidePanelFormat from './SidePanelFormat.vue'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { imageRecordFixture } from '@/domain/types.fixtures'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SidePanelFormat', () => {
  it('defaults to "Don\'t change" selected and no GIF warning', () => {
    const wrapper = mount(SidePanelFormat)

    expect(wrapper.find<HTMLSelectElement>('[data-testid="format-select"]').element.value).toBe(
      'dont-change',
    )
    expect(wrapper.find('[data-testid="format-gif-warning"]').exists()).toBe(false)
  })

  it('lists the six options in Functional Design §4.3 order', () => {
    const wrapper = mount(SidePanelFormat)
    const options = wrapper.findAll('option')

    expect(options.map((option) => option.element.value)).toEqual([
      'dont-change',
      'jpeg',
      'png',
      'webp',
      'avif',
      'gif',
    ])
    expect(options.map((option) => option.text())).toEqual([
      'Don’t change',
      'JPEG',
      'PNG',
      'WebP',
      'AVIF',
      'GIF',
    ])
  })

  it('selecting a format writes the store', async () => {
    const wrapper = mount(SidePanelFormat)

    await wrapper.find('[data-testid="format-select"]').setValue('webp')

    expect(useSettingsStore().format).toBe('webp')
  })

  it('selecting GIF shows the inline warning; switching away hides it', async () => {
    const wrapper = mount(SidePanelFormat)

    await wrapper.find('[data-testid="format-select"]').setValue('gif')
    expect(wrapper.find('[data-testid="format-gif-warning"]').exists()).toBe(true)

    await wrapper.find('[data-testid="format-select"]').setValue('jpeg')
    expect(wrapper.find('[data-testid="format-gif-warning"]').exists()).toBe(false)
  })

  describe('WebP for animated images', () => {
    const checkbox = '[data-testid="format-animated-webp"]'
    const hint = '[data-testid="format-animated-hint"]'

    it.each(['dont-change', 'png', 'webp', 'gif'] as const)(
      'is not offered for %s',
      async (value) => {
        const wrapper = mount(SidePanelFormat)

        await wrapper.find('[data-testid="format-select"]').setValue(value)

        expect(wrapper.find(checkbox).exists()).toBe(false)
      },
    )

    it.each(['jpeg', 'avif'] as const)(
      'is offered for %s, checked, even with no images in the batch',
      async (value) => {
        const wrapper = mount(SidePanelFormat)

        await wrapper.find('[data-testid="format-select"]').setValue(value)

        expect(wrapper.find<HTMLInputElement>(checkbox).element.checked).toBe(true)
        expect(wrapper.find(hint).exists()).toBe(false)
      },
    )

    it('writes the store when toggled', async () => {
      const wrapper = mount(SidePanelFormat)
      await wrapper.find('[data-testid="format-select"]').setValue('jpeg')

      await wrapper.find(checkbox).setValue(false)

      expect(useSettingsStore().animatedAsWebp).toBe(false)
    })

    it('counts the animated images and warns once the box is unchecked', async () => {
      useBatchStore().addImages([
        { ...imageRecordFixture, id: 'a' as typeof imageRecordFixture.id, isAnimated: true },
        { ...imageRecordFixture, id: 'b' as typeof imageRecordFixture.id, isAnimated: true },
        { ...imageRecordFixture, id: 'c' as typeof imageRecordFixture.id, isAnimated: false },
      ])
      const wrapper = mount(SidePanelFormat)
      await wrapper.find('[data-testid="format-select"]').setValue('jpeg')

      expect(wrapper.get(hint).text()).toContain('2')
      expect(wrapper.get(hint).text()).toContain('animated WebP')
      expect(wrapper.get(hint).classes()).not.toContain('format-note-warning')

      await wrapper.find(checkbox).setValue(false)

      expect(wrapper.get(hint).text()).toContain('first frame')
      expect(wrapper.get(hint).classes()).toContain('format-note-warning')
    })
  })
})
