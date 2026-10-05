import { getCapabilities } from './capability'

// Origin-private storage for one run's output artifacts (Technical Design §9.1-9.2, Functional
// Design R-X38 to R-X42, R-X51, R-X52). T19 built this as a single named entry because OPFS had
// exactly one consumer then, the ZIP archive; T40 replaces that with a run-scoped artifact set —
// zero or one archive, zero to `maximumShareFiles` individual output copies, and the metadata
// needed to reconstruct their public names and MIME types — because a run now also needs to retain
// the R-X16 direct-download candidate and, for a Share-eligible run, every individual successful
// output alongside the archive. Only one run is ever active at a time, so this module holds exactly
// one such set, not a collection keyed by run id.
//
// Storage is one directory (`RUN_DIR`) containing an optional `archive` file and an `outputs/`
// subdirectory of index-named files, so the whole set can be deleted in one idempotent call rather
// than tracked and removed member by member.

export interface QuotaCheck {
  ok: boolean
  required: number
  available: number
}

/** R-X40/R-X52's two-threshold preflight, done in one call so both figures are measured together. */
export interface CombinedQuotaCheck {
  /** Whether the ordinary Download artifact (archive, or the single-image direct output) fits. */
  archive: QuotaCheck
  /** Whether the archive plus every predicted individual Share copy fits. */
  combined: QuotaCheck
}

export interface OutputCopyMeta {
  name: string
  mimeType: string
}

const RUN_DIR = 'icompress-run'
const ARCHIVE_NAME = 'archive'
const OUTPUTS_DIR = 'outputs'

// Share/Download only ever act within the same page session that produced the run, so this map
// need not survive a reload — cleanup-on-startup below removes the whole OPFS directory without
// needing it, regardless of whether this module has ever been loaded in the current session.
const outputMeta = new Map<number, OutputCopyMeta>()

interface FallbackState {
  archive: Blob | null
  outputs: Map<number, { bytes: Uint8Array; meta: OutputCopyMeta }>
}

// R-X41: private browsing has no OPFS at all (B3). The in-memory shape mirrors the real one so
// callers never branch on which backend is active.
let fallback: FallbackState = { archive: null, outputs: new Map() }

async function getRunDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(RUN_DIR, { create })
}

async function getOutputsDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const runDir = await getRunDirectory(create)
  return runDir.getDirectoryHandle(OUTPUTS_DIR, { create })
}

export async function writeArchive(source: ReadableStream<Uint8Array>): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const runDir = await getRunDirectory(true)
    const handle = await runDir.getFileHandle(ARCHIVE_NAME, { create: true })
    const writable = await handle.createWritable()
    await source.pipeTo(writable)
    return
  }

  const chunks: BlobPart[] = []
  const reader = source.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    chunks.push(new Uint8Array(value))
  }
  fallback.archive = new Blob(chunks)
}

export async function readArchive(): Promise<Blob> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const runDir = await getRunDirectory(false)
    const handle = await runDir.getFileHandle(ARCHIVE_NAME)
    return handle.getFile()
  }

  if (!fallback.archive) {
    throw new Error('readArchive() called before writeArchive()')
  }
  return fallback.archive
}

/**
 * Writes one successful output's individual copy (R-X38's direct-download candidate, and/or one of
 * R-X51's Share copies — the same physical file can serve both roles).
 *
 * `index` is an opaque sort key, not a meaning: this module only promises that `readOutputCopies`
 * returns copies in ascending `index` order. What that order *is* belongs to the caller —
 * `pipeline/run-archive.ts` uses the image's grid position for a Share-eligible run (so the
 * payload comes back in grid order, R-X49) and plain index 0 for the lone R-X16 candidate
 * otherwise.
 */
export async function writeOutputCopy(
  index: number,
  bytes: Uint8Array,
  meta: OutputCopyMeta,
): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const outputsDir = await getOutputsDirectory(true)
    const handle = await outputsDir.getFileHandle(String(index), { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array(bytes))
    await writable.close()
    outputMeta.set(index, meta)
    return
  }

  fallback.outputs.set(index, { bytes: new Uint8Array(bytes), meta })
}

/** Deletes one individual copy — used to release the R-X16 candidate once a 2nd success makes ZIP
 * delivery certain, for a run that isn't Share-eligible (§9.1). Idempotent. */
export async function deleteOutputCopy(index: number): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const outputsDir = await getOutputsDirectory(false).catch(() => null)
    await outputsDir?.removeEntry(String(index)).catch(() => {})
    outputMeta.delete(index)
    return
  }

  fallback.outputs.delete(index)
}

/**
 * Releases every individual copy while leaving the archive intact — R-X48's "removes the
 * individual share copies and leaves **Download** unchanged", for a run whose exact `canShare`
 * check or byte total ruled Share out after the copies had already been written.
 *
 * Deliberately not `deleteRunArtifacts()`: that would take the archive with it, which is the very
 * thing R-X48 says must survive. Caller's job to only use this where the archive is the Download
 * artifact — a run reduced to one success has no archive, and its lone copy *is* the R-X16
 * download (`pipeline/run-archive.ts`, §9.2's "one physical file may serve both roles").
 *
 * Reads the index set from whichever backend is live: `outputMeta` is only populated on the OPFS
 * path, so the private-browsing fallback (R-X41) has to be asked for its own keys or this would
 * silently do nothing there.
 */
export async function deleteAllOutputCopies(): Promise<void> {
  const { opfs } = await getCapabilities()
  const indices = opfs ? [...outputMeta.keys()] : [...fallback.outputs.keys()]

  for (const index of indices) {
    await deleteOutputCopy(index)
  }
}

/** Reads back every individual copy as a real `File`, in index order, for Share or direct Download. */
export async function readOutputCopies(): Promise<File[]> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const outputsDir = await getOutputsDirectory(false).catch(() => null)
    if (!outputsDir) {
      return []
    }

    const files: File[] = []
    for (const [index, meta] of [...outputMeta.entries()].sort(([a], [b]) => a - b)) {
      const handle = await outputsDir.getFileHandle(String(index))
      const blob = await handle.getFile()
      files.push(new File([blob], meta.name, { type: meta.mimeType }))
    }
    return files
  }

  return [...fallback.outputs.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, { bytes, meta }]) =>
        new File([new Uint8Array(bytes)], meta.name, { type: meta.mimeType }),
    )
}

/**
 * The one cleanup operation (R-X42): removes the archive, every individual copy and their
 * metadata, idempotently. Called after the first successful Download or Share, after
 * cancellation, after a storage failure, after leaving Processing, and once on application start.
 */
export async function deleteRunArtifacts(): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(RUN_DIR, { recursive: true }).catch(() => {})
  }

  outputMeta.clear()
  fallback = { archive: null, outputs: new Map() }
}

export async function estimateQuota(): Promise<{ usage: number; quota: number }> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

// R-X40. In fallback mode there is no OPFS quota to preflight against - the reduced batch cap that
// applies instead is a T46/T50-owned measured number, not something this module invents.
export async function checkQuota(requiredBytes: number): Promise<QuotaCheck> {
  const { opfs } = await getCapabilities()
  if (!opfs) {
    return { ok: true, required: requiredBytes, available: Infinity }
  }

  const { usage, quota } = await estimateQuota()
  const available = quota - usage
  return { ok: requiredBytes <= available, required: requiredBytes, available }
}

/**
 * R-X40/R-X52's two-threshold preflight: the ordinary Download artifact must fit on its own, and —
 * for a preliminarily Share-eligible run — the archive plus every individual copy must fit too.
 * The two results are kept separate so a caller can reject the batch when `archive` fails, or fall
 * back to Download-only when only `combined` fails.
 */
export async function checkCombinedQuota(
  archiveBytes: number,
  shareBytes: number,
): Promise<CombinedQuotaCheck> {
  const archive = await checkQuota(archiveBytes)
  const combined = await checkQuota(archiveBytes + shareBytes)
  return { archive, combined }
}
