import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidePanelQuality from './SidePanelQuality.vue'
import { useSettingsStore } from '@/stores/settings'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SidePanelQuality', () => {
  it('defaults to the Quality target, slider at 70, MED chip active', () => {
    const wrapper = mount(SidePanelQuality)

    expect(wrapper.find('[data-testid="quality-target-quality"]').attributes('aria-pressed')).toBe(
      'true',
    )
    expect(wrapper.find<HTMLInputElement>('[data-testid="quality-slider"]').element.value).toBe(
      '70',
    )
    expect(wrapper.find('[data-testid="quality-chip-med"]').classes()).toContain('active')
    expect(wrapper.find('[data-testid="quality-chip-low"]').classes()).not.toContain('active')
  })

  it('dragging the slider writes settings.quality.value', async () => {
    const wrapper = mount(SidePanelQuality)
    const slider = wrapper.find('[data-testid="quality-slider"]')

    await slider.setValue('55')

    expect(useSettingsStore().quality).toEqual({ kind: 'quality', value: 55 })
  })

  it('a chip sets the slider value directly (still freely adjustable after)', async () => {
    const wrapper = mount(SidePanelQuality)

    await wrapper.find('[data-testid="quality-chip-low"]').trigger('click')

    expect(useSettingsStore().quality).toEqual({ kind: 'quality', value: 40 })
  })

  it('switching to Size target writes a size setting and shows the field + unit toggle', async () => {
    const wrapper = mount(SidePanelQuality)

    await wrapper.find('[data-testid="quality-target-size"]').trigger('click')

    expect(useSettingsStore().quality.kind).toBe('size')
    expect(wrapper.find('[data-testid="quality-size-field"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="quality-unit-kb"]').attributes('aria-pressed')).toBe('true')
  })

  it('the size field writes targetBytes in KB by default', async () => {
    const wrapper = mount(SidePanelQuality)
    await wrapper.find('[data-testid="quality-target-size"]').trigger('click')

    await wrapper.find('[data-testid="quality-size-field"]').setValue('500')

    expect(useSettingsStore().quality).toEqual({ kind: 'size', targetBytes: 500 * 1024 })
  })

  it('switching the unit recomputes bytes from the same displayed number, not the stored bytes', async () => {
    const wrapper = mount(SidePanelQuality)
    await wrapper.find('[data-testid="quality-target-size"]').trigger('click')
    await wrapper.find('[data-testid="quality-size-field"]').setValue('500')

    await wrapper.find('[data-testid="quality-unit-mb"]').trigger('click')

    expect(useSettingsStore().quality).toEqual({ kind: 'size', targetBytes: 500 * 1024 * 1024 })
    expect(wrapper.find<HTMLInputElement>('[data-testid="quality-size-field"]').element.value).toBe(
      '500',
    )
  })

  it('switching back to Quality target after Size resets to the store default of 70', async () => {
    const wrapper = mount(SidePanelQuality)
    await wrapper.find('[data-testid="quality-target-size"]').trigger('click')
    await wrapper.find('[data-testid="quality-size-field"]').setValue('500')

    await wrapper.find('[data-testid="quality-target-quality"]').trigger('click')

    expect(useSettingsStore().quality).toEqual({ kind: 'quality', value: 70 })
  })

  it('the Size target is not disabled today (T30/D1 found no prohibitive format)', () => {
    const wrapper = mount(SidePanelQuality)

    expect(
      wrapper.find('[data-testid="quality-target-size"]').attributes('disabled'),
    ).toBeUndefined()
  })
})
