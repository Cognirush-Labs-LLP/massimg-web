import { describe, expect, it } from 'vitest'
import { pickFiles } from './picker'

// T39: the ordinary "Select images"/"Add images" picker uses `accept="image/*"` as a native-picker
// hint, stays `multiple`, and never sets `capture` (that would turn it into a camera shortcut).
// `accept` filtering is cosmetic only — classify() still inspects bytes downstream (R-I23).
describe('pickFiles', () => {
  it('creates a hidden file input with accept="image/*", multiple, and no capture attribute', () => {
    let created: HTMLInputElement | undefined
    const originalCreateElement = document.createElement.bind(document)
    const spy = (tagName: string) => {
      const element = originalCreateElement(tagName)
      if (tagName === 'input') {
        created = element as HTMLInputElement
      }
      return element
    }
    document.createElement = spy as typeof document.createElement

    try {
      void pickFiles()
    } finally {
      document.createElement = originalCreateElement
    }

    expect(created).toBeDefined()
    expect(created?.type).toBe('file')
    expect(created?.accept).toBe('image/*')
    expect(created?.multiple).toBe(true)
    expect(created?.hasAttribute('capture')).toBe(false)
    created?.remove()
  })
})
