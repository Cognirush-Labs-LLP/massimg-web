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

  /**
   * Whether this browser can hand image files to the system share sheet at all (Technical Design
   * §9.1, R-X47/R-X48). A generic, representative-payload functional probe, not presence sniffing:
   * `'share'`/`'canShare'` can exist and still reject every real payload. This is the cheap,
   * once-per-session flag; the batch-specific preliminary probe for a particular run's actual
   * output formats lives in `platform/share.ts` and is checked separately, since a single generic
   * probe cannot speak to every resolved output MIME type a run might produce.
   */
  fileShare: boolean
}

// Prefix only — each probe appends a random suffix. A fixed name let two overlapping probes
// destroy each other: each one deletes the file in its `finally`, so the slower probe's handle
// pointed at a file the faster one had already removed. WebKit surfaces that as
// `NotFoundError: The object can not be found here.` from `createWritable()`, and probeOpfs()
// below reports no OPFS at all — a browser that fully supports it falls back to in-memory
// storage for the whole session. Reproduced consistently on WebKit by probing while the app's
// own startup probe was still in flight; Chromium and Firefox tolerated the same overlap.
const OPFS_PROBE_PREFIX = '.icompress-capability-probe'

// A minimal valid 1x1 transparent PNG, used only as a non-empty, real image/png payload for the
// fileShare functional probe below — canShare looks at File.type and size, not pixel validity
// (confirmed in practice by T39-A, verification/t39a-web-share/results.json).
const PROBE_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

function probeFileShare(): boolean {
  if (typeof navigator === 'undefined' || !('canShare' in navigator)) {
    return false
  }

  try {
    const file = new File([PROBE_PNG_BYTES], 'probe.png', { type: 'image/png' })
    return navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

// A functional probe, not a presence check: `navigator.storage.getDirectory` can exist and still
// throw on call (observed on WebKit's ephemeral Playwright context; the same failure mode private
// browsing produces — see docs/assumptions.md B3 and docs/task-notes/T01.md).
async function probeOpfs(): Promise<boolean> {
  if (!('storage' in navigator) || typeof navigator.storage.getDirectory !== 'function') {
    return false
  }

  // Unique per call, so concurrent probes cannot delete each other's file.
  const name = `${OPFS_PROBE_PREFIX}-${Math.random().toString(36).slice(2, 10)}`

  try {
    const root = await navigator.storage.getDirectory()
    try {
      const handle = await root.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array([0]))
      await writable.close()
      return true
    } finally {
      await root.removeEntry(name).catch(() => {})
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
    fileShare: probeFileShare(),
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
