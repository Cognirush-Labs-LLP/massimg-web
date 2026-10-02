// Selection ingest: the layer nothing before T33-A built (docs/task-notes/T33-A.md). Turns a
// picked/dropped `File` into a real `ImageRecord` in `useBatchStore` — classification, binary
// storage, and enqueueing the background dimension probe. Deliberately a set of plain exported
// functions rather than a Vue composable: `useBatchStore()`/`useUiStore()` are callable from any
// module once Pinia is installed, not only from a component's `setup()`, which is what lets both
// the empty state and the toolbar (two independently mounted components, see Gallery.vue and
// GalleryToolbar.vue) call the exact same ingestion path with no shared instance state.
//
// Rejections are deliberately out of scope here. `classify()`'s `unhandled`/`not-image` results
// and a folder/drop's cap-breach result are silently dropped — no entry is added, nothing is
// reported. Functional Design R-I2's rejection list belongs to T39, which T32's own handover note
// already earmarked to add a rejection-entries field to `useBatchStore`, not a new mechanism here.
import { reactive, watch } from 'vue'
import { classify } from '@/domain/classify'
import type { ImageId, ImageRecord } from '@/domain/types'
import { createDimensionProbeService } from '@/platform/dimension-probe'
import type { DimensionProbeService } from '@/platform/dimension-probe'
import { pickFolder, readDroppedFolder } from '@/platform/folder'
import type { FolderSelection } from '@/platform/folder'
import { pickFiles } from '@/platform/picker'
import type { SelectedFile } from '@/platform/picker'
import { clearSourceFiles, deleteSourceFile, setSourceFile } from '@/platform/source-files'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'
import { getThumbnailService } from './thumbnail-service'

// Images the dimension probe could not decode. Kept outside `ImageRecord` on purpose — T09's
// type is a settled contract used by fixtures/tests across every earlier phase, and "the probe
// failed" is a cosmetic, retry-agnostic condition, not a processing failure (`ImageRecord.status`/
// `failure` mean something else: T38's actual encode failing). A plain reactive `Set` mirrors how
// `platform/thumbnails.ts` already reports readiness through a callback rather than the store.
// T33-B/T34's tile/row components read this to show "error" in place of `W×H`; `width`/`height`
// staying `0` is what they read to show the pending `_×_` state.
export const dimensionErrors = reactive(new Set<ImageId>())

function mintImageId(): ImageId {
  return crypto.randomUUID() as ImageId
}

let probeService: DimensionProbeService | null = null

// Lazy: created (and its stageMode watcher installed) on first real use, which is guaranteed to
// be after Pinia is active — never at module-evaluation time, which could race app setup.
function getDimensionProbeService(): DimensionProbeService {
  if (probeService) {
    return probeService
  }

  const service = createDimensionProbeService({
    onResolved: (id, size) => {
      dimensionErrors.delete(id)
      useBatchStore().updateImage(id, { width: size.width, height: size.height })
    },
    onFailed: (id) => {
      dimensionErrors.add(id)
    },
  })
  probeService = service

  // Compression owns the CPU from here (per the user: "killed instantly as we start
  // compressing"); a cancelled run returning to Gallery should pick up where probing left off,
  // not leave every unresolved image stuck at `_×_` forever.
  const uiStore = useUiStore()
  watch(
    () => uiStore.stageMode,
    (mode, previous) => {
      if (mode === 'processing') {
        service.stop()
      } else if (previous === 'processing') {
        service.resume()
      }
    },
  )

  return service
}

async function buildImageRecord(item: SelectedFile): Promise<ImageRecord | null> {
  // classify() needs the complete file, not a header slice — a GIF's second-frame marker can sit
  // arbitrarily far into the file (domain/classify.ts's own doc comment).
  const bytes = new Uint8Array(await item.file.arrayBuffer())
  const classification = classify(bytes)
  if (classification.class !== 'supported') {
    return null
  }

  return {
    id: mintImageId(),
    name: item.file.name,
    relativePath: item.relativePath,
    sizeBytes: item.file.size,
    // Not yet known (T33-A's dimension-probe design decision) — 0 is the pending sentinel a
    // tile/row renders as `_×_` until updateImage() patches in the real value, or `dimensionErrors`
    // gains this id and it renders `error` instead.
    width: 0,
    height: 0,
    sourceFormat: classification.format,
    isAnimated: classification.isAnimated,
    frameCount: null,
    hasTransparency: null,
    edit: null,
    status: 'ready',
    failure: null,
    skipReason: null,
  }
}

// Batched rather than one addImages() call per file, to avoid 500 individual store mutations —
// but never reordered, so R-G5's insertion/traversal order holds across a flush boundary.
const FLUSH_CHUNK_SIZE = 25

export async function ingestSelectedFiles(selected: readonly SelectedFile[]): Promise<void> {
  if (selected.length === 0) {
    return
  }

  const service = getDimensionProbeService()
  const batchStore = useBatchStore()
  // Captured once, before any chunk lands: `addImages()` re-derives R-G8's grid/list choice from
  // *its own* "was the store empty before this call" each time it's invoked, which is correct for
  // genuinely separate additions but wrong here — FLUSH_CHUNK_SIZE splits one selection into
  // several `addImages()` calls purely to avoid hundreds of individual store mutations, and only
  // the first of those chunks would ever see the store empty. Without this, a single 200-image
  // folder selection is evaluated against its first 25-image chunk, always lands under the
  // threshold, and never gets the automatic switch to list view that a batch this size needs.
  const wasEmptyAtStart = batchStore.images.length === 0
  let pending: ImageRecord[] = []

  for (const item of selected) {
    const record = await buildImageRecord(item)
    if (!record) {
      // Unhandled or not-image (R-I2's second/third class): skipped, the rest of the selection
      // still proceeds (R-I3).
      continue
    }

    setSourceFile(record.id, item.file)
    service.enqueue(record.id, item.file)
    pending.push(record)

    if (pending.length >= FLUSH_CHUNK_SIZE) {
      batchStore.addImages(pending)
      pending = []
    }
  }

  if (pending.length > 0) {
    batchStore.addImages(pending)
  }

  // Re-apply R-G8 against the selection's true final size now that every chunk has landed —
  // overriding whatever the first chunk's own (too-small) call already decided. A no-op if the
  // user toggled the view mode by hand while this was still running (applyAutomaticGalleryView's
  // own `galleryViewOverridden` guard), same as any other call to it.
  if (wasEmptyAtStart) {
    useUiStore().applyAutomaticGalleryView(true, batchStore.images)
  }
}

function ingestFolderSelection(selection: FolderSelection): Promise<void> {
  if (!selection.ok) {
    // Depth/file-count breach: no files are added, matching R-I30's "before any file is added" —
    // reporting the breach to the user is R-I30/T39's job, not built here (decision 6).
    return Promise.resolve()
  }
  return ingestSelectedFiles(selection.files)
}

/** Wired to the "Select images"/"Add images" buttons. */
export async function addViaFilePicker(): Promise<void> {
  const selected = await pickFiles()
  await ingestSelectedFiles(selected)
}

/** Wired to the "Select folder"/"Add folder" buttons (hidden per R-I31 when unavailable). */
export async function addViaFolderPicker(): Promise<void> {
  await ingestFolderSelection(await pickFolder())
}

/**
 * Wired to the stage's drop handler. `readDroppedFolder` (not `readDroppedFiles`) is used for
 * every drop, not only ones that turn out to contain a folder: its per-item `webkitGetAsEntry()`
 * walk already handles a top-level file exactly like a one-entry traversal, so it is a strict
 * superset that also covers a drop mixing loose files and folders together — the per-item
 * file-vs-directory dispatch T18's handover note left for "a future task" is satisfied by always
 * taking this path for real (OS-level) drops, rather than by writing that dispatch again here.
 */
export async function ingestDrop(dataTransfer: DataTransfer): Promise<void> {
  await ingestFolderSelection(await readDroppedFolder(dataTransfer))
}

/** Wired to the "Clear" toolbar action (R-G6). */
export function clearGallery(): void {
  probeService?.clear()
  dimensionErrors.clear()
  clearSourceFiles()
  // Releases every retained thumbnail Blob and revokes its object URL (R-G3) — the batch itself
  // is gone, so unlike removeIngestedImage below there is no cache worth keeping.
  getThumbnailService().clear()
  useBatchStore().clearAll()
}

/**
 * Wired to each tile/row's "remove" control (T33-B/T34): the invalidate-probe/release-file/
 * release-thumbnail/remove-from-store sequence lives in one place rather than being re-derived
 * per view. Removing one image releases only its own thumbnail cache entry, leaving every other
 * image's cached thumbnail and in-flight generation untouched (R-G2).
 */
export function removeIngestedImage(id: ImageId): void {
  probeService?.cancel(id)
  dimensionErrors.delete(id)
  deleteSourceFile(id)
  getThumbnailService().invalidate(id)
  useBatchStore().removeImage(id)
}
