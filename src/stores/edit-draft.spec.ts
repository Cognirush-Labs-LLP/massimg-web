import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { PixelSize } from '@/domain/edit'
import type { EditRecord, ImageRecord } from '@/domain/types'
import { cropOpFixture, imageRecordFixture, rotateOpFixture } from '@/domain/types.fixtures'
import { useBatchStore } from './batch'
import { useEditDraftStore } from './edit-draft'
import { useUiStore } from './ui'

/** 2:1 source inside a square frame, chosen so `fitScale` is a clean 0.5 and every arithmetic
 * check below works out to whole numbers. */
const SOURCE: PixelSize = { width: 800, height: 400 }
const FRAME: PixelSize = { width: 400, height: 400 }

function seed(overrides: Partial<ImageRecord> = {}): ImageRecord {
  const image: ImageRecord = {
    ...imageRecordFixture,
    width: SOURCE.width,
    height: SOURCE.height,
    edit: null,
    ...overrides,
  }
  useBatchStore().addImages([image])
  useUiStore().openEdit(image.id)
  return image
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useEditDraftStore.initFor', () => {
  it('seeds zoom 1, the whole image, and a transparent fill for a fresh alpha-capable edit', () => {
    const image = seed({ sourceFormat: 'png' })
    const draft = useEditDraftStore()

    draft.initFor(image, FRAME)

    expect(draft.quarterTurns).toBe(0)
    expect(draft.zoom).toBe(1)
    expect(draft.background).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(draft.hasStoredEdit).toBe(false)
    expect(draft.showsBackgroundRow).toBe(false)
    expect(draft.displayRect).toEqual({ left: 0, top: 100, width: 400, height: 200 })
  })

  it('defaults to an opaque white fill when the effective format has no alpha (R-C13/R-C14)', () => {
    const image = seed({ sourceFormat: 'jpeg' })
    const draft = useEditDraftStore()

    draft.initFor(image, FRAME)

    expect(draft.background).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('seeds rotation from a rotate-only edit, still covering the whole rotated image', () => {
    const image = seed({ edit: { ops: [rotateOpFixture], version: 1 } })
    const draft = useEditDraftStore()

    draft.initFor(image, FRAME)

    expect(draft.quarterTurns).toBe(1)
    expect(draft.zoom).toBe(1)
    expect(draft.hasStoredEdit).toBe(true)
  })

  it('never reads a ratio from the stored edit, only from the session preference (R-C11)', () => {
    useUiStore().setEditRatioPreference('1:1')
    const image = seed({ edit: { ops: [cropOpFixture], version: 1 } })
    const draft = useEditDraftStore()

    draft.initFor(image, FRAME)

    expect(draft.ratioId).toBe('1:1')
  })
})

describe('useEditDraftStore mutations', () => {
  it('setZoom halves output dimensions on a fixed rect when zooming in 2x (R-C7)', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.setZoom(2)

    expect(draft.geometry).toMatchObject({ output: { size: { width: 400, height: 200 } } })
  })

  it('setTypedDimension(width) produces exactly that output width', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.setTypedDimension({ kind: 'width', pixels: 200 })

    expect(draft.geometry).toMatchObject({ output: { size: { width: 200 } } })
  })

  it('setRectFromMove translates the rect without changing its size', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    draft.setTypedDimension({ kind: 'width', pixels: 100 })
    const before = draft.displayRect

    draft.setRectFromMove({ ...before, left: before.left + 10, top: before.top + 10 })

    expect(draft.displayRect).toEqual({
      left: before.left + 10,
      top: before.top + 10,
      width: before.width,
      height: before.height,
    })
  })

  it('setRectFromResize keeps the opposite corner fixed (dragging bottom-right, top-left anchored)', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    const before = draft.displayRect // { left: 0, top: 100, width: 400, height: 200 }

    draft.setRectFromResize(
      { left: before.left, top: before.top, width: before.width - 50, height: before.height - 50 },
      'top-left',
    )

    expect(draft.displayRect).toEqual({ left: 0, top: 100, width: 350, height: 150 })
  })

  it('zooming out past full coverage creates spill and shows the background row', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    expect(draft.showsBackgroundRow).toBe(false)

    draft.setZoom(0.5)

    expect(draft.showsBackgroundRow).toBe(true)
  })

  it('rotate resets zoom and refits the rect, per R-C3', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    draft.setZoom(2)

    draft.rotate(1)

    expect(draft.quarterTurns).toBe(1)
    expect(draft.zoom).toBe(1)
  })

  it('setRatio updates the session-wide preference', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.setRatio('1:1')

    expect(useUiStore().editRatioPreference).toBe('1:1')
  })
})

describe('useEditDraftStore.apply / cancel / remove', () => {
  it('cancel touches no store state: closeEdit only', () => {
    const image = seed({ edit: { ops: [rotateOpFixture, cropOpFixture], version: 4 } })
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    draft.rotate(1)

    draft.cancel()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit?.ops).toEqual([rotateOpFixture, cropOpFixture])
    expect(useUiStore().stageMode).toBe('preview')
  })

  it('apply with unchanged geometry reproduces the same ops and preserves a trailing resize', () => {
    const edit: EditRecord = {
      ops: [rotateOpFixture, cropOpFixture, { kind: 'resize', width: 400, height: 300 }],
      version: 4,
    }
    const image = seed({ edit })
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.apply()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit?.ops).toEqual(edit.ops)
    expect(stored?.edit?.version).toBe(5)
    expect(useUiStore().stageMode).toBe('preview')
  })

  it('apply with changed crop geometry drops a prior trailing resize', () => {
    const edit: EditRecord = {
      ops: [rotateOpFixture, cropOpFixture, { kind: 'resize', width: 400, height: 300 }],
      version: 4,
    }
    const image = seed({ edit })
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    draft.setZoom(draft.zoom + 0.5)

    draft.apply()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit?.ops.some((op) => op.kind === 'resize')).toBe(false)
  })

  it('apply with no rotation and an identity crop stores no edit at all (R-D4)', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.apply()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit).toBeNull()
  })

  it('apply stores a rotate-only edit even without touching the rectangle (R-C4)', () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    draft.rotate(1)

    draft.apply()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit?.ops).toEqual([{ kind: 'rotate', quarterTurns: 1 }])
  })

  it('remove clears rotation, crop and any trailing resize together (R-C5)', () => {
    const edit: EditRecord = {
      ops: [rotateOpFixture, cropOpFixture, { kind: 'resize', width: 400, height: 300 }],
      version: 4,
    }
    const image = seed({ edit })
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)

    draft.remove()

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit).toBeNull()
    expect(useUiStore().stageMode).toBe('preview')
  })
})

// A small stored zoom (the image occupies only a small, centred box of the frame) leaves enough
// frame room either side that `constrainCropRect`'s frame-bound clamp never erases this rect's
// own spill the way it would for a rect already sized to fill the whole frame.
const SPILLING_CROP_OP = {
  kind: 'crop',
  rect: { x: -0.5, y: -0.5, width: 2, height: 2 },
  zoom: 0.3,
  background: { r: 0, g: 0, b: 0, a: 0 },
} satisfies EditRecord['ops'][number]

describe('useEditDraftStore background row visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initFor shows a spilling edit immediately, bypassing the debounce', async () => {
    const image = seed({ edit: { ops: [SPILLING_CROP_OP], version: 1 } })
    const draft = useEditDraftStore()

    draft.initFor(image, FRAME)
    await nextTick()

    expect(draft.showsBackgroundRow).toBe(true)
    expect(draft.visibleBackgroundRow).toBe(true)
  })

  it('does not reveal the row until a debounce after the change settles', async () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    await nextTick()
    expect(draft.visibleBackgroundRow).toBe(false)

    draft.setZoom(0.1) // reliably spills
    await nextTick() // lets the watcher fire and schedule the debounce timer

    expect(draft.showsBackgroundRow).toBe(true)
    expect(draft.visibleBackgroundRow).toBe(false) // not yet — still debouncing

    vi.advanceTimersByTime(999)
    expect(draft.visibleBackgroundRow).toBe(false)

    vi.advanceTimersByTime(1)
    expect(draft.visibleBackgroundRow).toBe(true)
  })

  it('freezes visibility entirely while dragging, regardless of intermediate spill', async () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    await nextTick()

    draft.setDragging(true)
    draft.setZoom(0.1) // would spill
    await nextTick()
    vi.advanceTimersByTime(5000)
    expect(draft.visibleBackgroundRow).toBe(false) // frozen — no mid-gesture mount

    draft.setZoom(1) // and back to no-spill, still mid-gesture
    await nextTick()
    vi.advanceTimersByTime(5000)
    expect(draft.visibleBackgroundRow).toBe(false)

    draft.setDragging(false)
    await nextTick()
    expect(draft.visibleBackgroundRow).toBe(false) // still debouncing the final (non-spilling) state
    vi.advanceTimersByTime(1000)
    expect(draft.visibleBackgroundRow).toBe(false)
  })

  it('a flip-flop inside the debounce window restarts the timer from the latest value', async () => {
    const image = seed()
    const draft = useEditDraftStore()
    draft.initFor(image, FRAME)
    await nextTick()

    draft.setZoom(0.1) // spills: showsBackgroundRow false -> true, timer set to fire at t=1000
    await nextTick()
    vi.advanceTimersByTime(900) // t=900, still pending
    draft.setZoom(1) // no spill: true -> false, resets the timer (would target `false` at t=1900)
    await nextTick()
    draft.setZoom(0.1) // spills again: false -> true, resets again (now targets `true` at t=1900)
    await nextTick()

    vi.advanceTimersByTime(900) // t=1800 — the original t=1000 deadline must not have fired
    expect(draft.visibleBackgroundRow).toBe(false)

    vi.advanceTimersByTime(100) // t=1900 — a full debounce window after the *last* change
    expect(draft.visibleBackgroundRow).toBe(true)
  })
})
