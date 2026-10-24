import { readOutputCopies } from '@/platform/opfs'
import { shareFiles, type ShareOutcome } from '@/platform/share'
import { useRunStore } from '@/stores/run'

/**
 * Hands every successful output of the current run to the system share sheet in one call
 * (Functional Design R-X49, R-X50, R-X42, R-V5; Technical Design §9.1).
 *
 * `readOutputCopies()` returns exactly the individual image copies, in ascending write index —
 * which `pipeline/run-archive.ts` sets to each image's grid position for a Share-eligible run, so
 * this is R-X49's grid order. The archive and the report live outside that set entirely and can
 * therefore never leak into a share payload.
 *
 * **Must be called directly from the button's click handler**, with nothing awaited first: Web
 * Share is gesture-gated (§9.1, "only a fresh button activation may call `navigator.share`"). The
 * one await before the platform call is the OPFS handle read below, which hands back lazy
 * file handles rather than reading bytes — see docs/task-notes/T42.md on what is and is not
 * measured about that.
 *
 * Mirrors `run-download.ts`'s shape, including its rule that only a *successful* delivery touches
 * the delivery state:
 * - `shared` — the run is fulfilled. Storage is left alone (see below).
 * - `cancelled` — R-X50: not an error. Nothing is written, nothing is deleted, nothing is said.
 * - `failed` — the retryable inline error; results, Download and Share all remain.
 *
 * Deliberately no `deleteRunArtifacts()` on `shared`, exactly as in `run-download.ts`: the
 * handed-over files are lazy OPFS handles, and `share()` resolving does not mean the target has
 * read them. Chrome on Windows resolves as the share sheet opens; deleting then left the sheet
 * showing 0 bytes and WhatsApp receiving nothing (T51 follow-up, measured by hand). Leaving
 * Processing, and application start, still clean up (R-X42).
 */
export async function shareFinishedRun(): Promise<ShareOutcome> {
  const runStore = useRunStore()
  const files = await readOutputCopies()
  const outcome = await shareFiles(files)

  if (outcome === 'shared') {
    runStore.markShared()
  } else if (outcome === 'failed') {
    runStore.markDeliveryFailed('share')
  }

  return outcome
}
