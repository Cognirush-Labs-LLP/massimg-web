import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PreviewZoomToolbar from './PreviewZoomToolbar.vue'

describe('PreviewZoomToolbar', () => {
  it('shows the given percent', () => {
    const wrapper = mount(PreviewZoomToolbar, {
      props: { percent: 85, fitDisabled: false, actualSizeDisabled: false },
    })

    expect(wrapper.get('[data-testid="preview-zoom-readout"]').text()).toBe('85%')
  })

  it('emits fit and actualSize on click', async () => {
    const wrapper = mount(PreviewZoomToolbar, {
      props: { percent: 100, fitDisabled: false, actualSizeDisabled: false },
    })

    await wrapper.get('[data-testid="preview-zoom-fit"]').trigger('click')
    await wrapper.get('[data-testid="preview-zoom-actual-size"]').trigger('click')

    expect(wrapper.emitted('fit')).toHaveLength(1)
    expect(wrapper.emitted('actualSize')).toHaveLength(1)
  })

  it('disables Fit and Actual size independently', () => {
    const wrapper = mount(PreviewZoomToolbar, {
      props: { percent: 100, fitDisabled: true, actualSizeDisabled: false },
    })

    expect(wrapper.get('[data-testid="preview-zoom-fit"]').attributes('disabled')).toBeDefined()
    expect(
      wrapper.get('[data-testid="preview-zoom-actual-size"]').attributes('disabled'),
    ).toBeUndefined()
  })
})
