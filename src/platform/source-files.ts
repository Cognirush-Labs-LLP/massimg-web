// Batch-scoped storage for each image's source `File` (Technical Design §1.1: binary data never
// enters a reactive Pinia store). `stores/batch.ts` holds the metadata (`ImageRecord`); this
// module-scope, non-reactive `Map` is where the bytes actually live, keyed by the same `ImageId`.
//
// New in T33-A: nothing before this task constructed an `ImageRecord` from a real `File`, so
// nothing needed anywhere to keep the `File` itself. T36 (Preview) and T38 (Processing) read from
// here to get the bytes to encode — this is their seam into the batch's source data.

import type { ImageId } from '@/domain/types'

const files = new Map<ImageId, File>()

export function setSourceFile(id: ImageId, file: File): void {
  files.set(id, file)
}

export function getSourceFile(id: ImageId): File | undefined {
  return files.get(id)
}

export function hasSourceFile(id: ImageId): boolean {
  return files.has(id)
}

export function deleteSourceFile(id: ImageId): void {
  files.delete(id)
}

export function clearSourceFiles(): void {
  files.clear()
}
