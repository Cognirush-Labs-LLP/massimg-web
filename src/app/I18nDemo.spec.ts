import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import I18nDemo from '@/app/I18nDemo.vue'

// Proof required by docs/tasks.md T08's Done-when condition: "a component
// renders a parameterised string correctly."
describe('I18nDemo', () => {
  it('renders the plain-string key verbatim', () => {
    const wrapper = mount(I18nDemo)
    expect(wrapper.get('[data-testid="i18n-demo-plain"]').text()).toBe('Your Images')
  })

  it('renders the uppercase section-heading key verbatim', () => {
    const wrapper = mount(I18nDemo)
    expect(wrapper.get('[data-testid="i18n-demo-heading"]').text()).toBe('QUALITY')
  })

  it('renders the parameterised string with its {count} placeholder interpolated', () => {
    const wrapper = mount(I18nDemo)
    // The component calls t('action.compressLabel', { count: 4 }) — assert
    // the real, interpolated value made it to the DOM, not the raw
    // "Compress ({count})" template.
    expect(wrapper.get('[data-testid="i18n-demo-parameterised"]').text()).toBe('Compress (4)')
  })
})
