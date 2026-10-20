import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId, ImageRecord, PipelineJob } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken, OutputJobResult } from '@/pipeline/protocol'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
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

// Every other test in this file relies on the *real* platform/opfs, platform/share and
// pipeline/run-archive modules, which degrade gracefully to jsdom's in-memory fallback — itself
// useful end-to-end coverage. These two are wrapped (not replaced) so the T40-specific tests below
// can force a quota rejection or a storage failure for one call without disturbing the rest.
vi.mock('@/platform/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/opfs')>()
  return {
    ...actual,
    checkCombinedQuota: vi.fn(actual.checkCombinedQuota),
    writeOutputCopy: vi.fn(actual.writeOutputCopy),
  }
})

// jsdom has no `navigator.canShare`, so the real functions can only ever answer `false` — which
// is the correct default for every test here that isn't about Share, and useless for the ones that
// are. Wrapped, so each Share test opts in explicitly (T42).
vi.mock('@/platform/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/share')>()
  return {
    ...actual,
    probeFileShareForRun: vi.fn(actual.probeFileShareForRun),
    canShareExactFiles: vi.fn(actual.canShareExactFiles),
  }
})

// The two delivery actions are mocked at their module boundary: what this file tests is that the
// right button calls the right one and that the view reacts to the resulting store state. Their
// own behaviour lives in run-download.spec.ts / run-share.spec.ts, and mocking them also keeps a
// real `URL.createObjectURL`/anchor click out of a component test.
vi.mock('@/pipeline/run-download', () => ({
  downloadFinishedRun: vi.fn(async () => 'downloaded'),
}))

vi.mock('@/pipeline/run-share', () => ({
  shareFinishedRun: vi.fn(async () => 'shared'),
}))

const Processing = (await import('./Processing.vue')).default
const { checkCombinedQuota, writeOutputCopy } = await import('@/platform/opfs')
const { probeFileShareForRun, canShareExactFiles } = await import('@/platform/share')
const { downloadFinishedRun } = await import('@/pipeline/run-download')
const { shareFinishedRun } = await import('@/pipeline/run-share')

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
  vi.mocked(checkCombinedQuota).mockClear()
  vi.mocked(writeOutputCopy).mockClear()
  vi.mocked(probeFileShareForRun).mockReset().mockResolvedValue(false)
  vi.mocked(canShareExactFiles).mockReset().mockResolvedValue(false)
  vi.mocked(downloadFinishedRun).mockReset().mockResolvedValue('downloaded')
  vi.mocked(shareFinishedRun).mockReset().mockResolvedValue('shared')
})

/** Settles every pending job as a success, so the finished view renders its delivery actions. */
async function completeAll(bytes = 400): Promise<void> {
  for (const [index, pending] of runs.entries()) {
    pending.settle({
      token: (index + 1) as JobToken,
      imageId: String(index) as ImageId,
      outcome: 'completed',
      result: completedOutput(bytes),
    })
  }
  await flushPromises()
}

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

  it('shows Download once at least one image succeeded, and clicking it delivers the run', async () => {
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

    await download.trigger('click')
    await flushPromises()

    // R-X15: explicit. Nothing was delivered before the press.
    expect(downloadFinishedRun).toHaveBeenCalledOnce()
  })

  it('never delivers anything on its own (R-X15)', async () => {
    seed(['a', 'b'])
    await mountProcessing()
    await completeAll()

    expect(downloadFinishedRun).not.toHaveBeenCalled()
    expect(shareFinishedRun).not.toHaveBeenCalled()
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

  describe('storage quota rejection (T40, R-X40)', () => {
    it('replaces the whole counter/donut view with the rejection message and no Cancel button', async () => {
      seed(['a', 'b'])
      vi.mocked(checkCombinedQuota).mockResolvedValueOnce({
        archive: { ok: false, required: 50_000_000, available: 10_000_000 },
        combined: { ok: false, required: 50_000_000, available: 10_000_000 },
      })
      const wrapper = await mountProcessing()

      const rejected = wrapper.get('[data-testid="processing-quota-rejected"]')
      expect(rejected.text()).toContain('50.00 MB')
      expect(rejected.text()).toContain('10.00 MB')
      expect(wrapper.find('[data-testid="processing-counter"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-cancel"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="processing-back"]').text()).toBe('Back to images')
      expect(runs).toHaveLength(0)
    })
  })

  describe('storage write failure mid-run (T40, §10)', () => {
    it('halts with its own message, distinct from the out-of-memory one', async () => {
      seed(['a'])
      vi.mocked(writeOutputCopy).mockRejectedValueOnce(new Error('disk full'))
      const wrapper = await mountProcessing()

      runs[0]?.settle({
        token: 1 as JobToken,
        imageId: 'a' as ImageId,
        outcome: 'completed',
        result: completedOutput(400),
      })
      await flushPromises()

      const halted = wrapper.get('[data-testid="processing-halted"]')
      expect(halted.text()).toContain('Storage stopped working')
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(false)
    })
  })

  describe('Share (T42, R-X14/R-X48/R-X49)', () => {
    it('is absent when the exact capability check did not accept this payload', async () => {
      seed(['a'])
      const wrapper = await mountProcessing()
      await completeAll()

      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(false)
    })

    it('appears beside Download when the exact capability check accepts', async () => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      const wrapper = await mountProcessing()
      await completeAll()

      const share = wrapper.get('[data-testid="processing-share"]')
      expect(share.text()).toBe('Share')
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
    })

    it('hands the press to the platform Share action', async () => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get('[data-testid="processing-share"]').trigger('click')
      await flushPromises()

      expect(shareFinishedRun).toHaveBeenCalledOnce()
    })

    // R-V5 (T49): the handoff is user-directed, so nothing may reach platform/share.ts until
    // the user presses Share. The payload half of R-V5 — that only the completed output files
    // are handed over, never the archive or the report — is asserted in
    // src/pipeline/run-share.spec.ts; together the two describe the whole requirement.
    it('reaches the platform wrapper only on an explicit activation, never on its own', async () => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      const wrapper = await mountProcessing()

      // Mounted, mid-run, and with the run complete and Share on screen: still untouched.
      expect(shareFinishedRun).not.toHaveBeenCalled()
      await completeAll()
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(true)
      expect(shareFinishedRun).not.toHaveBeenCalled()

      await wrapper.get('[data-testid="processing-share"]').trigger('click')
      await flushPromises()

      // Called with nothing: the component passes no argument the user did not ask for.
      expect(shareFinishedRun).toHaveBeenCalledOnce()
      expect(vi.mocked(shareFinishedRun).mock.calls[0]).toEqual([])
    })

    it('is absent with zero successes, alongside Download (§10)', async () => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      const wrapper = await mountProcessing()

      runs[0]?.settle({
        token: 1 as JobToken,
        imageId: 'a' as ImageId,
        outcome: 'failed',
        reason: { kind: 'decode-failed' },
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="processing-back"]').text()).toBe('Back to images')
    })
  })

  describe('after a successful delivery (T42, R-X54)', () => {
    it.each([
      { action: 'processing-download', mock: 'download', label: 'Download started' },
      { action: 'processing-share', mock: 'share', label: 'Shared' },
    ] as const)('$mock replaces both actions with "$label"', async ({ action, mock, label }) => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      if (mock === 'download') {
        vi.mocked(downloadFinishedRun).mockImplementation(async () => {
          useRunStore().markDownloaded()
          return 'downloaded'
        })
      } else {
        vi.mocked(shareFinishedRun).mockImplementation(async () => {
          useRunStore().markShared()
          return 'shared'
        })
      }
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get(`[data-testid="${action}"]`).trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="processing-delivered"]').text()).toContain(label)
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(false)
      // R-K5/T42: the delivered state was otherwise visual-only; it must also be announced.
      expect(wrapper.get('[data-testid="processing-announcement"]').text()).toBe(label)
    })

    it('keeps the completed summary and both issue lists visible', async () => {
      seed(['a', 'b', 'c'])
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDownloaded()
        return 'downloaded'
      })
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
      runs[2]?.settle({
        token: 3 as JobToken,
        imageId: 'c' as ImageId,
        outcome: 'completed',
        result: {
          kind: 'size-target-unreachable',
          targetBytes: 100,
          achievedBytes: 200,
          format: 'jpeg',
          width: 800,
          height: 600,
        },
      })
      await flushPromises()

      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="processing-counter"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-donut"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="processing-figure-succeeded"]').text()).toBe('1 succeeded')
      expect(wrapper.find('[data-testid="processing-failures"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-skipped"]').exists()).toBe(true)
    })

    it('makes Back to images the remaining primary action', async () => {
      seed(['a'])
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDownloaded()
        return 'downloaded'
      })
      const wrapper = await mountProcessing()
      await completeAll()

      const back = wrapper.get('[data-testid="processing-back"]')
      expect(back.classes()).not.toContain('action--primary')

      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="processing-back"]').classes()).toContain('action--primary')
    })

    it('the delivered state is not a button', async () => {
      seed(['a'])
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDownloaded()
        return 'downloaded'
      })
      const wrapper = await mountProcessing()
      await completeAll()
      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      // R-X54: "a checked, non-interactive completion state".
      expect(wrapper.get('[data-testid="processing-delivered"]').element.tagName).not.toBe('BUTTON')
    })

    it('"Back to images" still reaches Gallery from the delivered state', async () => {
      seed(['a'])
      useUiStore().enterProcessing()
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDownloaded()
        return 'downloaded'
      })
      const wrapper = await mountProcessing()
      await completeAll()
      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      await wrapper.get('[data-testid="processing-back"]').trigger('click')

      expect(useUiStore().stageMode).toBe('gallery')
    })
  })

  describe('retryable delivery failures (T42, §10)', () => {
    it('states the ZIP assembly failure inline and keeps Download available', async () => {
      seed(['a', 'b'])
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDeliveryFailed('download-assembly')
        return 'assembly-failed'
      })
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      const error = wrapper.get('[data-testid="processing-download-error"]')
      expect(error.text()).toContain("couldn't be assembled")
      expect(error.text()).toContain('no partial file was kept')
      expect(error.text()).toContain('try again')
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-delivered"]').exists()).toBe(false)
      // R-K5/T42: inline delivery errors were otherwise visual-only; they must also be announced.
      expect(wrapper.get('[data-testid="processing-announcement"]').text()).toContain(
        "couldn't be assembled",
      )
    })

    it('states the blocked download inline, with what to do about it', async () => {
      seed(['a', 'b'])
      vi.mocked(downloadFinishedRun).mockImplementation(async () => {
        useRunStore().markDeliveryFailed('download-blocked')
        return 'blocked'
      })
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get('[data-testid="processing-download"]').trigger('click')
      await flushPromises()

      const error = wrapper.get('[data-testid="processing-download-error"]')
      expect(error.text()).toContain('browser blocked the download')
      expect(error.text()).toContain('Allow downloads')
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
      expect(wrapper.get('[data-testid="processing-announcement"]').text()).toContain(
        'browser blocked the download',
      )
    })

    it('states a failed share handoff inline and keeps both actions available', async () => {
      seed(['a', 'b'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      vi.mocked(probeFileShareForRun).mockResolvedValue(true)
      vi.mocked(shareFinishedRun).mockImplementation(async () => {
        useRunStore().markDeliveryFailed('share')
        return 'failed'
      })
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get('[data-testid="processing-share"]').trigger('click')
      await flushPromises()

      const error = wrapper.get('[data-testid="processing-share-error"]')
      expect(error.text()).toContain("didn't finish")
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-download-error"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="processing-announcement"]').text()).toContain(
        "didn't finish",
      )
    })

    // R-X50: "User cancellation is not an error."
    it('says nothing at all when the user cancels the system share sheet', async () => {
      seed(['a'])
      vi.mocked(canShareExactFiles).mockResolvedValue(true)
      vi.mocked(shareFinishedRun).mockResolvedValue('cancelled')
      const wrapper = await mountProcessing()
      await completeAll()

      await wrapper.get('[data-testid="processing-share"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="processing-share-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-download-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-delivered"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="processing-share"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="processing-download"]').exists()).toBe(true)
    })

    it('a failure reported by the back guard’s "Download and leave" surfaces in the same place', async () => {
      seed(['a', 'b'])
      const wrapper = await mountProcessing()
      await completeAll()

      // Not a click on this view's own button: the guard calls downloadFinishedRun() itself, and
      // the store is the only channel through which that failure can reach this message.
      useRunStore().markDeliveryFailed('download-blocked')
      await flushPromises()

      expect(wrapper.get('[data-testid="processing-download-error"]').text()).toContain(
        'browser blocked the download',
      )
      expect(wrapper.get('[data-testid="processing-announcement"]').text()).toContain(
        'browser blocked the download',
      )
    })
  })
})
