// Feature detection only — never user-agent sniffing (Technical Design §10.1, §10.3, §12).

export interface Capabilities {
  opfs: boolean
  folderPicker: boolean
  crossOriginIsolated: boolean
  /**
   * Whether this build can decode HEIC/HEIF (§10 "HEIC with no available decoder", R-I2). HEIC
   * decode goes through ImageMagick WASM as ordinary input (T23) — a compiled-in codec list is a
   * build-time fact, not something a browser API can be asked about at runtime, so this is not a
   * probe like `opfs` below. It is hardcoded `true` because assumptions.md A2 confirms the current
   * WASM build's delegate list includes `heic` and §5.2 confirms decode works on all three target
   * engines; flip it by hand if a future build ever ships without HEIC support. See
   * docs/backlog.md BL-009: no real browser condition can make this `false` today, so the rejection
   * path it feeds is unit-tested by injecting `false` directly rather than by a live trigger.
   */
  heicDecode: boolean
}

const OPFS_PROBE_NAME = '.icompress-capability-probe'

// A functional probe, not a presence check: `navigator.storage.getDirectory` can exist and still
// throw on call (observed on WebKit's ephemeral Playwright context; the same failure mode private
// browsing produces — see docs/assumptions.md B3 and docs/task-notes/T01.md).
async function probeOpfs(): Promise<boolean> {
  if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
    return false
  }

  try {
    const root = await navigator.storage.getDirectory()
    try {
      const handle = await root.getFileHandle(OPFS_PROBE_NAME, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array([0]))
      await writable.close()
      return true
    } finally {
      await root.removeEntry(OPFS_PROBE_NAME).catch(() => {})
    }
  } catch {
    return false
  }
}

function detectFolderPicker(): boolean {
  return 'webkitdirectory' in document.createElement('input')
}

function detectCrossOriginIsolated(): boolean {
  return self.crossOriginIsolated === true
}

// Always re-probes. Use this in tests, or anywhere freshness matters more than avoiding the OPFS
// probe's cost. Most app code wants `getCapabilities()` instead.
export async function detectCapabilities(): Promise<Capabilities> {
  return {
    opfs: await probeOpfs(),
    folderPicker: detectFolderPicker(),
    crossOriginIsolated: detectCrossOriginIsolated(),
    heicDecode: true,
  }
}

let cached: Promise<Capabilities> | undefined

// Detect once per app session and reuse the result. Call `detectCapabilities()` directly if a
// caller genuinely needs to re-probe (e.g. after a storage-permission change).
export function getCapabilities(): Promise<Capabilities> {
  if (!cached) {
    cached = detectCapabilities()
  }
  return cached
}
