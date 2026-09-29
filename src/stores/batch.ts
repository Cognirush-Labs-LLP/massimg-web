import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ImageId, ImageRecord } from '@/domain/types'
import { useUiStore } from './ui'

/**
 * The current batch's per-image metadata (Technical Design §3.1). Binary data — the source
 * `File`, thumbnail `Blob`s — never lives here; it stays in module-scope, non-reactive `Map`s
 * elsewhere (Technical Design §1.1), keyed by the same `ImageId` used here.
 *
 * Selection-time rejection entries are described in docs/ui-design.md §4 as living on this
 * store too, but no `RejectionEntry` type exists yet anywhere in the codebase — that shape is
 * T39's call to make against Functional Design §10, not this task's to guess. Not added here;
 * see docs/task-notes/T32.md.
 */
export const useBatchStore = defineStore('batch', () => {
  // Insertion order is the array order (R-G5) — appended to, never re-sorted. Folder input
  // inserts in traversal order, which is simply the order `addImages` is called in.
  const images = ref<ImageRecord[]>([])

  function addImages(records: ImageRecord[]): void {
    images.value.push(...records)
    useUiStore().onBatchCountChanged(images.value.length, images.value)
  }

  function removeImage(id: ImageId): void {
    const index = images.value.findIndex((image) => image.id === id)

    if (index === -1) {
      return
    }

    // Splice only the targeted entry — every other record's `edit` and other fields are
    // untouched object references (R-G2).
    images.value.splice(index, 1)
    useUiStore().retargetAfterRemoval(id, images.value)
  }

  function updateImage(id: ImageId, patch: Partial<ImageRecord>): void {
    const target = images.value.find((image) => image.id === id)

    if (target === undefined) {
      return
    }

    Object.assign(target, patch)
  }

  // R-G6: no confirmation, since re-selecting files is cheap. Routed through the same
  // count-boundary transition addImages/removeImage already use, rather than a bespoke
  // "go to empty state" call, so there is exactly one place that decides what a count of zero
  // means for stage mode.
  function clearAll(): void {
    images.value = []
    useUiStore().onBatchCountChanged(0, [])
  }

  return { images, addImages, removeImage, updateImage, clearAll }
})
