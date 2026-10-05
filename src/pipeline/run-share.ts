import { deleteRunArtifacts, readOutputCopies } from '@/platform/opfs'
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
 * storage or the delivery state:
 * - `shared` — R-X42 cleanup runs and the run is fulfilled.
 * - `cancelled` — R-X50: not an error. Nothing is written, nothing is deleted, nothing is said.
 * - `failed` — the retryable inline error; results, Download and Share all remain.
 */
export async function shareFinishedRun(): Promise<ShareOutcome> {
  const runStore = useRunStore()
  const files = await readOutputCopies()
  const outcome = await shareFiles(files)

  if (outcome === 'shared') {
    await deleteRunArtifacts()
    runStore.markShared()
  } else if (outcome === 'failed') {
    runStore.markDeliveryFailed('share')
  }

  return outcome
}
