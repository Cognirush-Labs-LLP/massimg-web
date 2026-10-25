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
  try {
    const copy = await writeSourceCopy(copyId, source, bytes)
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
