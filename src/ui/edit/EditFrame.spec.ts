import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { resolveCropGeometry } from '@/domain/edit'
import type { PixelSize } from '@/domain/edit'
import type { ImageId, ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useUiStore } from '@/stores/ui'

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

const EditFrame = (await import('./EditFrame.vue')).default

const SOURCE: PixelSize = { width: 800, height: 400 }
const FRAME: PixelSize = { width: 400, height: 400 }

let observerCallback: (() => void) | null = null

function sizeAt(element: Element, size: PixelSize): void {
  Object.defineProperty(element, 'clientWidth', { value: size.width, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: size.height, configurable: true })
}

function seedAndInit(overrides: Partial<ImageRecord> = {}): ImageRecord {
  const image: ImageRecord = {
    ...imageRecordFixture,
    width: SOURCE.width,
    height: SOURCE.height,
    edit: null,
    ...overrides,
  }
  sourceFiles.set(
    image.id,
    new File([new Uint8Array([1, 2, 3])], image.name, { type: 'image/png' }),
  )
  useBatchStore().addImages([image])
  useUiStore().openEdit(image.id)
  useEditDraftStore().initFor(image, FRAME)
  return image
}

/**
 * A real `PointerEvent`, dispatched directly: `trigger('pointerdown', { clientX })` cannot work,
 * because Vue Test Utils assigns its options onto the event and `clientX` is a getter with no
 * setter (same issue `PreviewFrame.spec.ts`'s own `wheel()` helper documents).
 */
async function pointer(element: Element, type: string, init: PointerEventInit): Promise<void> {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
  await nextTick()
}

async function mountFrame() {
  const wrapper = mount(EditFrame)
  sizeAt(wrapper.get('[data-testid="edit-frame-host"]').element, FRAME)
  observerCallback?.()
  await nextTick()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  sourceFiles.clear()
  observerCallback = null
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observerCallback = callback
      }
      observe() {}
      disconnect() {
        observerCallback = null
      }
    },
  )
  URL.createObjectURL = vi.fn(() => 'blob:edit-frame')
  URL.revokeObjectURL = vi.fn()
})

describe('EditFrame', () => {
  it('shows a live badge equal to resolveCropGeometry(...).output.size (Done-when criterion)', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    const expected = resolveCropGeometry({
      source: draft.source,
      quarterTurns: draft.quarterTurns,
      frame: draft.frame,
      zoom: draft.zoom,
      rect: draft.displayRect,
      ratio: { kind: 'free' },
      limits: { minimumOutputPixels: 16, minimumFramePixels: 0 },
    })
    expect(expected.kind).toBe('resolved')
    const size = expected.kind === 'resolved' ? expected.output.size : null

    expect(wrapper.get('[data-testid="edit-frame-badge"]').text()).toBe(
      `${size?.width}×${size?.height}`,
    )
  })

  it('updates the badge after a zoom change, still matching the domain function exactly', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()

    draft.setZoom(2)
    await nextTick()

    expect(wrapper.get('[data-testid="edit-frame-badge"]').text()).toBe('400×200')
  })

  it('dragging the rect body moves the crop rectangle', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    draft.setTypedDimension({ kind: 'width', pixels: 100 })
    const before = draft.displayRect
    const rect = wrapper.get('[data-testid="edit-frame-rect"]').element
    ;(rect as HTMLElement & { setPointerCapture: () => void }).setPointerCapture = vi.fn()

    await pointer(rect, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
    await pointer(rect, 'pointermove', { pointerId: 1, clientX: 15, clientY: 20 })
    await pointer(rect, 'pointerup', { pointerId: 1 })

    expect(draft.displayRect).toEqual({
      left: before.left + 15,
      top: before.top + 20,
      width: before.width,
      height: before.height,
    })
  })

  it('dragging the bottom-right handle resizes with the top-left corner fixed', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    const before = draft.displayRect
    const handle = wrapper.get('[data-testid="edit-frame-handle-bottom-right"]').element
    ;(handle as HTMLElement & { setPointerCapture: () => void }).setPointerCapture = vi.fn()

    await pointer(handle, 'pointerdown', { pointerId: 2, clientX: 0, clientY: 0 })
    await pointer(handle, 'pointermove', { pointerId: 2, clientX: -50, clientY: -50 })
    await pointer(handle, 'pointerup', { pointerId: 2 })

    expect(draft.displayRect).toEqual({
      left: before.left,
      top: before.top,
      width: before.width - 50,
      height: before.height - 50,
    })
  })

  it('arrow keys nudge the rect, Shift for the coarse step (R-K4)', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    // Well clear of every image edge: the default rect starts flush with the image on all four
    // sides, which the new edge-snap (see domain/edit.ts's `snapMoveToImage`) would otherwise
    // immediately pull a small nudge straight back to.
    draft.setRectFromMove({ left: 100, top: 150, width: 100, height: 80 })
    const before = draft.displayRect
    const rect = wrapper.get('[data-testid="edit-frame-rect"]')

    await rect.trigger('keydown', { key: 'ArrowRight' })
    expect(draft.displayRect.left).toBe(before.left + 2)

    await rect.trigger('keydown', { key: 'ArrowDown', shiftKey: true })
    expect(draft.displayRect.top).toBe(before.top + 20)
  })

  it('arrow keys on a corner handle resize from that corner', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    // Same reasoning as above: clear of the edge-snap zone so this test isolates the resize math.
    draft.setRectFromMove({ left: 100, top: 150, width: 100, height: 80 })
    const before = draft.displayRect
    const handle = wrapper.get('[data-testid="edit-frame-handle-top-left"]')

    await handle.trigger('keydown', { key: 'ArrowRight' })

    expect(draft.displayRect).toEqual({
      left: before.left + 2,
      top: before.top,
      width: before.width - 2,
      height: before.height,
    })
  })

  it('dragging the rect near the image edge snaps it flush, and leaves it alone when far away', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    draft.setRectFromMove({ left: 100, top: 150, width: 100, height: 80 })
    const rect = wrapper.get('[data-testid="edit-frame-rect"]').element
    ;(rect as HTMLElement & { setPointerCapture: () => void }).setPointerCapture = vi.fn()

    // Image left edge is at frame x=0 (SOURCE/FRAME fixture: the image fills the frame's width
    // exactly). Dragging left to x=5 is within the 8px snap threshold.
    await pointer(rect, 'pointerdown', { pointerId: 10, clientX: 0, clientY: 0 })
    await pointer(rect, 'pointermove', { pointerId: 10, clientX: -95, clientY: 0 })
    await pointer(rect, 'pointerup', { pointerId: 10 })
    expect(draft.displayRect.left).toBe(0)

    draft.setRectFromMove({ left: 100, top: 150, width: 100, height: 80 })
    await pointer(rect, 'pointerdown', { pointerId: 11, clientX: 0, clientY: 0 })
    await pointer(rect, 'pointermove', { pointerId: 11, clientX: -80, clientY: 0 }) // left -> 20, clear of the threshold
    await pointer(rect, 'pointerup', { pointerId: 11 })
    expect(draft.displayRect.left).toBe(20)
  })

  it('resizing a corner near the image edge snaps that corner flush, keeping the opposite one fixed', async () => {
    seedAndInit()
    const wrapper = await mountFrame()
    const draft = useEditDraftStore()
    draft.setRectFromMove({ left: 100, top: 150, width: 100, height: 80 })
    const handle = wrapper.get('[data-testid="edit-frame-handle-top-left"]').element
    ;(handle as HTMLElement & { setPointerCapture: () => void }).setPointerCapture = vi.fn()

    // Drags the top-left corner to x=5 (within the threshold of the image's left edge at x=0);
    // the fixed bottom-right corner (200, 230) must land exactly where it started.
    await pointer(handle, 'pointerdown', { pointerId: 12, clientX: 0, clientY: 0 })
    await pointer(handle, 'pointermove', { pointerId: 12, clientX: -95, clientY: 0 })
    await pointer(handle, 'pointerup', { pointerId: 12 })

    expect(draft.displayRect).toEqual({ left: 0, top: 150, width: 200, height: 80 })
  })
})
