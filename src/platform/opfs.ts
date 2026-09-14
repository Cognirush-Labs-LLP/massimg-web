import { getCapabilities } from './capability'

// Origin-private storage for the run's archive (Technical Design §9.1-9.2, Functional Design
// R-X38 to R-X42). Single-slot by design: OPFS has exactly one real use in this app, the ZIP
// archive assembled during a run, so this module stores one named entry rather than a general
// key/value store nothing else needs.

export interface QuotaCheck {
  ok: boolean
  required: number
  available: number
}

const ENTRY_NAME = 'icompress-archive'

let fallbackBlob: Blob | null = null

export async function writeArchive(source: ReadableStream<Uint8Array>): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(ENTRY_NAME, { create: true })
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
  fallbackBlob = new Blob(chunks)
}

export async function readArchive(): Promise<Blob> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(ENTRY_NAME)
    return handle.getFile()
  }

  if (!fallbackBlob) {
    throw new Error('readArchive() called before writeArchive()')
  }
  return fallbackBlob
}

export async function deleteArchive(): Promise<void> {
  const { opfs } = await getCapabilities()
  if (opfs) {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(ENTRY_NAME).catch(() => {})
    return
  }

  fallbackBlob = null
}

export async function estimateQuota(): Promise<{ usage: number; quota: number }> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

// R-X40. In fallback mode there is no OPFS quota to preflight against - the batch cap that applies
// instead is a T46-owned measured number, not something this module invents.
export async function checkQuota(requiredBytes: number): Promise<QuotaCheck> {
  const { opfs } = await getCapabilities()
  if (!opfs) {
    return { ok: true, required: requiredBytes, available: Infinity }
  }

  const { usage, quota } = await estimateQuota()
  const available = quota - usage
  return { ok: requiredBytes <= available, required: requiredBytes, available }
}
