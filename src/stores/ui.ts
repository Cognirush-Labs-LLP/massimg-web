import { defineStore } from 'pinia'
import { ref } from 'vue'
import { resolveAutomaticGalleryView } from '@/config/limits'
import type { ImageId, ImageRecord } from '@/domain/types'

// The four stage modes (Functional Design §3.1, docs/ui-design.md §3). Exactly one is mounted
// at a time by ToolPage.vue, via `<component :is>` — never a `v-if` toggle inside one persistent
// tree — so leaving a mode unmounts its component instance (Technical Design §1.1, R-M4).
// Moved here from the T31-temporary `useStageMode.ts`, which this store fully replaces.
export type StageMode = 'gallery' | 'preview' | 'edit' | 'processing'

/**
 * Interaction/navigation state that isn't part of the batch or its settings (Technical Design
 * §3.4, docs/ui-design.md §4): stage mode, the active image in Preview/Edit, gallery view mode,
 * mobile drawer open state, and the Preview comparison tab.
 *
 * Two kinds of transition live here (docs/ui-design.md §4's cross-store rule):
 * - Explicit actions (`openPreview`, `openEdit`, ...) that UI components (T33–T38) call directly
 *   in response to a click or button press.
 * - Automatic count-boundary logic (`onBatchCountChanged`, `retargetAfterRemoval`) that
 *   `useBatchStore` calls from its own `addImages`/`removeImage` actions, since "batch count
 *   crossing the 1-image boundary drives mode transitions... this logic belongs in the store...
 *   not duplicated in each component that can change the count."
 */
export const useUiStore = defineStore('ui', () => {
  const stageMode = ref<StageMode>('gallery')
  const currentImageId = ref<ImageId | null>(null)
  const galleryView = ref<'grid' | 'list'>('grid')
  // R-G8: once the user has toggled the view themselves, automatic selection stops touching
  // `galleryView` for the rest of the session — set only by setGalleryView, never by
  // applyAutomaticGalleryView, so the automatic path can never silently undo a manual choice.
  const galleryViewOverridden = ref(false)
  const drawerOpen = ref(false)
  // R-P2 default: Preview opens on the Compressed tab.
  const comparisonTab = ref<'original' | 'compressed'>('compressed')

  function openPreview(id: ImageId): void {
    currentImageId.value = id
    stageMode.value = 'preview'
  }

  function openEdit(id: ImageId): void {
    currentImageId.value = id
    stageMode.value = 'edit'
  }

  // Apply, Cancel or Remove edit all return to Preview of the same image (docs/ui-design.md §3's
  // transition table) — currentImageId is already the image being edited, so it's left untouched.
  function closeEdit(): void {
    stageMode.value = 'preview'
  }

  function backToGallery(): void {
    stageMode.value = 'gallery'
    currentImageId.value = null
  }

  function enterProcessing(): void {
    stageMode.value = 'processing'
    // The mobile Options drawer has no reason to stay open once Processing replaces the panel
    // with run status (docs/ui-design.md §2, §13) — folded into this action rather than left as
    // a component-level watch, so every entry point into Processing gets it for free.
    drawerOpen.value = false
  }

  function cancelProcessing(): void {
    stageMode.value = 'gallery'
  }

  // "Back to images", after a finished run.
  function finishProcessing(): void {
    stageMode.value = 'gallery'
  }

  function openDrawer(): void {
    drawerOpen.value = true
  }

  function closeDrawer(): void {
    drawerOpen.value = false
  }

  function setGalleryView(mode: 'grid' | 'list'): void {
    galleryView.value = mode
    galleryViewOverridden.value = true
  }

  /**
   * R-G8: called by `useBatchStore.addImages` right after a mutation, with whether the batch was
   * empty beforehand and the batch as it now stands. "Selects the initial mode automatically" is
   * read as the empty-to-populated transition only — a batch that grows past the threshold via
   * repeated small adds is not silently flipped to list mid-session — and is skipped entirely once
   * the user has manually toggled the view this session (see docs/task-notes/T34.md for both
   * decisions).
   */
  function applyAutomaticGalleryView(wasEmpty: boolean, images: ImageRecord[]): void {
    if (!wasEmpty || galleryViewOverridden.value) {
      return
    }

    const folderSourced = images.some((image) => image.relativePath !== null)
    galleryView.value = resolveAutomaticGalleryView(images.length, folderSourced)
  }

  function setComparisonTab(tab: 'original' | 'compressed'): void {
    comparisonTab.value = tab
  }

  /**
   * R-M1/R-M2: called by `useBatchStore` after `addImages` changes the batch size. Reaching
   * exactly one image shows Preview for it regardless of route, unless Edit or Processing is
   * already active (neither is reachable with an empty or single-image batch in practice, but
   * the guard keeps this function correct if that ever changes). Growing past one while Preview
   * is open returns to Gallery rather than leaving the previewed image on screen.
   */
  function onBatchCountChanged(count: number, images: ImageRecord[]): void {
    if (stageMode.value === 'edit' || stageMode.value === 'processing') {
      return
    }

    if (count === 0) {
      stageMode.value = 'gallery'
      currentImageId.value = null
      return
    }

    if (count === 1) {
      currentImageId.value = images[0]?.id ?? null
      stageMode.value = 'preview'
      return
    }

    if (stageMode.value === 'preview') {
      stageMode.value = 'gallery'
      currentImageId.value = null
    }
  }

  /**
   * Called by `useBatchStore.removeImage` with the id just removed and the batch as it stands
   * after removal. Only acts when the removed image was the one on screen — removing a
   * background image never changes the current mode or index (docs/ui-design.md §3's transition
   * table: "Preview | Current image removed | Gallery, or Preview of the remaining image if
   * count becomes 1").
   */
  function retargetAfterRemoval(removedId: ImageId, remaining: ImageRecord[]): void {
    if (currentImageId.value !== removedId) {
      return
    }

    if (remaining.length === 0) {
      stageMode.value = 'gallery'
      currentImageId.value = null
      return
    }

    if (remaining.length === 1) {
      currentImageId.value = remaining[0]?.id ?? null
      stageMode.value = 'preview'
      return
    }

    stageMode.value = 'gallery'
    currentImageId.value = null
  }

  return {
    stageMode,
    currentImageId,
    galleryView,
    galleryViewOverridden,
    drawerOpen,
    comparisonTab,
    openPreview,
    openEdit,
    closeEdit,
    backToGallery,
    enterProcessing,
    cancelProcessing,
    finishProcessing,
    openDrawer,
    closeDrawer,
    setGalleryView,
    applyAutomaticGalleryView,
    setComparisonTab,
    onBatchCountChanged,
    retargetAfterRemoval,
  }
})
