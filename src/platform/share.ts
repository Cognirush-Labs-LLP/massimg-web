// Web Share support (Technical Design §9.1, R-X47 to R-X50, R-V5). Three functions, in the order
// a run uses them:
//
// 1. `probeFileShareForRun` — before the run starts, decides whether it is worth teeing successful
//    outputs into individual OPFS files at all. A cheap optimisation that avoids pointless
//    duplicate writes, *not* the authority to show the Share action (§9.1).
// 2. `canShareExactFiles` — at completion, on the exact completed `File[]`. This one *is* the
//    authority: R-X48 shows Share only when the browser accepts this precise payload.
// 3. `shareFiles` — on a fresh button activation, and only then.
//
// This module is the only place the app touches `navigator.canShare`/`navigator.share`; the
// component never calls either directly, and the payload contains `files` and nothing else (R-V5,
// §9.1: "no title, text, URL, ZIP or report").

import type { EncodableFormat } from '@/domain/types'
import { mimeForFormat } from '@/domain/format'
import { getCapabilities } from './capability'

// canShare only inspects File.type and size, not pixel validity (T39-A,
// verification/t39a-web-share/results.json) — a tiny non-empty buffer tagged with the real MIME
// type is as representative as a real encoded image for this probe.
const PROBE_BYTES = new Uint8Array([0])

/**
 * Whether this run's resolved output formats can all be shared, on top of the generic
 * `Capabilities.fileShare` flag. Checks one representative non-empty `File` per distinct format
 * actually in play this run, since a browser can accept one MIME type and reject another.
 */
export async function probeFileShareForRun(formats: readonly EncodableFormat[]): Promise<boolean> {
  const { fileShare } = await getCapabilities()
  if (!fileShare) {
    return false
  }

  if (typeof navigator === 'undefined' || !('canShare' in navigator)) {
    return false
  }

  const distinctFormats = [...new Set(formats)]
  if (distinctFormats.length === 0) {
    return false
  }

  try {
    const files = distinctFormats.map(
      (format) => new File([PROBE_BYTES], `probe.${format}`, { type: mimeForFormat(format) }),
    )
    return navigator.canShare({ files })
  } catch {
    return false
  }
}

/**
 * R-X48's exact check, run once the run has completed and its real output `File`s exist. Unlike
 * the preliminary probe above this is the authority for showing **Share**: T39-A measured that a
 * browser can accept a representative payload and still reject the real one.
 *
 * Three distinct states collapse to `false` here, deliberately: the API is absent, the payload is
 * empty (nothing succeeded, or the byte ceiling already excluded the run, so there is nothing to
 * ask about), or the browser rejected this exact array. None of them is an error — each simply
 * means Share is not offered (R-X48, §10 "Exact file payload cannot be shared").
 */
export async function canShareExactFiles(files: readonly File[]): Promise<boolean> {
  const { fileShare } = await getCapabilities()
  if (!fileShare) {
    return false
  }

  if (typeof navigator === 'undefined' || !('canShare' in navigator)) {
    return false
  }

  if (files.length === 0) {
    return false
  }

  try {
    return navigator.canShare({ files: [...files] })
  } catch {
    return false
  }
}

/**
 * The outcome of one `navigator.share({ files })` call, as R-X50 distinguishes them:
 * - `shared` — the browser handed the payload to the chosen target or the OS. That counts as
 *   successful delivery; the app cannot know whether the target later used it.
 * - `cancelled` — the user dismissed the system share sheet. Not an error, and not a failure:
 *   results and both delivery actions stay exactly as they were.
 * - `failed` — any other rejection. Stated inline, and Share can be retried.
 */
export type ShareOutcome = 'shared' | 'cancelled' | 'failed'

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  )
}

/**
 * Hands the files to the system share sheet (R-X49, R-V5). Must be called from a fresh user
 * activation — Web Share is gesture-gated, so nothing slow may run between the button press and
 * this call (T39-A burned a whole test run on exactly that mistake).
 *
 * `files` only: no title, no text, no URL, and never the ZIP or the report (§9.1).
 *
 * Duck-types `AbortError` on `name` rather than `instanceof DOMException`, since the one thing
 * that must not be misclassified here is cancellation (R-X50: not an error) and the engines are
 * not guaranteed to throw the same error class.
 */
export async function shareFiles(files: readonly File[]): Promise<ShareOutcome> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'failed'
  }

  try {
    await navigator.share({ files: [...files] })
    return 'shared'
  } catch (error) {
    return isAbortError(error) ? 'cancelled' : 'failed'
  }
}
