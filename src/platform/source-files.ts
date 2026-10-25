// The batch retains database copy IDs; active consumers load a source File only when needed.
// Direct, caller-owned Files also stay outside the reactive graph.
//
// Accepted sources use independent copies: an Android photo-picker File can become unreadable
// after a successful read, even when the underlying photo has not changed.

import type { ImageId } from '@/domain/types'
import { deleteSourceCopies, readSourceCopy, writeSourceCopy } from './source-copies'

const files = new Map<ImageId, File>()
const copies = new Map<ImageId, string>()
const pending = new Map<ImageId, string>()
const writes = new Map<string, Promise<File>>()

function releaseCopies(ids: readonly string[]): void {
  void deleteSourceCopies(ids).catch((error: unknown) => {
    console.error('Could not release temporary source copies', error)
  })
}

export function setSourceFile(id: ImageId, file: File): void {
  deleteSourceFile(id)
  files.set(id, file)
}

export async function preserveSourceFile(
  id: ImageId,
  source: File,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<File | undefined> {
  const copyId = crypto.randomUUID()
  pending.set(id, copyId)
  const writing = writeSourceCopy(copyId, source, bytes)
  writes.set(copyId, writing)
  try {
    const copy = await writing
    if (pending.get(id) !== copyId) {
      await deleteSourceCopies([copyId])
      return undefined
    }
    const previous = copies.get(id)
    if (previous) releaseCopies([previous])
    copies.set(id, copyId)
    files.delete(id)
    return copy
  } catch (error) {
    await deleteSourceCopies([copyId]).catch(() => {})
    throw error
  } finally {
    writes.delete(copyId)
    if (pending.get(id) === copyId) pending.delete(id)
  }
}

export async function getSourceFile(id: ImageId): Promise<File | undefined> {
  const direct = files.get(id)
  if (direct) return direct
  const copyId = copies.get(id)
  if (!copyId) return undefined
  const copy = await readSourceCopy(copyId)
  return copies.get(id) === copyId ? copy : undefined
}

export function hasSourceFile(id: ImageId): boolean {
  return files.has(id) || copies.has(id)
}

export function deleteSourceFile(id: ImageId): void {
  files.delete(id)
  pending.delete(id)
  const copyId = copies.get(id)
  if (copyId) {
    copies.delete(id)
    releaseCopies([copyId])
  }
}

export function clearSourceFiles(): void {
  files.clear()
  releaseCopies([...copies.values(), ...pending.values()])
  copies.clear()
  pending.clear()
}

export function prepareSourceFileCleanup(
  ids: readonly ImageId[] = [...new Set([...files.keys(), ...copies.keys(), ...pending.keys()])],
): () => Promise<void> {
  const captured = ids.map((id) => ({
    id,
    copyId: copies.get(id),
    pendingId: pending.get(id),
    file: files.get(id),
  }))
  const copyIds = captured.flatMap(({ copyId, pendingId }) =>
    [copyId, pendingId].filter((id): id is string => id !== undefined),
  )
  const draining = copyIds.flatMap((id) => (writes.has(id) ? [writes.get(id)!] : []))
  return async () => {
    // A selection can still be copying its next chunk when Processing starts. Include those
    // unpublished sources and let their writes settle before issuing the deletion transaction.
    await Promise.allSettled(draining)
    // One transaction removes the captured rows atomically. Keep the live locators on failure
    // and never remove a replacement installed while storage deletion was awaiting completion.
    await deleteSourceCopies(copyIds)
    for (const { id, copyId, pendingId, file } of captured) {
      const current = copies.get(id)
      if (current && (current === copyId || current === pendingId)) copies.delete(id)
      if (file && files.get(id) === file) files.delete(id)
    }
  }
}
