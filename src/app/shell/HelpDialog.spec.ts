import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HelpDialog from './HelpDialog.vue'

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('HelpDialog', () => {
  it('renders the title and body, and focuses Close on open', async () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
      attachTo: document.body,
    })
    await flush()

    expect(wrapper.get('[data-testid="help-dialog"]').text()).toContain('Fixed width')
    expect(wrapper.get('[data-testid="help-dialog"]').text()).toContain('Explanation.')
    expect(document.activeElement?.getAttribute('data-testid')).toBe('help-dialog-close')
    wrapper.unmount()
  })

  it('renders an optional note, more quietly than the body, when given', () => {
    const wrapper = mount(HelpDialog, {
      props: {
        modelValue: true,
        returnFocusTo: null,
        title: 'Fixed width',
        body: 'Explanation.',
        note: 'May enlarge small images.',
      },
    })

    expect(wrapper.find('.help-note').text()).toBe('May enlarge small images.')
  })

  it('renders no note element at all when none is given', () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
    })

    expect(wrapper.find('.help-note').exists()).toBe(false)
  })

  it('renders optional diagram slot content, and nothing when the slot is unused', () => {
    const withDiagram = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fit within long edge', body: 'X.' },
      slots: { diagram: '<svg class="my-diagram"></svg>' },
    })
    expect(withDiagram.find('.my-diagram').exists()).toBe(true)

    const withoutDiagram = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'X.' },
    })
    expect(withoutDiagram.find('.help-diagram').exists()).toBe(false)
  })

  it('renders nothing when closed', () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: false, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
    })

    expect(wrapper.find('[data-testid="help-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="help-dialog-scrim"]').exists()).toBe(false)
  })

  it('emits update:modelValue false on Close click', async () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
    })

    await wrapper.get('[data-testid="help-dialog-close"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('emits update:modelValue false on Escape', async () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
      attachTo: document.body,
    })
    await flush()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    wrapper.unmount()
  })

  it('clicking the scrim closes the dialog, unlike ConfirmDialog (this one is reversible)', async () => {
    const wrapper = mount(HelpDialog, {
      props: { modelValue: true, returnFocusTo: null, title: 'Fixed width', body: 'Explanation.' },
    })

    await wrapper.get('[data-testid="help-dialog-scrim"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('returns focus to returnFocusTo once modelValue flips back to false', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Opener'
    document.body.append(opener)

    const wrapper = mount(HelpDialog, {
      props: {
        modelValue: true,
        returnFocusTo: opener,
        title: 'Fixed width',
        body: 'Explanation.',
      },
      attachTo: document.body,
    })
    await flush()

    await wrapper.setProps({ modelValue: false })
    await flush()

    expect(document.activeElement).toBe(opener)
    wrapper.unmount()
    opener.remove()
  })
})
