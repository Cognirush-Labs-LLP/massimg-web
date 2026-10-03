import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import type {
  EditOp,
  EditRecord,
  FailureReason,
  ImageId,
  ImageRecord,
  SizeTargetSkipReason,
} from '@/domain/types'
import { useUiStore } from './ui'

/**
 * Strips Vue reactivity from a stored edit before it re-enters this reactive array. An `edit`
 * patch is commonly built by reading another field off this same store (T36-A's
 * `Preview.vue#useDimensionSuggestion`, T37's `useEditDraftStore#apply`) — a plain `ref`/`reactive`
 * read returns a Proxy for any object value, and that Proxy is not structured-clonable. Left
 * unsanitized, it poisons every later `Job` built from this image: the pipeline worker's
 * `postMessage` throws `DataCloneError` the moment a re-encode is attempted, which is silent here
 * and only surfaces as a stuck "Creating preview..." in Preview (see docs/task-notes/T37.md,
 * Surprises). `toRaw` only strips the proxy on the value passed to it, not on values nested
 * inside it, hence the walk over `ops` and each crop op's `rect`/`background`.
 */
function sanitizedEdit(edit: EditRecord | null | undefined): EditRecord | null {
  if (edit === null || edit === undefined) {
    return null
  }

  const raw = toRaw(edit)

  return { ...raw, ops: raw.ops.map((op) => sanitizedOp(toRaw(op))) }
}

function sanitizedOp(op: EditOp): EditOp {
  return op.kind === 'crop' ? { ...op, rect: toRaw(op.rect), background: toRaw(op.background) } : op
}

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
    const wasEmpty = images.value.length === 0
    images.value.push(...records)
    const uiStore = useUiStore()
    uiStore.applyAutomaticGalleryView(wasEmpty, images.value)
    uiStore.onBatchCountChanged(images.value.length, images.value)
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

    Object.assign(target, 'edit' in patch ? { ...patch, edit: sanitizedEdit(patch.edit) } : patch)
  }

  function clearRunStatuses(): void {
    images.value = images.value.map((image) => ({
      ...image,
      status: 'ready',
      failure: null,
      skipReason: null,
    }))
  }

  function markFailed(id: ImageId, failure: FailureReason): void {
    const index = images.value.findIndex((image) => image.id === id)
    const image = images.value[index]
    if (image === undefined) return
    images.value[index] = { ...image, status: 'failed', failure, skipReason: null }
  }

  function markSkipped(id: ImageId, skipReason: SizeTargetSkipReason): void {
    const index = images.value.findIndex((image) => image.id === id)
    const image = images.value[index]
    if (image === undefined) return
    images.value[index] = { ...image, status: 'skipped', failure: null, skipReason }
  }

  // R-G6: no confirmation, since re-selecting files is cheap. Routed through the same
  // count-boundary transition addImages/removeImage already use, rather than a bespoke
  // "go to empty state" call, so there is exactly one place that decides what a count of zero
  // means for stage mode.
  function clearAll(): void {
    images.value = []
    useUiStore().onBatchCountChanged(0, [])
  }

  return {
    images,
    addImages,
    removeImage,
    updateImage,
    clearRunStatuses,
    markFailed,
    markSkipped,
    clearAll,
  }
})
