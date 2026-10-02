import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { ImageId, ImageRecord, Job } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken } from '@/pipeline/protocol'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'

interface PendingRun {
  job: Job
  settle: (outcome: JobOutcome) => void
}

const runs: PendingRun[] = []
const run = vi.fn((job: Job) => {
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve
  })

  runs.push({ job, settle })

  return { token: runs.length as JobToken, done }
})

vi.mock('./preview-pool', () => ({ getPreviewPool: () => ({ run }) }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

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
    ...overrides,
  }
}

function seed(ids: string[], current = ids[0]): void {
  for (const id of ids) {
    sourceFiles.set(id as ImageId, new File([new Uint8Array([1, 2, 3])], `${id}.jpeg`))
  }

  useBatchStore().addImages(ids.map((id) => image(id)))
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
    result: { bytes: new Uint8Array(bytes), format: 'jpeg', caveats: [] },
  }
}

let urlCounter = 0

// Preview listens on `window` for R-K2's arrow keys, so a wrapper left mounted between cases would
// keep stepping the next case's batch. Unmounting is the same thing leaving Preview does for real.
enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  runs.length = 0
  run.mockClear()
  sourceFiles.clear()
  urlCounter = 0
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1

    return `blob:preview/${urlCounter}`
  })
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
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

  it('discloses flattening on the line when the chosen format has no alpha (R-C17)', async () => {
    seed(['a'])
    useSettingsStore().format = 'jpeg'
    const wrapper = await mountPreview()

    expect(wrapper.get('[data-testid="preview-transform-note"]').text()).toContain(
      'JPEG has no transparency',
    )
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
})
