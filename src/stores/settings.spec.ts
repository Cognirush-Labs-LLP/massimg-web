import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useSettingsStore defaults', () => {
  it('defaults to Quality mode, value 70, original dimension, and Don’t change format', () => {
    const settings = useSettingsStore()

    expect(settings.quality).toEqual({ kind: 'quality', value: 70 })
    expect(settings.dimension).toEqual({ kind: 'original' })
    expect(settings.format).toBe('dont-change')
  })
})

describe('useSettingsStore mutation', () => {
  it('quality, dimension and format are independently settable', () => {
    const settings = useSettingsStore()

    settings.quality = { kind: 'size', targetBytes: 200_000 }
    settings.dimension = { kind: 'fit-long-edge', pixels: 1920 }
    settings.format = 'webp'

    expect(settings.quality).toEqual({ kind: 'size', targetBytes: 200_000 })
    expect(settings.dimension).toEqual({ kind: 'fit-long-edge', pixels: 1920 })
    expect(settings.format).toBe('webp')
  })

  it('has no per-image field — edit lives on ImageRecord, not here', () => {
    const settings = useSettingsStore()

    expect('edit' in settings.$state).toBe(false)
  })
})
