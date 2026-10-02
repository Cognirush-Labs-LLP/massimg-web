/**
 * Downloads the current run's output and resolves once the browser has been handed the file(s)
 * (Functional Design R-X16/R-X30/R-X42, T42's "Download and leave" action — see docs/ui-design.md
 * §14, R-X18). Intended contract for whoever wires this up:
 * - A single successful image (R-X16): download that image's output Blob directly, no ZIP/report.
 * - Multiple successful images (R-X30): read the OPFS archive via `readArchive()`
 *   (`src/platform/opfs.ts`), trigger its download as a ZIP, then `deleteArchive()` (R-X42).
 *
 * TODO(T38/T40/T41): not implemented yet. `useRunStore` does not retain output Blobs, nothing
 * calls `writeArchive`, and `client-zip` is not yet a dependency — the run-execution and
 * archive-assembly pipeline this depends on doesn't exist. `useBackNavigationGuard`'s R-X18 dialog
 * calls this function for its "Download and leave" action; it is mocked in that composable's own
 * tests so they don't depend on this gap being closed first.
 */
export async function downloadFinishedRun(): Promise<void> {
  throw new Error('downloadFinishedRun is not implemented yet (T38/T40/T41)')
}
