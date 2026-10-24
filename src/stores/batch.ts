import { defineStore } from 'pinia'
import { ref, toRaw } from 'vue'
import type { RejectionEntry } from '@/domain/rejection'
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
 * Selection-time rejection entries (T39, Functional Design §10, R-E2) also live here, per T32's
 * handover note — one list, replaced wholesale by each selection action (`setRejections`), not
 * accumulated across them.
 */
export const useBatchStore = defineStore('batch', () => {
  // Insertion order is the array order (R-G5) — appended to, never re-sorted. Folder input
  // inserts in traversal order, which is simply the order `addImages` is called in.
  const images = ref<ImageRecord[]>([])
  const rejections = ref<RejectionEntry[]>([])

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

  // Each rebuilder below spreads `toRaw(image)`, never the element read off `images.value`: that
  // element is a reactive Proxy, and spreading it reads every field through the Proxy's `get` trap,
  // so the new record's `edit` would be a nested Proxy that `toRaw` at the job-building sites
  // cannot reach — the same `DataCloneError` `sanitizedEdit` above exists to prevent, surfacing on
  // the second Compress of an edited image.
  function clearRunStatuses(): void {
    images.value = images.value.map((image) => ({
      ...toRaw(image),
      status: 'ready',
      failure: null,
      skipReason: null,
    }))
  }

  function markFailed(id: ImageId, failure: FailureReason): void {
    const index = images.value.findIndex((image) => image.id === id)
    const image = images.value[index]
    if (image === undefined) return
    images.value[index] = { ...toRaw(image), status: 'failed', failure, skipReason: null }
  }

  function markSkipped(id: ImageId, skipReason: SizeTargetSkipReason): void {
    const index = images.value.findIndex((image) => image.id === id)
    const image = images.value[index]
    if (image === undefined) return
    images.value[index] = { ...toRaw(image), status: 'skipped', failure: null, skipReason }
  }

  // R-G6: no confirmation, since re-selecting files is cheap. Routed through the same
  // count-boundary transition addImages/removeImage already use, rather than a bespoke
  // "go to empty state" call, so there is exactly one place that decides what a count of zero
  // means for stage mode.
  function clearAll(): void {
    images.value = []
    rejections.value = []
    useUiStore().onBatchCountChanged(0, [])
  }

  // Replaces the whole list — one selection action's rejections, not an accumulating log (T39
  // decision: matches R-E2's "shown once per selection action" literally).
  function setRejections(entries: RejectionEntry[]): void {
    rejections.value = entries
  }

  function dismissRejections(): void {
    rejections.value = []
  }

  return {
    images,
    rejections,
    addImages,
    removeImage,
    updateImage,
    clearRunStatuses,
    markFailed,
    markSkipped,
    clearAll,
    setRejections,
    dismissRejections,
  }
})
