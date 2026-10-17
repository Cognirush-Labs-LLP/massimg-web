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
  placeholderSizes: { original: PixelSize; compressed: PixelSize } | null
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
    placeholderSizes: null,
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

interface ZoomToolbarApi {
  showsZoomToolbar: boolean
  zoomPercent: number | null
  zoomed: boolean
  atActualSize: boolean
  onFitClick: () => void
  onActualSizeClick: () => void
}

/**
 * The zoom toolbar's own state and actions, exposed for `Preview.vue`'s zoom toolbar (rendered
 * outside this component, beside the Original/Compressed pill) to read and drive — tested directly
 * off the exposed surface rather than through a template this component no longer has.
 */
function zoomToolbarApi(wrapper: VueWrapper): ZoomToolbarApi {
  return wrapper.vm as unknown as ZoomToolbarApi
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

  describe('zoom toolbar state (exposed for Preview.vue, which renders the controls)', () => {
    it('is showable once the image has loaded, with a 100% readout for an image that already fits', async () => {
      const wrapper = await mountFrame()

      expect(zoomToolbarApi(wrapper).showsZoomToolbar).toBe(true)
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(100)
    })

    it('is not showable before the image has loaded', async () => {
      const wrapper = await mountFrame({}, { natural: null })

      expect(zoomToolbarApi(wrapper).showsZoomToolbar).toBe(false)
    })

    it('is not showable while encoding and on error', async () => {
      const encoding = await mountFrame({ phase: 'encoding', compressedUrl: null })
      expect(zoomToolbarApi(encoding).showsZoomToolbar).toBe(false)

      const errored = await mountFrame({
        phase: 'error',
        compressedUrl: null,
        error: { kind: 'decode-failed' },
      })
      expect(zoomToolbarApi(errored).showsZoomToolbar).toBe(false)
    })

    it('is not showable when the original cannot be rendered by the browser', async () => {
      const wrapper = await mountFrame({ tab: 'original', originalUnrenderable: true })

      expect(zoomToolbarApi(wrapper).showsZoomToolbar).toBe(false)
    })

    it('is not showable for an edit it cannot project', async () => {
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

      expect(zoomToolbarApi(wrapper).showsZoomToolbar).toBe(false)
    })

    it('Fit is not zoomed at rest, and resets a zoomed, panned view back to rest', async () => {
      const wrapper = await mountFrame()

      expect(zoomToolbarApi(wrapper).zoomed).toBe(false)

      previewViewport(wrapper).setLocal({ center: { x: 0.3, y: 0.3 }, scale: 2 })
      await nextTick()
      expect(zoomToolbarApi(wrapper).zoomed).toBe(true)

      zoomToolbarApi(wrapper).onFitClick()
      await nextTick()

      expect(previewViewport(wrapper).local.value).toEqual({ center: { x: 0.5, y: 0.5 }, scale: 1 })
    })

    it('reflects rest-state shrink, not a literal 100%, for an oversized image', async () => {
      const big = { width: 4000, height: 3000 } as const satisfies PixelSize
      const wrapper = await mountFrame({}, { natural: big })

      // restBoxSize(4000x3000, 800x600) is 800x600 — a 1/5 shrink to fit.
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(20)
    })

    it('Actual size sets the active tab to pixel-for-pixel scale without recentring, then reports itself reached', async () => {
      const big = { width: 4000, height: 3000 } as const satisfies PixelSize
      const wrapper = await mountFrame({}, { natural: big })

      previewViewport(wrapper).setLocal({ center: { x: 0.3, y: 0.4 }, scale: 1 })
      await nextTick()

      zoomToolbarApi(wrapper).onActualSizeClick()
      await nextTick()

      // pixelPerfectScale(800x600 restBox, 4000x3000 natural) is 5.
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(5, 10)
      expect(previewViewport(wrapper).local.value.center).toEqual({ x: 0.3, y: 0.4 })
      expect(imageStyle(wrapper).width).toBe('4000px')
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(100)
      expect(zoomToolbarApi(wrapper).atActualSize).toBe(true)
    })

    it('reaches the image true pixel size even when that is far past the baseline 8x ceiling', async () => {
      const huge = { width: 20000, height: 15000 } as const satisfies PixelSize
      const wrapper = await mountFrame({}, { natural: huge })

      zoomToolbarApi(wrapper).onActualSizeClick()
      await nextTick()

      // restBoxSize(20000x15000, 800x600) is 800x600; pixelPerfectScale is 25 — well past
      // MAX_VIEWPORT_SCALE (8), but still reachable so "Actual size" is never a lie.
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(25, 10)
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(100)
    })

    it('lets manual wheel zoom reach at least 200% for a huge image, past the baseline 8x ceiling', async () => {
      const huge = { width: 20000, height: 15000 } as const satisfies PixelSize
      const wrapper = await mountFrame({}, { natural: huge })

      for (let i = 0; i < 20; i += 1) {
        await wheel(wrapper, { deltaY: -600, clientX: 400, clientY: 300 })
      }

      expect(zoomToolbarApi(wrapper).zoomPercent ?? 0).toBeGreaterThanOrEqual(200)
    })

    it('grows the readout above 100% on a wheel zoom-in', async () => {
      const wrapper = await mountFrame()

      await wheel(wrapper, { deltaY: -400, clientX: 400, clientY: 300 })

      expect(zoomToolbarApi(wrapper).zoomPercent ?? 0).toBeGreaterThan(100)
    })

    it('matches pixel density, not apparent size, when switching tabs after Actual size', async () => {
      // Compressed is a thumbnail smaller than the host (so its restBox is its own true size, 1:1
      // without shrinking); Original is far larger than the host (shrunk hard to fit). Picking sizes
      // where the two tabs' restBoxes actually differ matters: with a shared aspect ratio that
      // matches the host exactly, both tabs' restBoxes coincide at the host size regardless of
      // natural size, which would make old (apparent-size) and new (pixel-density) behaviour produce
      // the same numbers by accident and not actually exercise this change.
      const compressedNatural = { width: 200, height: 150 } as const satisfies PixelSize
      const originalNatural = { width: 4000, height: 3000 } as const satisfies PixelSize

      const wrapper = await mountFrame(
        {
          tab: 'compressed',
          compressedUrl: 'blob:compressed',
          originalUrl: 'blob:original',
          // Both tabs' predicted sizes known up front, same as `Preview.vue` always supplies them
          // (Original from the source, Compressed from `singleImageDimensions`) — this is what makes
          // pixel-density matching work from the very first view, before either raster has loaded.
          placeholderSizes: { original: originalNatural, compressed: compressedNatural },
        },
        { natural: compressedNatural },
      )

      zoomToolbarApi(wrapper).onActualSizeClick()
      await nextTick()

      // pixelPerfectScale(200x150 restBox, 200x150 natural) is 1: already smaller than the host, so
      // "actual size" is its own rest state.
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(1, 10)
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(100)

      await wrapper.setProps({ tab: 'original' })
      const original = wrapper.get('[data-testid="preview-image"]')
      Object.defineProperty(original.element, 'naturalWidth', {
        value: originalNatural.width,
        configurable: true,
      })
      Object.defineProperty(original.element, 'naturalHeight', {
        value: originalNatural.height,
        configurable: true,
      })
      await original.trigger('load')

      // Canonical scale is pinned to the Original tab's own convention, so it now reads as Original's
      // own scale: the 200px-wide Compressed thumbnail's screen footprint, reproduced on Original
      // (whose restBox is 800x600), is 800 * scale = 200 -> scale 0.25.
      expect(previewViewport(wrapper).canonical.value.scale).toBeCloseTo(0.25, 10)
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(0.25, 10)
      // displayedZoomPercent(800x600 restBox, 4000x3000 natural, 0.25) is 5 — the true fraction of
      // Original's own pixels now on screen, matching Compressed's screen footprint exactly, not a
      // reset to literal 100% and not the old apparent-size-preserving 100% either.
      expect(zoomToolbarApi(wrapper).zoomPercent).toBe(5)
    })

    it('matches pixel density from placeholder estimates alone, before either raster has loaded', async () => {
      const compressedNatural = { width: 200, height: 150 } as const satisfies PixelSize
      const originalNatural = { width: 4000, height: 3000 } as const satisfies PixelSize

      const wrapper = await mountFrame(
        {
          tab: 'compressed',
          compressedUrl: 'blob:compressed',
          originalUrl: 'blob:original',
          placeholderSizes: { original: originalNatural, compressed: compressedNatural },
        },
        { natural: null },
      )

      previewViewport(wrapper).setLocal({ center: { x: 0.5, y: 0.5 }, scale: 1 })
      await wrapper.setProps({ tab: 'original' })
      await nextTick()

      // Same 200/4000, 800x600-vs-200x150 relationship as the test above, computed purely from
      // `placeholderSizes` since neither `<img>` has fired `load` in this test at all.
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(0.25, 10)
      expect(Number.isFinite(previewViewport(wrapper).local.value.scale)).toBe(true)
    })

    it('raises the zoom ceiling rather than clamping away a cross-tab pixel-density match', async () => {
      // Original zoomed in hard on detail; Compressed is a much lower-res thumbnail, whose normal
      // ceiling (`effectiveMaxScale`) would otherwise clamp away the density match on arrival.
      const compressedNatural = { width: 200, height: 150 } as const satisfies PixelSize
      const originalNatural = { width: 4000, height: 3000 } as const satisfies PixelSize

      const wrapper = await mountFrame(
        {
          tab: 'original',
          compressedUrl: 'blob:compressed',
          originalUrl: 'blob:original',
          placeholderSizes: { original: originalNatural, compressed: compressedNatural },
        },
        { natural: originalNatural },
      )

      // Zoom Original in hard — well past where Compressed's own normal ceiling would sit.
      previewViewport(wrapper).setLocal({ center: { x: 0.5, y: 0.5 }, scale: 7 })
      await nextTick()

      await wrapper.setProps({ tab: 'compressed' })
      const compressed = wrapper.get('[data-testid="preview-image"]')
      Object.defineProperty(compressed.element, 'naturalWidth', {
        value: compressedNatural.width,
        configurable: true,
      })
      Object.defineProperty(compressed.element, 'naturalHeight', {
        value: compressedNatural.height,
        configurable: true,
      })
      await compressed.trigger('load')

      // Compressed's own effectiveMaxScale(200x150 restBox, 200x150 natural) is MAX_VIEWPORT_SCALE
      // (8), since pixelPerfectScale there is 1. The density match from Original's scale-7 view
      // needs far more than that to reproduce the same screen footprint on a 200px-wide thumbnail,
      // and it must not be clamped down to 8.
      expect(previewViewport(wrapper).local.value.scale).toBeGreaterThan(8)
    })
  })

  describe('keyboard pan/zoom (R-K1)', () => {
    it('is focusable with an accessible name once the frame can be inspected, not before', async () => {
      const notReady = await mountFrame({}, { natural: null })
      const notReadyFrame = notReady.get('[data-testid="preview-frame"]')
      expect(notReadyFrame.attributes('tabindex')).toBe('-1')
      expect(notReadyFrame.attributes('aria-label')).toBeUndefined()

      const ready = await mountFrame()
      const readyFrame = ready.get('[data-testid="preview-frame"]')
      expect(readyFrame.attributes('tabindex')).toBe('0')
      expect(readyFrame.attributes('aria-label')).toBe('Zoom and pan')
    })

    it('+ zooms in, - zooms out, and Shift+0 resets to fit', async () => {
      const wrapper = await mountFrame()
      const frame = wrapper.get('[data-testid="preview-frame"]')

      await frame.trigger('keydown', { key: '+' })
      expect(zoomToolbarApi(wrapper).zoomPercent ?? 0).toBeGreaterThan(100)

      const zoomedScale = previewViewport(wrapper).local.value.scale
      await frame.trigger('keydown', { key: '-' })
      expect(previewViewport(wrapper).local.value.scale).toBeLessThan(zoomedScale)

      await frame.trigger('keydown', { key: ')' })
      expect(previewViewport(wrapper).local.value).toEqual({ center: { x: 0.5, y: 0.5 }, scale: 1 })
    })

    it('arrow keys pan a zoomed view', async () => {
      // Scale 2 alone leaves no room to pan here: the 400x300 image at 2x exactly fills the 800x600
      // host, so `clampViewportCenter` clamps any pan straight back to 0.5/0.5. Scale 4 overflows the
      // host and actually has somewhere to pan to.
      const wrapper = await mountFrame()
      previewViewport(wrapper).setLocal({ center: { x: 0.5, y: 0.5 }, scale: 4 })

      const frame = wrapper.get('[data-testid="preview-frame"]')
      const centerBefore = previewViewport(wrapper).local.value.center

      await frame.trigger('keydown', { key: 'ArrowRight' })

      expect(previewViewport(wrapper).local.value.center).not.toEqual(centerBefore)
      expect(previewViewport(wrapper).local.value.scale).toBeCloseTo(4, 10)
    })

    it('does nothing when the frame cannot be inspected yet', async () => {
      const wrapper = await mountFrame({}, { natural: null })
      const before = previewViewport(wrapper).local.value

      await wrapper.get('[data-testid="preview-frame"]').trigger('keydown', { key: '+' })

      expect(previewViewport(wrapper).local.value).toEqual(before)
    })
  })
})
