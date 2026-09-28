import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { toRaw } from 'vue'
import { useBatchStore } from './batch'
import { useSettingsStore } from './settings'
import { useRunStore } from './run'
import { useUiStore } from './ui'
import { imageRecordFixture } from '@/domain/types.fixtures'

// Technical Design §1.1: binary data (File, Blob, ArrayBuffer, ImageBitmap) never enters a
// reactive Pinia store — it lives in a plain, non-reactive, module-scope Map elsewhere. Every
// field on every store here is already a primitive, string-union or plain-object shape per
// `src/domain/types.ts`, so this test cannot fail today — it exists as a structural safety net
// against a future field that violates the rule, not because any of these four stores currently
// have a way to hold binary data.
//
// jsdom (this project's Vitest environment) does not define `ImageBitmap` as a global at all, so
// even referencing the bare identifier would throw a ReferenceError — `typeof` is the one
// operator safe to use on a possibly-undeclared global, which is why the lookup goes through
// `globalThis` rather than a direct reference. That one check is a no-op under jsdom; it is only
// meaningfully exercised in a real browser.
const BINARY_CONSTRUCTORS: (new (...args: never[]) => unknown)[] = (
  [File, Blob, ArrayBuffer, globalThis.ImageBitmap] as unknown[]
).filter((ctor): ctor is new (...args: never[]) => unknown => typeof ctor === 'function')

function assertNoBinaryData(value: unknown, path: string, seen: WeakSet<object>): void {
  const raw = typeof value === 'object' && value !== null ? toRaw(value) : value

  if (raw === null || typeof raw !== 'object') {
    return
  }

  for (const ctor of BINARY_CONSTRUCTORS) {
    if (raw instanceof ctor) {
      throw new Error(`binary value of type ${ctor.name} found at ${path}`)
    }
  }

  if (seen.has(raw)) {
    return
  }
  seen.add(raw)

  for (const [key, child] of Object.entries(raw as Record<string, unknown>)) {
    assertNoBinaryData(child, `${path}.${key}`, seen)
  }
}

function assertStoreHoldsNoBinaryData(state: object): void {
  assertNoBinaryData(state, '$state', new WeakSet())
}

describe('no store holds binary data', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('useBatchStore, populated with a realistic image record', () => {
    const batch = useBatchStore()
    batch.addImages([imageRecordFixture])

    expect(() => assertStoreHoldsNoBinaryData(batch.$state)).not.toThrow()
  })

  it('useSettingsStore', () => {
    expect(() => assertStoreHoldsNoBinaryData(useSettingsStore().$state)).not.toThrow()
  })

  it('useRunStore', () => {
    expect(() => assertStoreHoldsNoBinaryData(useRunStore().$state)).not.toThrow()
  })

  it('useUiStore', () => {
    expect(() => assertStoreHoldsNoBinaryData(useUiStore().$state)).not.toThrow()
  })
})
