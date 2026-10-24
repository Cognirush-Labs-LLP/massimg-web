import { readArchive, readOutputCopies } from '@/platform/opfs'
import { useRunStore } from '@/stores/run'

// Not a measured or specified name anywhere in the design documents — a plain, generic choice
// recorded here for whoever next needs to change it rather than hunting for where it lives.
const ARCHIVE_DOWNLOAD_NAME = 'compressed-images.zip'

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * The outcome of one Download press, matching the two distinct §10 rows this can fail on:
 * - `downloaded` — the file was handed to the browser. Not a confirmation that it was saved:
 *   nothing in the platform reports that back, which is why the artifacts are kept (see below).
 * - `assembly-failed` — §10 "ZIP assembly failure". The payload could not be read back out of
 *   storage, so nothing was handed over and no partial file was delivered.
 * - `blocked` — §10 "Download blocked by browser". The payload was fine; the browser refused the
 *   navigation.
 *
 * Neither failure deletes artifacts or moves `delivery` off `pending`: the results and both
 * delivery actions must survive a failed attempt so it can be retried (R-X50's pattern, which the
 * task applies to Download's failures as well as Share's).
 */
export type DownloadOutcome = 'downloaded' | 'assembly-failed' | 'blocked'

/**
 * Downloads the current run's output and resolves once the browser has been handed the file(s)
 * (Functional Design R-X16/R-X30/R-X42, R-X18's "Download and leave" — see docs/ui-design.md §14).
 *
 * The choice between a direct file and the ZIP is made from the run's **actual** successful count,
 * not its starting image count: a batch that started with several images but ends with exactly one
 * success still gets the direct R-X16 path, because T40's archive sink always keeps that single
 * success available as the direct-download candidate regardless of how many images the run began
 * with (see `pipeline/run-archive.ts`).
 */
export async function downloadFinishedRun(): Promise<DownloadOutcome> {
  const runStore = useRunStore()

  if (runStore.progress.succeeded === 0) {
    // Defensive: R-X14/§10 leave no Download affordance at all for a zero-success run, so this is
    // unreachable through the interface. Reported as the no-op it is rather than as a failure.
    return 'downloaded'
  }

  let payload: Blob
  let fileName: string

  try {
    if (runStore.progress.succeeded === 1) {
      const [file] = await readOutputCopies()
      if (!file) {
        throw new Error('downloadFinishedRun: no output copy for a single-success run')
      }
      payload = file
      fileName = file.name
    } else {
      payload = await readArchive()
      fileName = ARCHIVE_DOWNLOAD_NAME
    }
  } catch {
    runStore.markDeliveryFailed('download-assembly')
    return 'assembly-failed'
  }

  try {
    triggerDownload(payload, fileName)
  } catch {
    runStore.markDeliveryFailed('download-blocked')
    return 'blocked'
  }

  // Deliberately no `deleteRunArtifacts()` here, and none on the Share path either.
  //
  // Handing a file to the browser is a one-way announcement: `anchor.click()` resolves nothing
  // and throws nothing, so a download the browser silently declines — an insecure-origin block,
  // a full disk, a policy, a dialog the user dismissed — is indistinguishable from one that
  // saved. Deleting the run's only copy on that signal destroyed the user's results at the exact
  // moment the app was least sure anything had been delivered, and told them it had worked.
  //
  // The artifacts now live until the user actually leaves Processing, where
  // `useProcessingRun`'s scope disposal already cleans them up (R-X42's cleanup still happens,
  // just at the point the results are genuinely finished with). Share stopped deleting on success
  // for a related reason: `navigator.share()` resolving does not mean the target has read the
  // files yet (see `run-share.ts`).
  runStore.markDownloaded()
  return 'downloaded'
}
