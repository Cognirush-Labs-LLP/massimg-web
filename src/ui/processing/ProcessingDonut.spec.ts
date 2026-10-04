import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProcessingDonut from './ProcessingDonut.vue'

describe('ProcessingDonut', () => {
  it('is decorative: aria-hidden and no text content anywhere', () => {
    const wrapper = mount(ProcessingDonut, {
      props: { succeeded: 3, failed: 1, skipped: 1, pending: 5 },
    })

    const svg = wrapper.get('[data-testid="processing-donut"]')
    expect(svg.attributes('aria-hidden')).toBe('true')
    // The whole point of R-X4: no number may exist only inside the chart. This component renders
    // no <text> at all — every number lives in Processing.vue's own sibling markup instead.
    expect(wrapper.text()).toBe('')
    expect(wrapper.find('text').exists()).toBe(false)
  })

  it('renders one segment per non-zero category, sized to its share of the total', () => {
    const wrapper = mount(ProcessingDonut, {
      props: { succeeded: 5, failed: 0, skipped: 0, pending: 5 },
    })

    const segments = wrapper.findAll('.segment')
    expect(segments).toHaveLength(2)
    expect(segments[0]?.attributes('stroke-dasharray')).toBe('50 50')
    expect(segments[0]?.attributes('stroke-dashoffset')).toBe('0')
    expect(segments[1]?.attributes('stroke-dasharray')).toBe('50 50')
    expect(segments[1]?.attributes('stroke-dashoffset')).toBe('-50')
  })

  it('omits a zero-count category entirely rather than drawing an empty segment', () => {
    const wrapper = mount(ProcessingDonut, {
      props: { succeeded: 0, failed: 0, skipped: 0, pending: 10 },
    })

    expect(wrapper.findAll('.segment')).toHaveLength(1)
  })

  it('renders no segments at all for an empty batch', () => {
    const wrapper = mount(ProcessingDonut, {
      props: { succeeded: 0, failed: 0, skipped: 0, pending: 0 },
    })

    expect(wrapper.findAll('.segment')).toHaveLength(0)
  })
})
