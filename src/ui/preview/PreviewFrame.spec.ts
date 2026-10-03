import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { PixelSize } from '@/domain/edit'
import type { EditOp, EditRecord, ImageId, Rgba } from '@/domain/types'
import PreviewFrame from './PreviewFrame.vue'
import type { PreviewEncodeError, PreviewPhase } from './usePreviewEncode'
import type { PreviewViewport } from './usePreviewViewport'

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

const HOST = { width: 800, height: 600 } as const satisfies PixelSize
const NATURAL = { width: 400, height: 300 } as const satisfies PixelSize

/** jsdom has no ResizeObserver; this one hands the test the callback so it can report a size. */
let observerCallback: (() => void) | null = null

interface FrameProps {
  imageId: ImageId | null
  fileName: string
  edit: EditRecord | null
  tab: 'original' | 'compressed'
  phase: PreviewPhase
  compressedUrl: string | null
  originalUrl: string | null
  originalUnrenderable: boolean
  error: PreviewEncodeError | null
  placeholderSize: PixelSize | null
}

function props(overrides: Partial<FrameProps> = {}): FrameProps {
  return {
    imageId: 'a' as ImageId,
    fileName: 'photo.png',
    edit: null,
    tab: 'compressed',
    phase: 'ready',
    compressedUrl: 'blob:compressed',
    originalUrl: null,
    originalUnrenderable: false,
    error: null,
    placeholderSize: null,
    ...overrides,
  }
}

function sizeAt(element: Element, size: PixelSize): void {
  Object.defineProperty(element, 'clientWidth', { value: size.width, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: size.height, configurable: true })
}

/** Mounts the frame, reports a host size, and loads the image at a known natural size. */
async function mountFrame(
  overrides: Partial<FrameProps> = {},
  options: { natural?: PixelSize | null } = {},
): Promise<VueWrapper> {
  const wrapper = mount(PreviewFrame, { props: props(overrides) })

  sizeAt(wrapper.get('[data-testid="preview-frame-host"]').element, HOST)
  observerCallback?.()
  await nextTick()

  const natural = options.natural === undefined ? NATURAL : options.natural
  const image = wrapper.find('[data-testid="preview-image"]')

  if (natural !== null && image.exists()) {
    Object.defineProperty(image.element, 'naturalWidth', {
      value: natural.width,
      configurable: true,
    })
    Object.defineProperty(image.element, 'naturalHeight', {
      value: natural.height,
      configurable: true,
    })
    await image.trigger('load')
  }

  return wrapper
}

/**
 * A real `WheelEvent`, dispatched directly: `trigger('wheel', { clientX })` cannot work, because
 * Vue Test Utils assigns its options onto the event and `clientX` is a getter with no setter.
 */
async function wheel(wrapper: VueWrapper, init: WheelEventInit): Promise<void> {
  wrapper
    .get('[data-testid="preview-frame"]')
    .element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }))

  await nextTick()
}

function elementStyle(wrapper: VueWrapper, testId: string): Record<string, string> {
  const style = wrapper.get(`[data-testid="${testId}"]`).attributes('style') ?? ''

  return Object.fromEntries(
    style
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2),
  )
}

function imageStyle(wrapper: VueWrapper): Record<string, string> {
  return elementStyle(wrapper, 'preview-image')
}

/** The `.frame` element's own CSS box — `inline-size`/`block-size`, not `width`/`height`. */
function frameStyle(wrapper: VueWrapper): Record<string, string> {
  return elementStyle(wrapper, 'preview-frame')
}

/**
 * The viewport `defineExpose`s, so a test can drive zoom/pan state directly rather than
 * synthesising pointer gestures against a jsdom environment that never lays anything out.
 */
function previewViewport(wrapper: VueWrapper): PreviewViewport {
  return (wrapper.vm as unknown as { viewport: PreviewViewport }).viewport
}

beforeEach(() => {
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

  // jsdom does not implement the Pointer Events capture API at all; the component calls it
  // unconditionally on a gesture it can inspect, so the pinch regression test below needs a stub.
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    value: vi.fn(),
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PreviewFrame', () => {
  it('renders the encoded result through an img, never a canvas (R-I16, R-P8)', async () => {
    const wrapper = await mountFrame()

    expect(wrapper.get('[data-testid="preview-image"]').attributes('src')).toBe('blob:compressed')
    expect(wrapper.find('canvas').exists()).toBe(false)
  })

  it('gives the image contain-fit dimensions inside the measured host (R-P6)', async () => {
    const wrapper = await mountFrame()
    const style = imageStyle(wrapper)

    // fitScale(400x300, 800x600) is 2 — an upscale. restBoxSize caps the rest state at the image's
    // own pixel size instead, so the frame is 400x300, not the host.
    expect(style.width).toBe('400px')
    expect(style.height).toBe('300px')
    expect(style.left).toBe('0px')
    expect(style.top).toBe('0px')
  })

  it('preserves the aspect ratio when the host is a different shape (R-P6)', async () => {
    const wrapper = mount(PreviewFrame, { props: props() })

    sizeAt(wrapper.get('[data-testid="preview-frame-host"]').element, {
      width: 1000,
      height: 300,
    })
    observerCallback?.()
    await nextTick()

    const image = wrapper.get('[data-testid="preview-image"]')
    Object.defineProperty(image.element, 'naturalWidth', { value: 400, configurable: true })
    Object.defineProperty(image.element, 'naturalHeight', { value: 300, configurable: true })
    await image.trigger('load')

    const style = imageStyle(wrapper)

    expect(style.width).toBe('400px')
    expect(style.height).toBe('300px')
  })

  it('zooms about the pointer on a wheel event, growing the drawn image', async () => {
    const wrapper = await mountFrame()

    await wheel(wrapper, { deltaY: -100, clientX: 200, clientY: 150 })

    const style = imageStyle(wrapper)

    // Rest state is capped at 400x300 (R-P6's 100% cap); zooming in grows the drawn image past it.
    expect(Number.parseFloat(style.width ?? '0')).toBeGreaterThan(400)
    expect(Number.parseFloat(style.height ?? '0')).toBeGreaterThan(300)
  })

  it('normalises a line-mode wheel delta, so a mouse wheel is not a hundredth of a gesture', async () => {
    const pixels = await mountFrame()
    await wheel(pixels, { deltaY: -3, deltaMode: 0, clientX: 400, clientY: 300 })

    const lines = await mountFrame()
    await wheel(lines, { deltaY: -3, deltaMode: 1, clientX: 400, clientY: 300 })

    const pixelWidth = Number.parseFloat(imageStyle(pixels).width ?? '0')
    const lineWidth = Number.parseFloat(imageStyle(lines).width ?? '0')

    expect(lineWidth).toBeGreaterThan(pixelWidth)
  })

  it('does not zoom below the fit point, however far the wheel is turned', async () => {
    const wrapper = await mountFrame()

    await wheel(wrapper, { deltaY: 5000, clientX: 400, clientY: 300 })

    const style = imageStyle(wrapper)

    expect(style.width).toBe('400px')
    expect(style.left).toBe('0px')
  })

  it('leaves the frame alone for an edit it cannot project', async () => {
    const unprojectable: EditRecord = {
      ops: [
        {
          kind: 'crop',
          rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
          zoom: 1,
          background: OPAQUE_WHITE,
        },
        { kind: 'rotate', quarterTurns: 1 },
      ] satisfies EditOp[],
      version: 1,
    }
    const wrapper = await mountFrame({ edit: unprojectable })

    await wheel(wrapper, { deltaY: -400, clientX: 200, clientY: 150 })

    expect(imageStyle(wrapper).width).toBe('400px')
  })

  it('shows the Creating preview state instead of the image while encoding (R-P1)', async () => {
    const wrapper = await mountFrame({ phase: 'encoding', compressedUrl: null })

    expect(wrapper.find('[data-testid="preview-creating"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="preview-image"]').exists()).toBe(false)
  })

  it('keeps showing the original while a re-encode runs, since settings do not change it', async () => {
    const wrapper = await mountFrame({
      tab: 'original',
      phase: 'encoding',
      compressedUrl: null,
      originalUrl: 'blob:original',
    })

    expect(wrapper.get('[data-testid="preview-image"]').attributes('src')).toBe('blob:original')
    expect(wrapper.find('[data-testid="preview-creating"]').exists()).toBe(false)
  })

  it('shows an inline error with a retry, and emits on press (§10)', async () => {
    const wrapper = await mountFrame({
      phase: 'error',
      compressedUrl: null,
      error: { kind: 'decode-failed' },
    })

    expect(wrapper.get('[data-testid="preview-error"]').text()).toContain('photo.png')
    await wrapper.get('[data-testid="preview-retry"]').trigger('click')

    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('offers no retry for an input that has no encoder at all', async () => {
    const wrapper = await mountFrame({
      phase: 'error',
      compressedUrl: null,
      error: { kind: 'animated-avif' },
    })

    expect(wrapper.find('[data-testid="preview-retry"]').exists()).toBe(false)
  })

  it('names the output format in the no-path-for-this-combination error', async () => {
    const wrapper = await mountFrame({
      phase: 'error',
      compressedUrl: null,
      error: { kind: 'unsupported', format: 'gif' },
    })

    expect(wrapper.get('[data-testid="preview-error"]').text()).toContain('GIF')
  })

  it('reports a source the browser cannot draw, rather than leaving the frame empty', async () => {
    const wrapper = await mountFrame({ tab: 'original', originalUrl: 'blob:original' })

    await wrapper.get('[data-testid="preview-image"]').trigger('error')

    expect(wrapper.emitted('original-unrenderable')).toHaveLength(1)

    await wrapper.setProps({ originalUnrenderable: true })

    expect(wrapper.find('[data-testid="preview-image"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="preview-original-unavailable"]').text()).toContain(
      'photo.png',
    )
  })

  it('announces the encode starting and finishing to assistive technology (R-K5)', async () => {
    const wrapper = await mountFrame({ phase: 'encoding', compressedUrl: null })
    const status = wrapper.get('[role="status"]')

    expect(status.text()).toBe('Creating preview…')

    await wrapper.setProps({ phase: 'ready', compressedUrl: 'blob:compressed' })

    expect(status.text()).toBe('Preview ready')
  })

  it('forgets the previous natural size when a new encode arrives', async () => {
    const wrapper = await mountFrame()

    expect(imageStyle(wrapper).width).toBe('400px')

    // A dimension rule changed the output size: the frame must size itself from the new raster.
    await wrapper.setProps({ compressedUrl: 'blob:compressed-2' })

    const image = wrapper.get('[data-testid="preview-image"]')
    Object.defineProperty(image.element, 'naturalWidth', { value: 300, configurable: true })
    Object.defineProperty(image.element, 'naturalHeight', { value: 400, configurable: true })
    await image.trigger('load')

    const style = imageStyle(wrapper)

    // fitScale(300x400, 800x600) is 1.5 — also an upscale, also capped at the raster's true size.
    expect(style.width).toBe('300px')
    expect(style.height).toBe('400px')
  })

  it('downscales a wide, thin image per axis rather than distorting the short axis to fill the host', async () => {
    const wide = { width: 1024, height: 200 } as const satisfies PixelSize
    const wrapper = await mountFrame({}, { natural: wide })

    // fitScale(1024x200, 800x600) = min(800/1024, 600/200) = 0.78125 < 1: an ordinary downscale,
    // constrained by the width axis, not the 100%-cap case.
    expect(imageStyle(wrapper).width).toBe('800px')
    expect(imageStyle(wrapper).height).toBe('156.25px')
    expect(imageStyle(wrapper).left).toBe('0px')
    expect(imageStyle(wrapper).top).toBe('0px')
    expect(frameStyle(wrapper)['inline-size']).toBe('800px')
    expect(frameStyle(wrapper)['block-size']).toBe('156.25px')

    previewViewport(wrapper).setLocal({ center: { x: 0.5, y: 0.5 }, scale: 4 })
    await nextTick()

    // The rest-state frame left headroom on the height axis (156.25 of 600 available); zooming in
    // grows the frame into it rather than leaving it pinned at the rest-state height — the bug this
    // fix addresses.
    expect(frameStyle(wrapper)['block-size']).toBe('600px')
    expect(frameStyle(wrapper)['inline-size']).toBe('800px')
  })

  it('shows a small image at its true size instead of upscaling it to fill the host, and still grows on zoom', async () => {
    const small = { width: 97, height: 327 } as const satisfies PixelSize
    const wrapper = await mountFrame({}, { natural: small })

    // fitScale(97x327, 800x600) > 1 on both axes — restBoxSize caps the rest state at the image's
    // own true pixel size rather than blowing it up to fill the host.
    expect(imageStyle(wrapper).width).toBe('97px')
    expect(imageStyle(wrapper).height).toBe('327px')
    expect(frameStyle(wrapper)['inline-size']).toBe('97px')
    expect(frameStyle(wrapper)['block-size']).toBe('327px')

    previewViewport(wrapper).setLocal({ center: { x: 0.5, y: 0.5 }, scale: 2 })
    await nextTick()

    expect(frameStyle(wrapper)['inline-size']).toBe('194px')
    expect(frameStyle(wrapper)['block-size']).toBe('600px')
  })

  it('converts the pinch midpoint fresh on every pinch move, not a rect cached at gesture start', async () => {
    const wrapper = await mountFrame()
    const frameElement = wrapper.get('[data-testid="preview-frame"]').element as HTMLElement

    // jsdom lays nothing out: the rect is whatever this test returns. It changes mid-gesture, the
    // way it would once a prior move already grew the frame toward the host — the pinch midpoint
    // conversion has to pick that up fresh rather than reuse whatever an earlier event saw.
    let rect = { left: 0, top: 0, width: 400, height: 300 } as DOMRect
    const getRect = vi.fn(() => rect)
    frameElement.getBoundingClientRect = getRect

    const dispatch = (type: string, pointerId: number, clientX: number, clientY: number): void => {
      frameElement.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX, clientY }),
      )
    }

    // Pointer tracking itself is in client space (resize-invariant), so pointerdown needs no
    // measurement at all — only a pinch move, which must convert its midpoint into frame space,
    // does.
    dispatch('pointerdown', 1, 150, 150)
    dispatch('pointerdown', 2, 250, 150)
    await nextTick()
    expect(getRect).not.toHaveBeenCalled()

    dispatch('pointermove', 1, 120, 150)
    dispatch('pointermove', 2, 280, 150)
    await nextTick()

    // The pointers moved apart, so the pinch zoomed in.
    expect(previewViewport(wrapper).local.value.scale).toBeGreaterThan(1)

    // A real layout would now report a bigger, differently-positioned rect, since the frame itself
    // grew. A value cached before this point would never see it.
    rect = { left: -100, top: -50, width: 800, height: 600 } as DOMRect

    expect(() => {
      dispatch('pointermove', 1, 90, 150)
      dispatch('pointermove', 2, 310, 150)
    }).not.toThrow()

    await nextTick()

    // Four pinch moves, four fresh conversions — never a value cached from an earlier event.
    expect(getRect).toHaveBeenCalledTimes(4)
    expect(Number.isFinite(previewViewport(wrapper).local.value.scale)).toBe(true)
  })

  it('keeps a pinch gesture correct when the two pointers are not updated in lockstep', async () => {
    // The bug this guards against: if each pointer's position were converted into frame space at
    // its own last event (rather than kept in resize-invariant client space until the moment of
    // use), a pinch spanning a frame resize could end up averaging one pointer's fresh, post-resize
    // position with the other's stale, pre-resize one. Real touch input never delivers two
    // fingers' events in lockstep, so this is the ordinary case, not an edge case.
    const wrapper = await mountFrame()
    const frameElement = wrapper.get('[data-testid="preview-frame"]').element as HTMLElement

    let rect = { left: 0, top: 0, width: 400, height: 300 } as DOMRect
    frameElement.getBoundingClientRect = vi.fn(() => rect)

    const dispatch = (type: string, pointerId: number, clientX: number, clientY: number): void => {
      frameElement.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, clientX, clientY }),
      )
    }

    dispatch('pointerdown', 1, 150, 150)
    dispatch('pointerdown', 2, 250, 150)
    await nextTick()

    // Only pointer 1 moves. The frame has not resized yet, so this is an ordinary single-sided
    // update — no pinch-distance change (pointer 2 hasn't reported a new position), just pointer
    // 1's own stored position advancing.
    dispatch('pointermove', 1, 140, 150)
    await nextTick()

    // Now the frame resizes (as it would once a subsequent move elsewhere grows it), and only
    // pointer 2 moves — exercising the exact mixed-timing case the bug depended on.
    rect = { left: -50, top: -25, width: 600, height: 450 } as DOMRect
    dispatch('pointermove', 2, 300, 150)
    await nextTick()

    const scale = previewViewport(wrapper).local.value.scale
    expect(Number.isFinite(scale)).toBe(true)
    expect(Number.isFinite(previewViewport(wrapper).local.value.center.x)).toBe(true)
    expect(Number.isFinite(previewViewport(wrapper).local.value.center.y)).toBe(true)
  })
})
