import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'

const actions = [
  { id: 'stay', label: 'Stay' },
  { id: 'leave', label: 'Leave' },
]

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ConfirmDialog', () => {
  it('focuses the first (default) action on mount', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { title: 'Leave?', body: 'Body text.', actions },
      attachTo: document.body,
    })
    await flush()

    expect(document.activeElement?.getAttribute('data-testid')).toBe('confirm-action-stay')
    wrapper.unmount()
  })

  it('emits each action’s id on click', async () => {
    const wrapper = mount(ConfirmDialog, { props: { title: 'Leave?', body: 'Body.', actions } })

    await wrapper.get('[data-testid="confirm-action-leave"]').trigger('click')

    expect(wrapper.emitted('action')).toEqual([['leave']])
  })

  it('emits the escape action id on Escape, defaulting to the first action', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { title: 'Leave?', body: 'Body.', actions },
      attachTo: document.body,
    })
    await flush()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(wrapper.emitted('action')).toEqual([['stay']])
    wrapper.unmount()
  })

  it('emits a configured escapeActionId on Escape instead of the default', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { title: 'Leave?', body: 'Body.', actions, escapeActionId: 'leave' },
      attachTo: document.body,
    })
    await flush()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(wrapper.emitted('action')).toEqual([['leave']])
    wrapper.unmount()
  })

  it('clicking the scrim does not dismiss the dialog', async () => {
    const wrapper = mount(ConfirmDialog, { props: { title: 'Leave?', body: 'Body.', actions } })

    await wrapper.get('[data-testid="confirm-dialog-scrim"]').trigger('click')

    expect(wrapper.emitted('action')).toBeUndefined()
  })
})
