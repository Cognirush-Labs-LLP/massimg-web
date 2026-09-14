import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '@/app/App.vue'

// Trivial proof that Vitest resolves modules the same way the Vite build does:
// this import goes through the "@" alias defined in vite.config.ts, and the
// mount below exercises the Vue SFC compile pipeline through Vitest.
describe('module resolution smoke test', () => {
  it('mounts the placeholder root component via the "@" alias', () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('icompress scaffold OK')
  })
})
