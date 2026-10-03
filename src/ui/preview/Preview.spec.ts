import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { ImageId, ImageRecord, PipelineJob } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken } from '@/pipeline/protocol'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

interface PendingRun {
  job: PipelineJob
  settle: (outcome: JobOutcome) => void
}

const runs: PendingRun[] = []
const cancel = vi.fn()
const resume = vi.fn()
const run = vi.fn((job: PipelineJob) => {
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve
  })

  runs.push({ job, settle })

  return { token: runs.length as JobToken, done }
})

vi.mock('./preview-pool', () => ({ getPreviewPool: () => ({ run, cancel, resume }) }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

const ingestDrop = vi.fn()
vi.mock('@/ui/gallery/ingest', () => ({ ingestDrop }))

const Preview = (await import('./Preview.vue')).default

function image(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: id as ImageId,
    name: `${id}.jpeg`,
    relativePath: null,
    sizeBytes: 512_000,
    width: 4000,
    height: 3000,
    sourceFormat: 'jpeg',
    isAnimated: false,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    skipReason: null,
    ...overrides,
  }
}

function seed(ids: string[], current = ids[0], overrides: Partial<ImageRecord> = {}): void {
  for (const id of ids) {
    sourceFiles.set(id as ImageId, new File([new Uint8Array([1, 2, 3])], `${id}.jpeg`))
  }

  useBatchStore().addImages(ids.map((id) => image(id, overrides)))
  useUiStore().openPreview(current as ImageId)
}

async function mountPreview(): Promise<VueWrapper> {
  const wrapper = mount(Preview)

  await flushPromises()

  return wrapper
}

function completed(bytes: number, imageId: string): JobOutcome {
  return {
    token: 1 as JobToken,
    imageId: imageId as ImageId,
    outcome: 'completed',
    result: { kind: 'output', bytes: new Uint8Array(bytes), format: 'jpeg', caveats: [] },
  }
}

function unreachable(imageId: string, format: 'jpeg' | 'png' = 'png'): JobOutcome {
  return {
    token: 1 as JobToken,
    imageId: imageId as ImageId,
    outcome: 'completed',
    result: {
      kind: 'size-target-unreachable',
      targetBytes: 1000,
      achievedBytes: 1500,
      format,
      width: 4000,
      height: 3000,
    },
  }
}

let urlCounter = 0

/** jsdom has no ResizeObserver; this one hands the test the callback so it can report a size. */
let observerCallback: (() => void) | null = null

/** Reports a host size, the way a real layout would, and lets `PreviewFrame` re-measure it. */
async function measureFrameHost(
  wrapper: VueWrapper,
  size: { width: number; height: number },
): Promise<void> {
  const host = wrapper.get('[data-testid="preview-frame-host"]').element
  Object.defineProperty(host, 'clientWidth', { value: size.width, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: size.height, configurable: true })
  observerCallback?.()
  await nextTick()
}

/** Loads the active tab's image at a known natural size, the way a real decode would. */
async function loadFrameImage(
  wrapper: VueWrapper,
  size: { width: number; height: number },
): Promise<void> {
  const image = wrapper.get('[data-testid="preview-image"]')
  Object.defineProperty(image.element, 'naturalWidth', { value: size.width, configurable: true })
  Object.defineProperty(image.element, 'naturalHeight', { value: size.height, configurable: true })
  await image.trigger('load')
}

// Preview listens on `window` for R-K2's arrow keys, so a wrapper left mounted between cases would
// keep stepping the next case's batch. Unmounting is the same thing leaving Preview does for real.
enableAutoUnmount(afterEach)

// jsdom has no matchMedia; useBreakpoint.ts (read by PreviewComparisonPill.vue and
// PreviewTransformLine.vue) reads it in onMounted. Default to desktop so every existing assertion
// below is unaffected — individual "mobile" tests override `matches` before mounting.
let matches = true

beforeEach(() => {
  matches = true
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  setActivePinia(createPinia())
  runs.length = 0
  run.mockClear()
  cancel.mockClear()
  resume.mockClear()
  ingestDrop.mockReset()
  sourceFiles.clear()
  urlCounter = 0
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1

    return `blob:preview/${urlCounter}`
  })
  URL.revokeObjectURL = vi.fn()
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

describe('Preview', () => {
  it('hides the comparison figures while the entry encode runs, and shows them when it lands', async () => {
    seed(['a'])
    const wrapper = await mountPreview()

    expect(wrapper.find('[data-testid="preview-comparison"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-creating"]').exists()).toBe(true)
    expect(
      wrapper
        .get('[data-testid="preview-creating"]')
        .findAll('[data-testid="loading-indicator"] span'),
    ).toHaveLength(3)

    runs[0]?.settle(completed(256_000, 'a'))
    await flushPromises()

    expect(wrapper.get('[data-testid="preview-compressed-size"]').text()).toBe('256.00 KB')
    expect(wrapper.get('[data-testid="preview-size-change"]').text()).toBe('50% ↓')
  })

  it('shows the transform line while the encode is still running, because it reads the settings', async () => {
    seed(['a'])
    useSettingsStore().format = 'webp'
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-line"]').text()).toBe(
      'a.jpeg 4000×3000 → a.webp 4000×3000',
    )
  })

  it('shortens the transform line to extensions only below the side-panel breakpoint', async () => {
    matches = false
    seed(['a'], 'a', { name: 'camera_raw_file.jpg' })
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-line"]').text()).toBe(
      'jpg 4000×3000 → jpg 4000×3000',
    )
  })

  it('keeps the extension exactly as cased in the filename on the compact line', async () => {
    matches = false
    seed(['a'], 'a', { name: 'camera_raw_file.JPG' })
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-line"]').text()).toBe(
      'JPG 4000×3000 → JPG 4000×3000',
    )
  })

  it('drops the extension word (not the dimensions) on the compact line for a name with none', async () => {
    matches = false
    seed(['a'], 'a', { name: 'camera_raw_file' })
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-line"]').text()).toBe(
      '4000×3000 → 4000×3000',
    )
  })

  it('discloses flattening on the line when the chosen format has no alpha (R-C17)', async () => {
    seed(['a'], 'a', { sourceFormat: 'png' })
    useSettingsStore().format = 'jpeg'
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-note"]').text()).toContain(
      'JPEG has no transparency',
    )
  })

  it('stays silent about flattening for a JPEG source, which can never carry transparency', async () => {
    seed(['a'])
    useSettingsStore().format = 'jpeg'
    const wrapper = await mountPreview()

    expect(wrapper.find('[data-testid="preview-transform-note"]').exists()).toBe(false)
  })

  it('renders the zoom toolbar beside the comparison pill, outside the frame, and wires Fit/Actual size to it', async () => {
    seed(['a'])
    const wrapper = await mountPreview()

    // Nothing has loaded yet — the toolbar stays hidden, same as the comparison pill.
    expect(wrapper.find('[data-testid="preview-zoom-toolbar"]').exists()).toBe(false)

    runs[0]?.settle(completed(256_000, 'a'))
    await flushPromises()
    await measureFrameHost(wrapper, { width: 800, height: 600 })
    await loadFrameImage(wrapper, { width: 4000, height: 3000 })

    const toolbar = wrapper.get('[data-testid="preview-zoom-toolbar"]')
    const pill = wrapper.get('[data-testid="preview-comparison"]')

    // Beside the pill, not inside the image frame (not an overlay).
    expect(toolbar.element.closest('[data-testid="preview-frame"]')).toBeNull()
    expect(toolbar.element.parentElement).toBe(pill.element.parentElement)

    // restBoxSize(4000x3000, 800x600) is 800x600 — a 1/5 shrink to fit, so rest is 20%, not 100%.
    expect(wrapper.get('[data-testid="preview-zoom-readout"]').text()).toBe('20%')

    await wrapper.get('[data-testid="preview-zoom-actual-size"]').trigger('click')
    expect(wrapper.get('[data-testid="preview-zoom-readout"]').text()).toBe('100%')

    await wrapper.get('[data-testid="preview-zoom-fit"]').trigger('click')
    expect(wrapper.get('[data-testid="preview-zoom-readout"]').text()).toBe('20%')
  })

  it('flips the stored comparison tab from anywhere on the pill (R-P2)', async () => {
    seed(['a'])
    const wrapper = await mountPreview()
    runs[0]?.settle(completed(256_000, 'a'))
    await flushPromises()

    const uiStore = useUiStore()
    expect(uiStore.comparisonTab).toBe('compressed')

    await wrapper.get('[data-testid="preview-comparison-toggle"]').trigger('click')

    expect(uiStore.comparisonTab).toBe('original')
  })

  it('steps through the batch with the arrow keys (R-K2)', async () => {
    seed(['a', 'b', 'c'])
    await mountPreview()
    const uiStore = useUiStore()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()
    expect(uiStore.currentImageId).toBe('b')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    expect(uiStore.currentImageId).toBe('a')

    // And wraps, like the stepper buttons (R-P7).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await nextTick()
    expect(uiStore.currentImageId).toBe('c')
  })

  it('leaves the arrow keys alone inside a control that uses them itself', async () => {
    seed(['a', 'b'])
    await mountPreview()

    const slider = document.createElement('input')
    slider.type = 'range'
    document.body.append(slider)
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()

    expect(useUiStore().currentImageId).toBe('a')
    slider.remove()
  })

  it('stops listening for arrow keys once Preview is unmounted', async () => {
    seed(['a', 'b'])
    const wrapper = await mountPreview()

    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await nextTick()

    expect(useUiStore().currentImageId).toBe('a')
  })

  it('renders nothing when there is no current image', async () => {
    const wrapper = await mountPreview()

    expect(wrapper.find('[data-testid="preview-root"]').exists()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('forwards a drop event to ingestDrop', async () => {
    seed(['a'])
    const wrapper = await mountPreview()
    const dataTransfer = {} as DataTransfer

    await wrapper.find('[data-testid="preview-root"]').trigger('drop', { dataTransfer })

    expect(ingestDrop).toHaveBeenCalledWith(dataTransfer)
  })

  it('shows the hard-ceiling warning before recovery finishes and reveals verified actions progressively', async () => {
    seed(['a'], 'a', { sourceFormat: 'png', name: 'a.png' })
    const settingsStore = useSettingsStore()
    settingsStore.quality = { kind: 'size', targetBytes: 1000 }
    const wrapper = await mountPreview()

    runs[0]?.settle(unreachable('a'))
    await flushPromises()

    expect(wrapper.get('[data-testid="preview-size-unreachable"]').text()).toContain(
      'Smallest possible at these settings: 1.50 KB',
    )
    expect(wrapper.find('[data-testid="preview-recovery-loading"]').exists()).toBe(true)
    expect(
      wrapper
        .get('[data-testid="preview-recovery-loading"]')
        .findAll('[data-testid="loading-indicator"] span'),
    ).toHaveLength(3)
    expect(wrapper.find('[data-testid="preview-frame"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-image"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="preview-comparison"]').exists()).toBe(false)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(runs[1]?.job.kind).toBe('jpeg-recovery')

    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: {
        kind: 'jpeg-recovery',
        suggestion: {
          outputBytes: 900,
          flattenedFill: { r: 255, g: 255, b: 255, a: 1 },
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="preview-use-jpeg"]').text()).toContain(
      'Use JPEG with white background',
    )
    expect(runs[2]?.job.kind).toBe('dimension-recovery')

    await wrapper.get('[data-testid="preview-use-jpeg"]').trigger('click')
    expect(settingsStore.format).toBe('jpeg')
  })

  it('does not dispatch recovery jobs for a batch', async () => {
    seed(['a', 'b'], 'a', { sourceFormat: 'png' })
    useSettingsStore().quality = { kind: 'size', targetBytes: 1000 }
    const wrapper = await mountPreview()

    runs[0]?.settle(unreachable('a'))
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="preview-size-unreachable"]').text()).toContain(
      'The size setting applies to all 2 images.',
    )
  })

  it('applies verified dimensions as a trailing post-crop resize', async () => {
    seed(['a'], 'a', {
      edit: {
        ops: [
          {
            kind: 'crop',
            rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
            zoom: 1,
            background: { r: 255, g: 255, b: 255, a: 1 },
          },
        ],
        version: 3,
      },
    })
    useSettingsStore().quality = { kind: 'size', targetBytes: 1000 }
    const wrapper = await mountPreview()
    runs[0]?.settle(unreachable('a', 'jpeg'))
    await flushPromises()
    expect(runs[1]?.job.kind).toBe('dimension-recovery')

    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: {
        kind: 'dimension-recovery',
        suggestion: { width: 800, height: 600, outputBytes: 900, probes: 4 },
      },
    })
    await flushPromises()
    expect(wrapper.get('[data-testid="preview-use-smaller-dimensions"]').text()).toBe(
      'Try 720×540 · higher quality',
    )
    await wrapper.get('[data-testid="preview-use-dimensions"]').trigger('click')

    expect(useBatchStore().images[0]?.edit).toEqual({
      ops: [expect.objectContaining({ kind: 'crop' }), { kind: 'resize', width: 800, height: 600 }],
      version: 4,
    })
  })

  it('applies the free lower standard size through the same fresh Preview path', async () => {
    seed(['a'])
    useSettingsStore().quality = { kind: 'size', targetBytes: 1000 }
    const wrapper = await mountPreview()
    runs[0]?.settle(unreachable('a', 'jpeg'))
    await flushPromises()

    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: {
        kind: 'dimension-recovery',
        suggestion: { width: 800, height: 600, outputBytes: 900, probes: 4 },
      },
    })
    await flushPromises()
    await wrapper.get('[data-testid="preview-use-smaller-dimensions"]').trigger('click')

    expect(useSettingsStore().dimension).toEqual({ kind: 'fit-long-edge', pixels: 720 })
  })
})
