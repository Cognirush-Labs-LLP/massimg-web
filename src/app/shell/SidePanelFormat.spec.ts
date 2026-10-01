import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidePanelFormat from './SidePanelFormat.vue'
import { useSettingsStore } from '@/stores/settings'

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
})
