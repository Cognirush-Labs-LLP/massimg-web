import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PreviewComparisonPill from './PreviewComparisonPill.vue'

describe('PreviewComparisonPill', () => {
  it('shows the original size, the measured encoded size and the change', () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 512_000, compressedBytes: 256_000 },
    })

    expect(wrapper.get('[data-testid="preview-original-size"]').text()).toBe('512.00 KB')
    expect(wrapper.get('[data-testid="preview-compressed-size"]').text()).toBe('256.00 KB')
    expect(wrapper.get('[data-testid="preview-size-change"]').text()).toBe('50% ↓')
  })

  it('renders nothing at all while no measured result exists (R-P4)', () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 512_000, compressedBytes: null },
    })

    expect(wrapper.find('[data-testid="preview-comparison"]').exists()).toBe(false)
  })

  it('shows an increase with an up glyph and no tint colour (R-P5, R-K8)', () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 100_000, compressedBytes: 120_000 },
    })
    const change = wrapper.get('[data-testid="preview-size-change"]')

    expect(change.text()).toBe('20% ↑')
    expect(change.attributes('data-direction')).toBe('increase')
    expect(change.classes()).toContain('increase')
    expect(change.classes()).not.toContain('reduction')
  })

  it('never shows a real increase as zero (R-P5)', () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 1_000_000, compressedBytes: 1_000_100 },
    })

    expect(wrapper.get('[data-testid="preview-size-change"]').text()).toBe('<1% ↑')
  })

  it('reports an unchanged size as a plain zero with no direction glyph', () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 4096, compressedBytes: 4096 },
    })

    expect(wrapper.get('[data-testid="preview-size-change"]').text()).toBe('0%')
  })

  it('is one switch that announces which view is active (R-K6)', async () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 4096, compressedBytes: 2048 },
    })
    const toggle = wrapper.get('[data-testid="preview-comparison-toggle"]')

    expect(wrapper.findAll('[role="switch"]')).toHaveLength(1)
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(toggle.attributes('aria-label')).toBe('Show the compressed image')

    await wrapper.setProps({ tab: 'original' })

    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('marks the active half with more than colour', async () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 4096, compressedBytes: 2048 },
    })

    expect(wrapper.findAll('.half').map((half) => half.classes().includes('active'))).toEqual([
      false,
      true,
    ])

    await wrapper.setProps({ tab: 'original' })

    expect(wrapper.findAll('.half').map((half) => half.classes().includes('active'))).toEqual([
      true,
      false,
    ])
  })

  it('emits a single toggle from anywhere on the pill', async () => {
    const wrapper = mount(PreviewComparisonPill, {
      props: { tab: 'compressed', originalBytes: 4096, compressedBytes: 2048 },
    })

    await wrapper.get('[data-testid="preview-comparison-toggle"]').trigger('click')
    await wrapper.findAll('.half')[0]?.trigger('click')

    expect(wrapper.emitted('toggle')).toHaveLength(2)
  })
})
