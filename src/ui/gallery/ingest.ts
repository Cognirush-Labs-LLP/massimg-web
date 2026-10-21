// Selection ingest: the layer nothing before T33-A built (docs/task-notes/T33-A.md). Turns a
// picked/dropped `File` into a real `ImageRecord` in `useBatchStore` — classification, binary
// storage, and enqueueing the background dimension probe. Deliberately a set of plain exported
// functions rather than a Vue composable: `useBatchStore()`/`useUiStore()` are callable from any
// module once Pinia is installed, not only from a component's `setup()`, which is what lets both
// the empty state and the toolbar (two independently mounted components, see Gallery.vue and
// GalleryToolbar.vue) call the exact same ingestion path with no shared instance state.
//
// Selection-time rejections (T39, Functional Design R-I2/R-I3/§10): `classify()`'s `unhandled`
// results, a HEIC file when the decoder capability is unavailable, an oversized file, a batch-count
// overflow, and a folder/drop's cap-breach or empty-after-filtering result all become a
// `RejectionEntry` on `useBatchStore` instead of being silently dropped. `not-image` results remain
// silent (R-I2's third class — ordinary non-images are never listed).
import { reactive, watch } from 'vue'
import { classify } from '@/domain/classify'
import { findCapBreach, readImageHeader } from '@/domain/image-header'
import type { RejectionEntry } from '@/domain/rejection'
import type { ImageId, ImageRecord } from '@/domain/types'
import { resolveCodecLimits, runtimeLimits } from '@/config/limits'
import { getCapabilities } from '@/platform/capability'
import type { Capabilities } from '@/platform/capability'
import { detectMobile } from '@/platform/device'
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

// Enough for any supported format's signature (and an SVG's tag) to be recognised.
const PREFIX_BYTES = 64 * 1024

function mintImageId(): ImageId {
  return crypto.randomUUID() as ImageId
}

function mintRejectionId(): string {
  return crypto.randomUUID()
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

type IngestOutcome =
  | { kind: 'image'; record: ImageRecord }
  | { kind: 'rejected'; entry: RejectionEntry }
  | { kind: 'ignored' }

function rejectionEntry(item: SelectedFile, reason: RejectionEntry['reason']): RejectionEntry {
  return { id: mintRejectionId(), name: item.file.name, relativePath: item.relativePath, reason }
}

// `capabilities` is a parameter, not a direct `getCapabilities()` call, so the HEIC-decoder-
// unavailable path (classify.ts/backlog.md BL-009: unreachable with the current WASM build, no
// real browser can produce it) stays unit-testable by injecting `heicDecode: false` directly.
async function buildIngestOutcome(
  item: SelectedFile,
  capabilities: Capabilities,
): Promise<IngestOutcome> {
  // classify() needs the complete file, not a header slice — a GIF's second-frame marker can sit
  // arbitrarily far into the file (domain/classify.ts's own doc comment). A file over the size cap
  // is rejected whatever its animation, so only enough of it is read to name what it is: the rest
  // of a multi-gigabyte file must never be pulled into memory just to be turned away.
  const source =
    item.file.size > runtimeLimits.maximumFileBytes ? item.file.slice(0, PREFIX_BYTES) : item.file
  const bytes = new Uint8Array(await source.arrayBuffer())
  const classification = classify(bytes)

  if (classification.class === 'not-image') {
    // R-I2's third class: ordinary non-images are skipped silently, never listed.
    return { kind: 'ignored' }
  }

  if (classification.class === 'unhandled') {
    return {
      kind: 'rejected',
      entry: rejectionEntry(item, { kind: 'unhandled', reason: classification.reason }),
    }
  }

  if (
    (classification.format === 'heic' || classification.format === 'heif') &&
    !capabilities.heicDecode
  ) {
    return { kind: 'rejected', entry: rejectionEntry(item, { kind: 'heic-decoder-unavailable' }) }
  }

  if (item.file.size > runtimeLimits.maximumFileBytes) {
    return {
      kind: 'rejected',
      entry: rejectionEntry(item, {
        kind: 'file-too-large',
        actualBytes: item.file.size,
        capBytes: runtimeLimits.maximumFileBytes,
      }),
    }
  }

  // The header decides before anything decodes. A format it cannot read, or a header it cannot
  // parse, is not a reason to refuse the file: it goes on, and ImageMagick's resource limits fail
  // it as a single image if it turns out to be too large (Technical Design §8.3).
  const header = readImageHeader(bytes, classification.format)
  const breach = header && findCapBreach(header, resolveCodecLimits(detectMobile()))

  if (breach) {
    return { kind: 'rejected', entry: rejectionEntry(item, breach) }
  }

  return {
    kind: 'image',
    record: {
      id: mintImageId(),
      name: item.file.name,
      relativePath: item.relativePath,
      sizeBytes: item.file.size,
      // 0 is the pending sentinel a tile/row renders as `_×_` until the background probe patches
      // in the real value, or `dimensionErrors` gains this id and it renders `error` instead. It
      // is only used for what the header reader could not size.
      width: header?.width ?? 0,
      height: header?.height ?? 0,
      sourceFormat: classification.format,
      isAnimated: classification.isAnimated,
      frameCount: header && classification.isAnimated ? header.frames : null,
      hasTransparency: null,
      edit: null,
      status: 'ready',
      failure: null,
      skipReason: null,
    },
  }
}

// Batched rather than one addImages() call per file, to avoid 500 individual store mutations —
// but never reordered, so R-G5's insertion/traversal order holds across a flush boundary.
const FLUSH_CHUNK_SIZE = 25

export interface IngestSummary {
  addedCount: number
  rejections: RejectionEntry[]
}

/**
 * Ingests a flat file list. Returns a summary rather than calling `useBatchStore().setRejections`
 * itself — each public entry point below (picker / folder / drop) owns exactly one `setRejections`
 * call, which is what makes "one selection action replaces the previous rejection list" (T39
 * decision, Functional Design R-E2's "once per selection action") a property of the call site
 * rather than something this shared helper has to guess at for every caller.
 */
export async function ingestSelectedFiles(
  selected: readonly SelectedFile[],
): Promise<IngestSummary> {
  if (selected.length === 0) {
    return { addedCount: 0, rejections: [] }
  }

  const service = getDimensionProbeService()
  const batchStore = useBatchStore()
  const capabilities = await getCapabilities()
  // Captured once, before any chunk lands or any image is accepted: `addImages()` re-derives
  // R-G8's grid/list choice from *its own* "was the store empty before this call" each time it's
  // invoked, which is correct for genuinely separate additions but wrong here — FLUSH_CHUNK_SIZE
  // splits one selection into several `addImages()` calls purely to avoid hundreds of individual
  // store mutations, and only the first of those chunks would ever see the store empty. Without
  // this, a single 200-image folder selection is evaluated against its first 25-image chunk,
  // always lands under the threshold, and never gets the automatic switch to list view that a
  // batch this size needs. The same snapshot also anchors the batch-count cap below, since
  // `batchStore.images.length` grows mid-loop as chunks flush.
  const startingCount = batchStore.images.length
  const wasEmptyAtStart = startingCount === 0
  let pending: ImageRecord[] = []
  const rejections: RejectionEntry[] = []
  let addedCount = 0
  // How many supported images this selection would have produced with no batch-count cap at all —
  // used only to state the true "actual" figure in the one summary rejection below (R-I20).
  let uncappedCount = 0
  let batchCapHit = false

  for (const item of selected) {
    const outcome = await buildIngestOutcome(item, capabilities)

    if (outcome.kind === 'ignored') {
      continue
    }

    if (outcome.kind === 'rejected') {
      rejections.push(outcome.entry)
      continue
    }

    uncappedCount += 1

    if (startingCount + addedCount >= runtimeLimits.maximumBatchFiles) {
      // Batch-count cap (§10 "Batch exceeds file count"): accept up to the cap and summarize the
      // remainder in one entry (R-E2) rather than rejecting the whole selection or naming every
      // overflow file individually.
      batchCapHit = true
      continue
    }

    setSourceFile(outcome.record.id, item.file)
    if (outcome.record.width === 0) {
      service.enqueue(outcome.record.id, item.file)
    }
    pending.push(outcome.record)
    addedCount += 1

    if (pending.length >= FLUSH_CHUNK_SIZE) {
      batchStore.addImages(pending)
      pending = []
    }
  }

  if (pending.length > 0) {
    batchStore.addImages(pending)
  }

  if (batchCapHit) {
    rejections.push({
      id: mintRejectionId(),
      name: null,
      relativePath: null,
      reason: {
        kind: 'batch-count-exceeded',
        actual: startingCount + uncappedCount,
        cap: runtimeLimits.maximumBatchFiles,
      },
    })
  }

  // Re-apply R-G8 against the selection's true final size now that every chunk has landed —
  // overriding whatever the first chunk's own (too-small) call already decided. A no-op if the
  // user toggled the view mode by hand while this was still running (applyAutomaticGalleryView's
  // own `galleryViewOverridden` guard), same as any other call to it.
  if (wasEmptyAtStart) {
    useUiStore().applyAutomaticGalleryView(true, batchStore.images)
  }

  return { addedCount, rejections }
}

function folderCapBreachEntry(selection: Extract<FolderSelection, { ok: false }>): RejectionEntry {
  return {
    id: mintRejectionId(),
    name: null,
    relativePath: null,
    reason:
      selection.reason === 'depth-exceeded'
        ? { kind: 'folder-depth-exceeded', actual: selection.actual, cap: selection.cap }
        : { kind: 'folder-file-count-exceeded', actual: selection.actual, cap: selection.cap },
  }
}

async function ingestFolderSelection(selection: FolderSelection): Promise<void> {
  if (!selection.ok) {
    // Depth/file-count breach: no files are added, matching R-I30's "before any file is added".
    useBatchStore().setRejections([folderCapBreachEntry(selection)])
    return
  }

  const { addedCount, rejections } = await ingestSelectedFiles(selection.files)
  useBatchStore().setRejections(
    // R-I29: a folder yielding zero supported images is reported plainly — but only when nothing
    // else already explains why (no individual `unhandled` rejection fired either), so a folder
    // containing one named-unsupported file doesn't also get a redundant "no supported images"
    // entry on top of its own specific message.
    addedCount === 0 && rejections.length === 0
      ? [
          {
            id: mintRejectionId(),
            name: null,
            relativePath: null,
            reason: { kind: 'folder-empty' },
          },
        ]
      : rejections,
  )
}

/** Wired to the "Select images"/"Add images" buttons. */
export async function addViaFilePicker(): Promise<void> {
  const selected = await pickFiles()
  const { rejections } = await ingestSelectedFiles(selected)
  useBatchStore().setRejections(rejections)
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
