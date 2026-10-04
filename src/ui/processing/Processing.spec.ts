import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId, ImageRecord, PipelineJob } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken, OutputJobResult } from '@/pipeline/protocol'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'

interface PendingRun {
  job: PipelineJob
  settle: (outcome: JobOutcome) => void
}

let runs: PendingRun[] = []
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

vi.mock('./processing-pool', () => ({ getProcessingPool: () => ({ run, cancel, resume }) }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

const Processing = (await import('./Processing.vue')).default

function image(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: id as ImageId,
    name: `${id}.jpeg`,
    relativePath: null,
    sizeBytes: 1000,
    width: 800,
    height: 600,
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

function seed(ids: string[]): void {
  for (const id of ids) {
    sourceFiles.set(id as ImageId, new File([new Uint8Array([1, 2, 3])], `${id}.jpeg`))
  }
  useBatchStore().addImages(ids.map((id) => image(id)))
}

function completedOutput(bytes: number): OutputJobResult {
  return {
    kind: 'output',
    bytes: new Uint8Array(bytes),
    format: 'jpeg',
    selection: { kind: 'encoded' },
    caveats: [],
  }
}

async function mountProcessing(): Promise<VueWrapper> {
  const wrapper = mount(Processing)
  await flushPromises()
  return wrapper
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  setActivePinia(createPinia())
  runs = []
  cancel.mockClear()
  resume.mockClear()
  run.mockClear()
  sourceFiles.clear()
})

describe('Processing view (T38)', () => {
  it('shows the counter, donut and every number also as text, numerically correct through a run', async () => {
    seed(['a', 'b'])
    const wrapper = await mountProcessing()

    expect(wrapper.get('[data-testid="processing-counter"]').text()).toBe('0 / 2 processed')
    expect(wrapper.get('[data-testid="processing-figure-pending"]').text()).toBe('2 pending')

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: completedOutput(400),
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="processing-counter"]').text()).toBe('1 / 2 processed')
    expect(wrapper.get('[data-testid="processing-figure-succeeded"]').text()).toBe('1 succeeded')
    expect(wrapper.get('[data-testid="processing-figure-pending"]').text()).toBe('1 pending')

    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'b' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="processing-counter"]').text()).toBe('2 / 2 processed')
    expect(wrapper.get('[data-testid="processing-figure-failed"]').text()).toBe('1 failed')
    expect(wrapper.get('[data-testid="processing-figure-pending"]').text()).toBe('0 pending')
  })

  it('every processing-figure node lives outside the donut SVG (readable with the chart hidden)', async () => {
    seed(['a'])
    const wrapper = await mountProcessing()

    const svg = wrapper.get('[data-testid="processing-donut"]')
    for (const testid of ['succeeded', 'failed', 'skipped', 'pending']) {
      const figure = wrapper.get(`[data-testid="processing-figure-${testid}"]`)
      expect(svg.element.contains(figure.element)).toBe(false)
    }
  })

  it('lists a failed image by name with a translated reason (R-X11)', async () => {
    seed(['photo'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'photo' as ImageId,
      outcome: 'failed',
      // Not out-of-memory: that reason halts the whole run instead of landing here (T39, see the
      // dedicated describe block below) — decode-failed stays an ordinary per-image failure.
      reason: { kind: 'decode-failed' },
    })
    await flushPromises()

    const failures = wrapper.get('[data-testid="processing-failures"]')
    expect(failures.text()).toContain('photo.jpeg')
    expect(failures.text()).toContain('Could not be read')
  })

  it('lists a skipped image with target, dimensions, format and achieved size (§6.3)', async () => {
    seed(['photo'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'photo' as ImageId,
      outcome: 'completed',
      result: {
        kind: 'size-target-unreachable',
        targetBytes: 100_000,
        achievedBytes: 150_000,
        format: 'png',
        width: 800,
        height: 600,
      },
    })
    await flushPromises()

    const skipped = wrapper.get('[data-testid="processing-skipped"]')
    expect(skipped.text()).toContain('photo.jpeg')
    expect(skipped.text()).toContain('800×600 PNG')
  })

  it('Cancel flips its label synchronously and navigates to Gallery only after the in-flight job settles', async () => {
    seed(['a'])
    const uiStore = useUiStore()
    uiStore.enterProcessing()
    const wrapper = await mountProcessing()

    const cancelButton = wrapper.get('[data-testid="processing-cancel"]')
    expect(cancelButton.text()).toBe('Cancel')

    await cancelButton.trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="processing-cancel"]').text()).toBe('Stopping')
    expect(uiStore.stageMode).toBe('processing')

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: completedOutput(400),
    })
    await flushPromises()

    expect(uiStore.stageMode).toBe('gallery')
  })

  it('shows no Download button and only Back to images when every image failed', async () => {
    seed(['a'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'encode-failed' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="processing-back"]').text()).toBe('Back to images')
  })

  it('shows Download once at least one image succeeded, present but without triggering a download', async () => {
    seed(['a', 'b'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: completedOutput(400),
    })
    runs[1]?.settle({
      token: 2 as JobToken,
      imageId: 'b' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    await flushPromises()

    const download = wrapper.get('[data-testid="processing-download"]')
    expect(download.text()).toBe('Download')
    // T42, not T38, wires this click to downloadFinishedRun() — clicking it here must not throw.
    await expect(download.trigger('click')).resolves.not.toThrow()
  })

  it('"Back to images" returns to Gallery with the batch intact', async () => {
    seed(['a'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'completed',
      result: completedOutput(400),
    })
    await flushPromises()

    await wrapper.get('[data-testid="processing-back"]').trigger('click')

    expect(useUiStore().stageMode).toBe('gallery')
    expect(useBatchStore().images).toHaveLength(1)
  })

  it('shows a distinct "nothing to download" message when every image failed or was skipped (§10)', async () => {
    seed(['a'])
    const wrapper = await mountProcessing()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'decode-failed' },
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="processing-total"]').text()).toBe(
      'Nothing to download — see Failed/Skipped below.',
    )
  })

  describe('out-of-memory run halt (T39, §10 "Out of memory")', () => {
    it('replaces the completion actions with the halted message and hides Download, even with a prior success', async () => {
      seed(['a', 'b'])
      const wrapper = await mountProcessing()

      runs[0]?.settle({
        token: 1 as JobToken,
        imageId: 'a' as ImageId,
        outcome: 'completed',
        result: completedOutput(400),
      })
      await flushPromises()

      runs[1]?.settle({
        token: 2 as JobToken,
        imageId: 'b' as ImageId,
        outcome: 'failed',
        reason: { kind: 'out-of-memory' },
      })
      await flushPromises()

      const halted = wrapper.get('[data-testid="processing-halted"]')
      expect(halted.text()).toContain('fewer or smaller images')
      expect(halted.text()).toMatch(/desktop/i)
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="processing-back"]').text()).toBe('Back to images')
      // Not recorded as an ordinary per-image failure (distinct from decode/encode failures).
      expect(wrapper.find('[data-testid="processing-failures"]').exists()).toBe(false)
    })

    it('shows no halted message for an ordinary completed or failed run', async () => {
      seed(['a'])
      const wrapper = await mountProcessing()

      runs[0]?.settle({
        token: 1 as JobToken,
        imageId: 'a' as ImageId,
        outcome: 'failed',
        reason: { kind: 'encode-failed' },
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="processing-halted"]').exists()).toBe(false)
    })
  })
})
