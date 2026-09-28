import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, toRef } from 'vue'
import { useFocusTrap } from './useFocusTrap'

// A minimal host component exercising the composable exactly as Drawer.vue does: a container
// ref with a few focusable children, an externally-toggled `active` prop, and a `returnFocusTo`
// target outside the container.
function makeHost(onEscape: () => void) {
  return defineComponent({
    props: {
      active: { type: Boolean, required: true },
    },
    setup(props) {
      const container = ref<HTMLElement | null>(null)
      const returnFocusTo = ref<HTMLElement | null>(null)
      const active = toRef(props, 'active')

      useFocusTrap({ container, active, returnFocusTo, onEscape })

      return () =>
        h('div', [
          h('button', { ref: returnFocusTo, id: 'opener' }, 'Opener'),
          h('div', { ref: container, id: 'trap' }, [
            h('button', { id: 'first' }, 'First'),
            h('button', { id: 'middle' }, 'Middle'),
            h('button', { id: 'last' }, 'Last'),
          ]),
        ])
    },
  })
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useFocusTrap', () => {
  it('moves focus into the container on activate and back out on deactivate', async () => {
    const onEscape = vi.fn()
    const wrapper = mount(makeHost(onEscape), {
      props: { active: false },
      attachTo: document.body,
    })

    document.getElementById('opener')?.focus()
    expect(document.activeElement?.id).toBe('opener')

    await wrapper.setProps({ active: true })
    await flush()
    expect(document.activeElement?.id).toBe('first')

    await wrapper.setProps({ active: false })
    await flush()
    expect(document.activeElement?.id).toBe('opener')

    wrapper.unmount()
  })

  it('wraps Tab from the last focusable element back to the first', async () => {
    const onEscape = vi.fn()
    const wrapper = mount(makeHost(onEscape), { props: { active: true }, attachTo: document.body })
    await flush()

    document.getElementById('last')?.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(event)

    expect(document.activeElement?.id).toBe('first')
    wrapper.unmount()
  })

  it('wraps Shift+Tab from the first focusable element back to the last', async () => {
    const onEscape = vi.fn()
    const wrapper = mount(makeHost(onEscape), { props: { active: true }, attachTo: document.body })
    await flush()

    document.getElementById('first')?.focus()
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(event)

    expect(document.activeElement?.id).toBe('last')
    wrapper.unmount()
  })

  it('calls onEscape when Escape is pressed while active', async () => {
    const onEscape = vi.fn()
    const wrapper = mount(makeHost(onEscape), { props: { active: true }, attachTo: document.body })
    await flush()

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)

    expect(onEscape).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('stops reacting to Escape once unmounted', async () => {
    const onEscape = vi.fn()
    const wrapper = mount(makeHost(onEscape), { props: { active: true }, attachTo: document.body })
    await flush()
    wrapper.unmount()

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)

    expect(onEscape).not.toHaveBeenCalled()
  })
})
