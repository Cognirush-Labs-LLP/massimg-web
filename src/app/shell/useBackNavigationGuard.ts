import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import { isNestedStage, performStageBackAction, useUiStore } from '@/stores/ui'
import { useRunStore } from '@/stores/run'
import { downloadFinishedRun } from '@/pipeline/run-download'
import { t } from '@/i18n/t'

export interface ConfirmDialogConfig {
  title: string
  body: string
  actions: { id: string; label: string }[]
  escapeActionId?: string
}

type GuardDialog = 'leave-intent' | 'processing-leave'

const GUARD_STATE_MARKER = { icompressGuard: 'base' } as const

/**
 * Integrates the browser back button with the stage-mode state machine (Functional Design
 * R-M6–R-M9, R-X18/R-X19). Gallery is the app's only route and its four stage modes never become
 * URLs (R-S1, T31), so without this, back has nothing app-aware to consume and exits the SPA
 * outright.
 *
 * Only ever called from ToolPage.vue's existing client-only `onMounted` — this function touches
 * `history`/`window` immediately on invocation (no internal onMounted of its own), so it relies on
 * its caller's context for SSR safety, the same contract `useFocusTrap` documents for itself.
 */
export function useBackNavigationGuard(): {
  dialog: ComputedRef<ConfirmDialogConfig | null>
  handleDialogAction: (id: string) => Promise<void>
} {
  const uiStore = useUiStore()
  const runStore = useRunStore()

  // Whether a synthetic entry for the current nested stage currently sits above the base guard
  // entry pushed below. Not a ref: read and written synchronously inside the watch/popstate
  // handlers below, never rendered.
  let hasNestedEntry = false
  // Set just before this module calls history.back() itself, to tell the very next popstate
  // apart from one the user actually triggered (see the `stageMode` watch's gallery branch).
  let expectingSelfTriggeredPop = false

  const activeDialog = ref<GuardDialog | null>(null)

  function pushNestedEntry(): void {
    history.pushState(GUARD_STATE_MARKER, '')
    hasNestedEntry = true
  }

  function isGuardState(state: unknown): boolean {
    return typeof state === 'object' && state !== null && 'icompressGuard' in state
  }

  // A page reload re-runs this composable from scratch while leaving the browser's actual
  // session history untouched — `history.state` survives a reload even though every in-memory
  // flag here resets to its default. Pushing unconditionally would stack one extra guard entry
  // per reload, silently requiring more and more back presses over a session to actually leave.
  // Only push if the entry we're already sitting on isn't already one of our own.
  if (!isGuardState(history.state)) {
    history.pushState(GUARD_STATE_MARKER, '')
  }

  // Marks the next popstate as our own doing rather than a user press, for a `history.back()`
  // call that isn't guaranteed to produce one (there may be nothing further back to go to) — the
  // real popstate, when it does arrive, clears this itself; the timeout is only a safety net so a
  // no-op back() can't leave it stuck true forever, which would otherwise silently swallow the
  // next genuine press.
  function selfConsumeNextPop(): void {
    expectingSelfTriggeredPop = true
    history.back()
    setTimeout(() => {
      expectingSelfTriggeredPop = false
    }, 0)
  }

  watch(
    () => uiStore.stageMode,
    (mode) => {
      if (isNestedStage(mode)) {
        if (!hasNestedEntry) {
          pushNestedEntry()
        }
        return
      }

      // mode === 'gallery'
      if (hasNestedEntry) {
        // An on-screen control (not a back press) left a nested stage straight for Gallery,
        // e.g. Preview's "Back to images" button — the forward entry it leaves behind would
        // otherwise desync the 1st-back/2nd-back count. Self-consume it silently.
        hasNestedEntry = false
        selfConsumeNextPop()
      }
    },
    { flush: 'sync' },
  )

  function handleProcessingPop(): void {
    // R-X18 only governs a run that has results still sitting undelivered. Three cases have
    // nothing to lose and so leave silently:
    //  - the run is still in flight (R-X19: a plain Cancel raises no confirmation);
    //  - delivery already succeeded (R-X54: the delivered path never shows this dialog);
    //  - the run produced nothing deliverable — zero successes, or a halt that already discarded
    //    every partial result and artifact. §10 is explicit that such a run has "no output,
    //    Download or Share action", and "Download and leave" is a Download action.
    const nothingToDeliver = runStore.haltReason !== null || runStore.progress.succeeded === 0

    if (!runStore.finished || runStore.delivery !== 'pending' || nothingToDeliver) {
      uiStore.cancelProcessing()
      return
    }

    // R-X18: a finished, undelivered run raises the three-way dialog instead of transitioning
    // immediately — stageMode stays 'processing' until the dialog resolves.
    activeDialog.value = 'processing-leave'
  }

  function onPopstate(): void {
    if (expectingSelfTriggeredPop) {
      expectingSelfTriggeredPop = false
      return
    }

    if (activeDialog.value !== null) {
      // A second back press while a dialog is already up reads as confirming "leave".
      activeDialog.value = null
      return
    }

    if (hasNestedEntry) {
      hasNestedEntry = false
      if (uiStore.stageMode === 'processing') {
        handleProcessingPop()
      } else {
        performStageBackAction(uiStore)
      }
      return
    }

    // The base guard entry itself was just consumed — genuine leave intent.
    activeDialog.value = 'leave-intent'
  }

  window.addEventListener('popstate', onPopstate)
  onBeforeUnmount(() => {
    window.removeEventListener('popstate', onPopstate)
  })

  const dialog = computed<ConfirmDialogConfig | null>(() => {
    if (activeDialog.value === 'leave-intent') {
      return {
        title: t('shell.leaveConfirm.title'),
        body: t('shell.leaveConfirm.body'),
        actions: [
          { id: 'stay', label: t('shell.leaveConfirm.stay') },
          { id: 'leave', label: t('shell.leaveConfirm.leave') },
        ],
      }
    }

    if (activeDialog.value === 'processing-leave') {
      return {
        title: t('processing.leaveConfirm.title'),
        body: t('processing.leaveConfirm.body'),
        actions: [
          { id: 'stay', label: t('processing.leaveConfirm.stay') },
          {
            id: 'leave-without-downloading',
            label: t('processing.leaveConfirm.leaveWithoutDownloading'),
          },
          { id: 'download-and-leave', label: t('processing.leaveConfirm.downloadAndLeave') },
        ],
      }
    }

    return null
  })

  async function handleDialogAction(id: string): Promise<void> {
    const dialogWasOpen = activeDialog.value
    activeDialog.value = null

    if (dialogWasOpen === 'leave-intent') {
      if (id === 'stay') {
        // Re-arm the base guard entry itself — stageMode is 'gallery' here, so this must not
        // set hasNestedEntry (that would desync the next nested-stage push and collapse two
        // back-presses' worth of history into one).
        history.pushState(GUARD_STATE_MARKER, '')
        return
      }

      // 'leave': the pop that got us here only consumed our own base guard entry, landing back
      // on the SPA's own initial history entry — the same document, so nothing actually left yet.
      // Continue the navigation ourselves; this resulting pop (if the browser has anywhere
      // further back to go at all) is self-triggered and must be swallowed, not re-open a dialog.
      selfConsumeNextPop()
      return
    }

    if (dialogWasOpen === 'processing-leave') {
      if (id === 'stay') {
        pushNestedEntry()
        return
      }

      if (id === 'leave-without-downloading') {
        uiStore.finishProcessing()
        return
      }

      if (id === 'download-and-leave') {
        // `downloadFinishedRun` sets the delivery state itself; nothing to mark here.
        if ((await downloadFinishedRun()) === 'downloaded') {
          uiStore.finishProcessing()
          return
        }

        // §10 "ZIP assembly failure" / "Download blocked by browser": stay on Processing. Leaving
        // would unmount Processing.vue, whose `onScopeDispose` runs `abortAndCleanup()` and would
        // delete the very artifacts the user is now being invited to retry downloading. The
        // dialog is already closed, so what the user sees is Processing's own inline error (read
        // from the same `runStore.deliveryError`) above a Download button that still works.
        //
        // Re-arming matters: the pop that opened this dialog consumed the nested history entry,
        // so without this the *next* back press would fall through to the leave-intent dialog
        // instead of this one (R-M6/R-M8).
        pushNestedEntry()
      }
    }
  }

  return { dialog, handleDialogAction }
}
