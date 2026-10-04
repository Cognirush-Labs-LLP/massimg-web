import { deleteRunArtifacts, readArchive, readOutputCopies } from '@/platform/opfs'
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
 * Downloads the current run's output and resolves once the browser has been handed the file(s)
 * (Functional Design R-X16/R-X30/R-X42, T42's "Download and leave" action — see docs/ui-design.md
 * §14, R-X18).
 *
 * The choice between a direct file and the ZIP is made from the run's **actual** successful count,
 * not its starting image count: a batch that started with several images but ends with exactly one
 * success still gets the direct R-X16 path, because T40's archive sink always keeps that single
 * success available as the direct-download candidate regardless of how many images the run began
 * with (see `pipeline/run-archive.ts`).
 */
export async function downloadFinishedRun(): Promise<void> {
  const runStore = useRunStore()

  if (runStore.progress.succeeded === 0) {
    return
  }

  if (runStore.progress.succeeded === 1) {
    const [file] = await readOutputCopies()
    if (file) {
      triggerDownload(file, file.name)
    }
  } else {
    const archive = await readArchive()
    triggerDownload(archive, ARCHIVE_DOWNLOAD_NAME)
  }

  await deleteRunArtifacts()
  runStore.markDownloaded()
}
