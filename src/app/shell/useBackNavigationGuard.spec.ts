import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { ImageId } from '@/domain/types'
import { useUiStore } from '@/stores/ui'
import { useRunStore } from '@/stores/run'
import { downloadFinishedRun } from '@/pipeline/run-download'
import { useBackNavigationGuard } from './useBackNavigationGuard'

vi.mock('@/pipeline/run-download', () => ({
  downloadFinishedRun: vi.fn().mockResolvedValue('downloaded'),
}))

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

// Captured into an outer variable rather than read back off `wrapper.vm` — a setup() return
// isn't a typed instance property without extra ceremony, and the composable's own return type
// is already exactly what every test here needs.
let guard: ReturnType<typeof useBackNavigationGuard> | null = null

const Host = defineComponent({
  setup() {
    guard = useBackNavigationGuard()
  },
  render() {
    return h('div')
  },
})

let wrapper: VueWrapper | null = null

function mountHost(): void {
  wrapper = mount(Host)
}

function dispatchPopstate(): void {
  window.dispatchEvent(new PopStateEvent('popstate'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  // `history.pushState` isn't mocked away (only spied on), so it really mutates jsdom's one
  // shared `history` object across every test in this file — reset `state` to a clean slate each
  // time so one test's leftover marker can't change another's "is this a reload?" starting point.
  history.replaceState(null, '')
  vi.spyOn(history, 'pushState')
  vi.spyOn(history, 'back').mockImplementation(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  guard = null
  vi.restoreAllMocks()
  vi.mocked(downloadFinishedRun).mockReset()
  vi.mocked(downloadFinishedRun).mockResolvedValue('downloaded')
})

/**
 * R-X18's dialog only governs a run with results still sitting undelivered, so every test that
 * expects it must give the run something to lose — a bare `finishRun()` on an all-failed run has
 * no Download action at all (§10 "Every image in a run failed or was skipped").
 */
function finishRunWithOneSuccess(): void {
  const run = useRunStore()
  run.startRun(1)
  run.recordResult(idA, { kind: 'succeeded', inputBytes: 1000, outputBytes: 400, caveats: [] })
  run.finishRun()
}

describe('useBackNavigationGuard', () => {
  it('pushes one base guard entry on mount', () => {
    mountHost()

    expect(history.pushState).toHaveBeenCalledTimes(1)
  })

  it('does not push a second base entry on mount if already sitting on one (simulates a reload)', () => {
    // A page reload re-runs this composable while the browser's actual history.state survives
    // unchanged — without the guard, this would stack one extra entry per reload.
    history.pushState({ icompressGuard: 'base' }, '')
    vi.mocked(history.pushState).mockClear()

    mountHost()

    expect(history.pushState).not.toHaveBeenCalled()
  })

  it('pushes one entry entering a nested stage, and not again for a further nested hop', () => {
    mountHost()
    const ui = useUiStore()

    ui.openPreview(idA)
    expect(history.pushState).toHaveBeenCalledTimes(2)

    ui.openEdit(idA)
    expect(history.pushState).toHaveBeenCalledTimes(2)
  })

  it('a back press in Edit performs closeEdit and re-arms the guard for Preview', () => {
    mountHost()
    const ui = useUiStore()
    ui.openEdit(idA)
    vi.mocked(history.pushState).mockClear()

    dispatchPopstate()

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe(idA)
    expect(history.pushState).toHaveBeenCalledTimes(1)
  })

  it('a back press in Preview returns to Gallery and does not re-arm', () => {
    mountHost()
    const ui = useUiStore()
    ui.openPreview(idA)
    vi.mocked(history.pushState).mockClear()

    dispatchPopstate()

    expect(ui.stageMode).toBe('gallery')
    expect(history.pushState).not.toHaveBeenCalled()
  })

  it('a second back press once flat opens the leave-intent dialog', () => {
    mountHost()
    const ui = useUiStore()
    ui.openPreview(idA)

    dispatchPopstate() // preview -> gallery, flat
    dispatchPopstate() // base guard consumed -> leave intent

    expect(guard?.dialog.value?.actions.map((action) => action.id)).toEqual(['stay', 'leave'])
  })

  it('"stay" on the leave-intent dialog re-arms the base guard and closes it', () => {
    mountHost()
    dispatchPopstate() // base guard consumed -> leave intent
    vi.mocked(history.pushState).mockClear()

    guard?.handleDialogAction('stay')

    expect(history.pushState).toHaveBeenCalledTimes(1)
    expect(guard?.dialog.value).toBeNull()
  })

  it('"leave" continues the navigation itself rather than leaving it half-finished', () => {
    mountHost()
    dispatchPopstate() // consumes the base guard entry, landing on the SPA's own initial entry
    vi.mocked(history.pushState).mockClear()
    vi.mocked(history.back).mockClear()

    guard?.handleDialogAction('leave')

    // The pop that opened this dialog only consumed our own synthetic entry — the same
    // document is still showing, so "Leave" must drive the browser back once more itself.
    expect(history.back).toHaveBeenCalledTimes(1)
    expect(history.pushState).not.toHaveBeenCalled()
    expect(guard?.dialog.value).toBeNull()
  })

  it('does not reopen the leave-intent dialog for the self-triggered pop "leave" causes', () => {
    mountHost()
    dispatchPopstate()
    guard?.handleDialogAction('leave')

    // Simulates the browser actually having somewhere further back to go: our own history.back()
    // call above (mocked to a no-op) would otherwise have produced this pop for real.
    dispatchPopstate()

    expect(guard?.dialog.value).toBeNull()
  })

  it('un-sticks the self-consume flag if history.back() had nowhere to go, via its safety net', async () => {
    mountHost()
    dispatchPopstate() // consumes the base guard entry -> leave-intent dialog
    guard?.handleDialogAction('leave') // history.back() is mocked to a no-op: no popstate follows

    // Real would-be no-op never arrives to clear the flag itself — only the safety-net timeout
    // does. Without it, the next genuine press below would be silently swallowed forever.
    await new Promise((resolve) => setTimeout(resolve, 10))

    dispatchPopstate()
    expect(guard?.dialog.value?.actions.map((action) => action.id)).toEqual(['stay', 'leave'])
  })

  it('an on-screen exit from a nested stage self-consumes the stale forward entry', () => {
    mountHost()
    const ui = useUiStore()
    ui.openPreview(idA)

    ui.backToGallery() // on-screen control, not a back press

    expect(history.back).toHaveBeenCalledTimes(1)

    // The resulting popstate is our own self-triggered one and must be swallowed, not treated
    // as a genuine user press.
    dispatchPopstate()
    expect(ui.stageMode).toBe('gallery')
    expect(guard?.dialog.value).toBeNull()
  })

  it("still swallows the on-screen exit's pop when the browser delivers it late", async () => {
    mountHost()
    const ui = useUiStore()
    ui.openPreview(idA)

    ui.backToGallery()

    // The test above dispatches the pop in the same tick. Real browsers do not: measured in
    // Playwright, both Chromium and Firefox run a setTimeout(..., 0) scheduled before
    // history.back() *before* delivering the popstate. The previous implementation cleared its
    // "this pop is mine" flag on exactly such a timeout, so by the time the pop landed it read
    // as a user back press and put the leave-intent dialog over the Gallery — which is what
    // Firefox users saw when they pressed "Back to images".
    await new Promise((resolve) => setTimeout(resolve, 10))
    dispatchPopstate()

    expect(ui.stageMode).toBe('gallery')
    expect(guard?.dialog.value).toBeNull()
  })

  describe('processing (R-X18/R-X19)', () => {
    it('cancels silently when the run is still in flight', () => {
      mountHost()
      const ui = useUiStore()
      ui.enterProcessing()

      dispatchPopstate()

      expect(ui.stageMode).toBe('gallery')
      expect(guard?.dialog.value).toBeNull()
    })

    // R-X54: "the delivered path does not show the undelivered-results confirmation".
    it.each(['markDownloaded', 'markShared'] as const)(
      'cancels silently when the run was already delivered via %s',
      (mark) => {
        mountHost()
        const ui = useUiStore()
        const run = useRunStore()
        ui.enterProcessing()
        finishRunWithOneSuccess()
        run[mark]()

        dispatchPopstate()

        expect(ui.stageMode).toBe('gallery')
        expect(guard?.dialog.value).toBeNull()
      },
    )

    it('opens the three-way dialog when finished and undelivered, leaving stageMode untouched', () => {
      mountHost()
      const ui = useUiStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()

      dispatchPopstate()

      expect(ui.stageMode).toBe('processing')
      expect(guard?.dialog.value?.actions.map((action) => action.id)).toEqual([
        'stay',
        'leave-without-downloading',
        'download-and-leave',
      ])
    })

    // §10 "Every image in a run failed or was skipped": no output, Download or Share action — and
    // "Download and leave" is a Download action, so the dialog has nothing to offer.
    it('leaves silently with zero successes, offering no Download at all', () => {
      mountHost()
      const ui = useUiStore()
      const run = useRunStore()
      ui.enterProcessing()
      run.startRun(1)
      run.recordResult(idB, { kind: 'failed', reason: { kind: 'decode-failed' } })
      run.finishRun()

      dispatchPopstate()

      expect(ui.stageMode).toBe('gallery')
      expect(guard?.dialog.value).toBeNull()
    })

    // §10 "Out of memory" / "Storage write failure mid-run": partial results and every stored
    // artifact are already gone, so there is nothing left to download or discard.
    it.each(['out-of-memory', 'storage-failure'] as const)(
      'leaves silently after a %s halt, even with an earlier success',
      (reason) => {
        mountHost()
        const ui = useUiStore()
        const run = useRunStore()
        ui.enterProcessing()
        run.startRun(2)
        run.recordResult(idA, {
          kind: 'succeeded',
          inputBytes: 1000,
          outputBytes: 400,
          caveats: [],
        })
        run.haltRun(reason)

        dispatchPopstate()

        expect(ui.stageMode).toBe('gallery')
        expect(guard?.dialog.value).toBeNull()
      },
    )

    it('"stay" re-arms the guard and keeps the user on Processing', () => {
      mountHost()
      const ui = useUiStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()
      dispatchPopstate()
      vi.mocked(history.pushState).mockClear()

      guard?.handleDialogAction('stay')

      expect(ui.stageMode).toBe('processing')
      expect(history.pushState).toHaveBeenCalledTimes(1)
      expect(guard?.dialog.value).toBeNull()
    })

    it('"leave without downloading" discards the run and returns to Gallery', () => {
      mountHost()
      const ui = useUiStore()
      const run = useRunStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()
      dispatchPopstate()

      guard?.handleDialogAction('leave-without-downloading')

      expect(ui.stageMode).toBe('gallery')
      expect(run.delivery).toBe('pending')
      expect(downloadFinishedRun).not.toHaveBeenCalled()
    })

    it('"download and leave" downloads, then returns to Gallery', async () => {
      mountHost()
      const ui = useUiStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()
      dispatchPopstate()

      await guard?.handleDialogAction('download-and-leave')

      expect(downloadFinishedRun).toHaveBeenCalledOnce()
      expect(ui.stageMode).toBe('gallery')
    })

    it('does not mark the delivery state itself — downloadFinishedRun owns that', async () => {
      mountHost()
      const ui = useUiStore()
      const run = useRunStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()
      dispatchPopstate()

      await guard?.handleDialogAction('download-and-leave')

      // The real function sets `downloaded` internally; the mock here deliberately does not, so a
      // second `markDownloaded()` call in the guard would show up as a false 'downloaded'.
      expect(run.delivery).toBe('pending')
    })

    // Leaving on a failed download would unmount Processing.vue, whose onScopeDispose deletes the
    // very artifacts the inline error is inviting the user to retry.
    it.each(['assembly-failed', 'blocked'] as const)(
      '"download and leave" stays on Processing when the download %s',
      async (outcome) => {
        mountHost()
        const ui = useUiStore()
        ui.enterProcessing()
        finishRunWithOneSuccess()
        dispatchPopstate()
        vi.mocked(downloadFinishedRun).mockResolvedValueOnce(outcome)

        await guard?.handleDialogAction('download-and-leave')

        expect(ui.stageMode).toBe('processing')
        expect(guard?.dialog.value).toBeNull()
      },
    )

    it('re-arms the back guard after staying put on a failed download', async () => {
      mountHost()
      const ui = useUiStore()
      ui.enterProcessing()
      finishRunWithOneSuccess()
      dispatchPopstate()
      vi.mocked(downloadFinishedRun).mockResolvedValueOnce('blocked')

      await guard?.handleDialogAction('download-and-leave')

      // Without the re-arm, the pop that opened the dialog has already consumed the nested
      // entry, so this second press would fall through to the leave-the-app dialog instead.
      dispatchPopstate()

      expect(guard?.dialog.value?.actions.map((action) => action.id)).toEqual([
        'stay',
        'leave-without-downloading',
        'download-and-leave',
      ])
    })
  })
})
