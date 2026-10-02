import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { DEFAULT_VIEWPORT, type InspectorViewport } from '@/domain/viewport'
import type { EditOp, EditRecord, ImageId, NormalisedRect, Rgba } from '@/domain/types'
import { usePreviewViewport, type ComparisonTab, type PreviewViewport } from './usePreviewViewport'

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba
const RIGHT_HALF = { x: 0.5, y: 0, width: 0.5, height: 1 } as const satisfies NormalisedRect

function cropOp(rect: NormalisedRect = RIGHT_HALF): EditOp {
  return { kind: 'crop', rect, zoom: 1, background: OPAQUE_WHITE }
}

function editRecord(ops: EditOp[], version = 1): EditRecord {
  return { ops, version }
}

interface Harness {
  viewport: PreviewViewport
  imageId: Ref<ImageId | null>
  edit: Ref<EditRecord | null>
  tab: Ref<ComparisonTab>
}

function mountViewport(edit: EditRecord | null = null): Harness {
  const imageId = ref<ImageId | null>('a' as ImageId)
  const editRef = ref<EditRecord | null>(edit)
  const tab = ref<ComparisonTab>('compressed')
  let viewport: PreviewViewport | null = null

  mount(
    defineComponent({
      setup() {
        viewport = usePreviewViewport({ imageId, edit: editRef, tab })

        return () => h('div')
      },
    }),
  )

  if (viewport === null) {
    throw new Error('composable did not run')
  }

  return { viewport, imageId, edit: editRef, tab }
}

function viewportAt(x: number, y: number, scale: number): InspectorViewport {
  return { center: { x, y }, scale }
}

describe('usePreviewViewport', () => {
  it('starts fit to frame, which is the state R-P6 describes', () => {
    const { viewport } = mountViewport()

    expect(viewport.canonical.value).toEqual(DEFAULT_VIEWPORT)
    expect(viewport.local.value).toEqual(DEFAULT_VIEWPORT)
    expect(viewport.zoomed.value).toBe(false)
  })

  it('projects into the active tab and writes back through the same projection', () => {
    const { viewport, tab } = mountViewport(editRecord([cropOp()]))

    // Looking at the middle of a right-half crop on the Compressed tab.
    viewport.setLocal(viewportAt(0.5, 0.5, 2))

    expect(viewport.canonical.value.center.x).toBeCloseTo(0.75, 10)
    expect(viewport.local.value.center.x).toBeCloseTo(0.5, 10)

    // The same canonical point, seen from the Original tab, is three quarters across the source.
    tab.value = 'original'
    expect(viewport.local.value.center.x).toBeCloseTo(0.75, 10)
  })

  it('keeps the same patch in view across a there-and-back tab flip', async () => {
    const { viewport, tab } = mountViewport(editRecord([cropOp()]))

    viewport.setLocal(viewportAt(0.2, 0.4, 3))
    const compressed = viewport.local.value

    tab.value = 'original'
    await nextTick()
    tab.value = 'compressed'
    await nextTick()

    expect(viewport.local.value.center.x).toBeCloseTo(compressed.center.x, 10)
    expect(viewport.local.value.center.y).toBeCloseTo(compressed.center.y, 10)
    expect(viewport.local.value.scale).toBe(3)
  })

  it('resets to fit when stepping to a different image (R-P7)', async () => {
    const { viewport, imageId } = mountViewport()

    viewport.setLocal(viewportAt(0.2, 0.3, 4))
    imageId.value = 'b' as ImageId
    await nextTick()

    expect(viewport.canonical.value).toEqual(DEFAULT_VIEWPORT)
  })

  it('survives a crop being stored on the same image, which is the point of the feature', async () => {
    const { viewport, edit } = mountViewport()

    viewport.setLocal(viewportAt(0.25, 0.25, 4))
    const canonical = viewport.canonical.value

    edit.value = editRecord([cropOp()], 2)
    await nextTick()

    expect(viewport.canonical.value).toEqual(canonical)
  })

  it('re-expresses the viewport when the stored rotation changes, rather than resetting it', async () => {
    const { viewport, edit } = mountViewport()

    viewport.setLocal(viewportAt(0.2, 0.9, 3))
    edit.value = editRecord([{ kind: 'rotate', quarterTurns: 1 }], 2)
    await nextTick()

    // One clockwise turn sends (x, y) to (1 - y, x): the same patch of the source, in the new space.
    expect(viewport.canonical.value.center.x).toBeCloseTo(0.1, 10)
    expect(viewport.canonical.value.center.y).toBeCloseTo(0.2, 10)
    expect(viewport.canonical.value.scale).toBe(3)
  })

  it('refuses to inspect an edit it cannot project, leaving the frame at contain-fit', () => {
    const { viewport } = mountViewport(editRecord([cropOp(), { kind: 'rotate', quarterTurns: 1 }]))

    expect(viewport.interactive.value).toBe(false)
    expect(viewport.local.value).toEqual(DEFAULT_VIEWPORT)

    viewport.setLocal(viewportAt(0.1, 0.1, 5))

    expect(viewport.canonical.value).toEqual(DEFAULT_VIEWPORT)
  })

  it('ignores a non-finite viewport rather than writing a NaN into the frame', () => {
    const { viewport } = mountViewport()

    viewport.setLocal(viewportAt(Number.NaN, 0.5, 2))

    expect(viewport.canonical.value).toEqual(DEFAULT_VIEWPORT)
  })

  it("reports being zoomed from the active tab's own scale", () => {
    const { viewport } = mountViewport()

    viewport.setLocal(viewportAt(0.5, 0.5, 1.5))

    expect(viewport.zoomed.value).toBe(true)

    viewport.reset()

    expect(viewport.zoomed.value).toBe(false)
  })
})
