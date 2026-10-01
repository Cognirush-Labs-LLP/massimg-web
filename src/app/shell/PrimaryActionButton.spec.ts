import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimaryActionButton from './PrimaryActionButton.vue'

describe('PrimaryActionButton', () => {
  it('renders the meta line when given one (R-A2, R-F4)', () => {
    const wrapper = mount(PrimaryActionButton, {
      props: { count: 6, disabled: false, metaLine: '6 images · Original formats · ZIP' },
    })

    expect(wrapper.find('[data-testid="primary-action-meta"]').text()).toBe(
      '6 images · Original formats · ZIP',
    )
  })

  it('renders no meta line element when metaLine is omitted', () => {
    const wrapper = mount(PrimaryActionButton, { props: { count: 0, disabled: true } })

    expect(wrapper.find('[data-testid="primary-action-meta"]').exists()).toBe(false)
  })

  it('renders no meta line element when metaLine is an empty string', () => {
    const wrapper = mount(PrimaryActionButton, {
      props: { count: 0, disabled: true, metaLine: '' },
    })

    expect(wrapper.find('[data-testid="primary-action-meta"]').exists()).toBe(false)
  })
})
