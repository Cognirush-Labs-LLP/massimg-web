// The preliminary half of Web Share support (Technical Design §9.1, R-X47, R-X48). Split in two
// across T40 and T42: this module's `probeFileShareForRun` decides, before a run starts, whether
// it is worth teeing successful outputs into individual OPFS files at all — a cheap optimisation
// that avoids pointless duplicate writes, not the authority to show the Share action. T42 adds the
// exact completion-time `canShare`/`share()` functions to this same module; this file does not
// assume or preclude that extension.

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
