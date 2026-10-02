import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import type { BatchSettings } from '@/domain/job'
import type { ImageId, ImageRecord, Job } from '@/domain/types'
import type { JobOutcome } from '@/pipeline/pool'
import type { JobToken } from '@/pipeline/protocol'
import { PREVIEW_DEBOUNCE_MS, usePreviewEncode, type PreviewEncodeState } from './usePreviewEncode'

interface PendingRun {
  job: Job
  settle: (outcome: JobOutcome) => void
}

const runs: PendingRun[] = []
/** Every object-URL and pool event in order, so the release-before-decode ordering is assertable. */
const events: string[] = []

const run = vi.fn((job: Job) => {
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve
  })

  events.push(`run:${job.imageId}`)
  runs.push({ job, settle })

  return { token: runs.length as JobToken, done }
})

const pool = { run }
vi.mock('./preview-pool', () => ({ getPreviewPool: () => pool }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

function imageRecord(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: id as ImageId,
    name: `${id}.png`,
    relativePath: null,
    sizeBytes: 4096,
    width: 64,
    height: 48,
    sourceFormat: 'png',
    isAnimated: false,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    ...overrides,
  }
}

function batchSettings(overrides: Partial<BatchSettings> = {}): BatchSettings {
  return {
    quality: { kind: 'quality', value: 70 },
    dimension: { kind: 'original' },
    format: 'dont-change',
    ...overrides,
  }
}

function completed(bytes: number, imageId: string, token = 1): JobOutcome {
  return {
    token: token as JobToken,
    imageId: imageId as ImageId,
    outcome: 'completed',
    result: { bytes: new Uint8Array(bytes), format: 'png', caveats: [] },
  }
}

interface Harness {
  state: PreviewEncodeState
  image: Ref<ImageRecord | null>
  settings: Ref<BatchSettings>
  wantsOriginal: Ref<boolean>
  unmount: () => void
}

function mountEncode(initial: ImageRecord | null = imageRecord('a')): Harness {
  const image = ref<ImageRecord | null>(initial)
  const settings = ref<BatchSettings>(batchSettings())
  const wantsOriginal = ref(false)
  let state: PreviewEncodeState | null = null

  const wrapper = mount(
    defineComponent({
      setup() {
        state = usePreviewEncode({ image, settings, wantsOriginal })

        return () => h('div')
      },
    }),
  )

  if (state === null) {
    throw new Error('composable did not run')
  }

  return { state, image, settings, wantsOriginal, unmount: () => wrapper.unmount() }
}

let urlCounter = 0

beforeEach(() => {
  runs.length = 0
  events.length = 0
  run.mockClear()
  sourceFiles.clear()
  sourceFiles.set('a' as ImageId, new File([new Uint8Array([1, 2, 3])], 'a.png'))
  sourceFiles.set('b' as ImageId, new File([new Uint8Array([4, 5, 6])], 'b.png'))
  urlCounter = 0
  // jsdom's object-URL support is not something to depend on, and both calls are load-bearing for
  // R-B1/R-B4, so they are installed explicitly and recorded.
  URL.createObjectURL = vi.fn(() => {
    urlCounter += 1
    const url = `blob:preview/${urlCounter}`

    events.push(`create:${url}`)

    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => {
    events.push(`revoke:${url}`)
  })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePreviewEncode', () => {
  it('encodes immediately on entry, with no debounce (R-P1)', async () => {
    const harness = mountEncode()

    expect(harness.state.phase.value).toBe('encoding')
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(1)
    expect(runs[0]?.job.intent).toBe('preview')
    expect(runs[0]?.job.imageId).toBe('a')
    expect(harness.state.phase.value).toBe('encoding')
  })

  it('shows the measured size of the real encode once it completes', async () => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    expect(harness.state.phase.value).toBe('ready')
    expect(harness.state.compressedBytes.value).toBe(1234)
    expect(harness.state.compressedUrl.value).toBe('blob:preview/1')
  })

  it('produces one encode for a burst of settings changes (R-P3)', async () => {
    const harness = mountEncode()
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    for (let value = 71; value <= 75; value += 1) {
      harness.settings.value = batchSettings({ quality: { kind: 'quality', value } })
      await flushPromises()
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 100)
    }

    expect(run).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS)
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('hides and releases the stale result the moment a setting changes (R-B1, R-P4)', async () => {
    const harness = mountEncode()
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    harness.settings.value = batchSettings({ format: 'webp' })
    await flushPromises()

    expect(harness.state.phase.value).toBe('encoding')
    expect(harness.state.compressedBytes.value).toBeNull()
    expect(harness.state.compressedUrl.value).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview/1')
  })

  it('reacts to an edit changing on the same image, debounced like any other setting', async () => {
    const harness = mountEncode()
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    harness.image.value = imageRecord('a', {
      edit: { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 2 },
    })
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS)
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(runs[1]?.job.edit?.version).toBe(2)
  })

  it('releases the outgoing image before asking anything of the incoming one (R-P7, R-B5)', async () => {
    const harness = mountEncode()
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    harness.image.value = imageRecord('b')
    await flushPromises()

    expect(events).toEqual(['run:a', 'create:blob:preview/1', 'revoke:blob:preview/1', 'run:b'])
  })

  it('encodes a stepped-to image immediately rather than after the debounce (R-P1)', async () => {
    const harness = mountEncode()
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    harness.image.value = imageRecord('b')
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(runs[1]?.job.imageId).toBe('b')
  })

  it('never renders a result that arrives for an image already stepped away from', async () => {
    const harness = mountEncode()
    await flushPromises()

    harness.image.value = imageRecord('b')
    await flushPromises()

    // The first image's encode was not interrupted (R-X28) and lands here, late.
    runs[0]?.settle(completed(999, 'a'))
    await flushPromises()

    expect(harness.state.compressedUrl.value).toBeNull()
    expect(harness.state.compressedBytes.value).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps waiting on a superseded outcome, because a newer encode owns the frame (R-X28)', async () => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'superseded',
    })
    await flushPromises()

    expect(harness.state.phase.value).toBe('encoding')
    expect(harness.state.error.value).toBeNull()
  })

  it.each([
    ['decode-failed', { kind: 'decode-failed' }],
    ['encode-failed', { kind: 'encode-failed' }],
    ['out-of-memory', { kind: 'out-of-memory' }],
  ] as const)('surfaces a %s failure inline (§10)', async (kind, expected) => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind },
    })
    await flushPromises()

    expect(harness.state.phase.value).toBe('error')
    expect(harness.state.error.value).toEqual(expected)
  })

  it('names the output format for a path this build has no encoder for', async () => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'unimplemented', detail: 'cicp to png' },
    })
    await flushPromises()

    expect(harness.state.error.value).toEqual({ kind: 'unsupported', format: 'png' })
  })

  it('does not leave the frame waiting for ever when the worker dies', async () => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'terminated',
      cause: 'worker-error',
    })
    await flushPromises()

    expect(harness.state.phase.value).toBe('error')
  })

  it('retries the same image on request (§10)', async () => {
    const harness = mountEncode()
    await flushPromises()

    runs[0]?.settle({
      token: 1 as JobToken,
      imageId: 'a' as ImageId,
      outcome: 'failed',
      reason: { kind: 'encode-failed' },
    })
    await flushPromises()

    harness.state.retry()
    await flushPromises()

    expect(run).toHaveBeenCalledTimes(2)
    expect(harness.state.phase.value).toBe('encoding')
    expect(harness.state.error.value).toBeNull()
  })

  it('reports a missing source file rather than encoding nothing', async () => {
    sourceFiles.delete('a' as ImageId)
    const harness = mountEncode()
    await flushPromises()

    expect(run).not.toHaveBeenCalled()
    expect(harness.state.error.value).toEqual({ kind: 'source-missing' })
  })

  it('reports an animated AVIF rather than silently showing nothing (R-F8)', async () => {
    sourceFiles.set('c' as ImageId, new File([new Uint8Array([7])], 'c.avif'))
    const harness = mountEncode(imageRecord('c', { sourceFormat: 'avif', isAnimated: true }))
    await flushPromises()

    expect(run).not.toHaveBeenCalled()
    expect(harness.state.error.value).toEqual({ kind: 'animated-avif' })
  })

  it('is idle with no image, and encodes nothing', async () => {
    const harness = mountEncode(null)
    await flushPromises()

    expect(harness.state.phase.value).toBe('idle')
    expect(run).not.toHaveBeenCalled()
  })

  it('decodes the source only once the Original tab asks for it (R-B2)', async () => {
    const harness = mountEncode()
    await flushPromises()

    expect(harness.state.originalUrl.value).toBeNull()

    harness.wantsOriginal.value = true
    await flushPromises()

    expect(harness.state.originalUrl.value).toBe('blob:preview/1')

    // And the same URL is reused rather than remade on every flip.
    harness.wantsOriginal.value = false
    await flushPromises()
    harness.wantsOriginal.value = true
    await flushPromises()

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('releases the original alongside the compressed result when stepping', async () => {
    const harness = mountEncode()
    harness.wantsOriginal.value = true
    await flushPromises()

    const originalUrl = harness.state.originalUrl.value

    harness.image.value = imageRecord('b')
    await flushPromises()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(originalUrl)
    // Recreated for the incoming image, since the Original tab is still the one showing (R-P7).
    expect(harness.state.originalUrl.value).not.toBe(originalUrl)
  })

  it('releases both halves of the working set and cancels any pending encode on unmount (R-M4)', async () => {
    const harness = mountEncode()
    harness.wantsOriginal.value = true
    await flushPromises()
    runs[0]?.settle(completed(1234, 'a'))
    await flushPromises()

    const urls = [harness.state.compressedUrl.value, harness.state.originalUrl.value]

    harness.settings.value = batchSettings({ format: 'avif' })
    await flushPromises()
    harness.unmount()
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 4)
    await flushPromises()

    for (const url of urls) {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(url)
    }
    // The debounced encode never fires after the mode has been left.
    expect(run).toHaveBeenCalledTimes(1)
  })
})
