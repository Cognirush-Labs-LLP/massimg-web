import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { PixelSize } from '@/domain/edit'
import type { EditOp, EditRecord, ImageId, Rgba } from '@/domain/types'
import PreviewFrame from './PreviewFrame.vue'
import type { PreviewEncodeError, PreviewPhase } from './usePreviewEncode'

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

function imageStyle(wrapper: VueWrapper): Record<string, string> {
  const style = wrapper.get('[data-testid="preview-image"]').attributes('style') ?? ''

  return Object.fromEntries(
    style
      .split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter((parts): parts is [string, string] => parts.length === 2),
  )
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

    // 400x300 in an 800x600 host fits exactly, so the frame is the host and the image fills it.
    expect(style.width).toBe('800px')
    expect(style.height).toBe('600px')
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

    expect(Number.parseFloat(style.width ?? '0')).toBeGreaterThan(800)
    expect(Number.parseFloat(style.height ?? '0')).toBeGreaterThan(600)
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

    expect(style.width).toBe('800px')
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

    expect(imageStyle(wrapper).width).toBe('800px')
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

    expect(imageStyle(wrapper).width).toBe('800px')

    // A dimension rule changed the output size: the frame must size itself from the new raster.
    await wrapper.setProps({ compressedUrl: 'blob:compressed-2' })

    const image = wrapper.get('[data-testid="preview-image"]')
    Object.defineProperty(image.element, 'naturalWidth', { value: 300, configurable: true })
    Object.defineProperty(image.element, 'naturalHeight', { value: 400, configurable: true })
    await image.trigger('load')

    const style = imageStyle(wrapper)

    expect(style.width).toBe('450px')
    expect(style.height).toBe('600px')
  })
})
