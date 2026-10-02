// Moving through the batch from Preview (R-P7, R-K2).
//
// Shared by the toolbar's stepper buttons and the arrow-key handler so the two cannot disagree about
// what "next" means, and written as plain exported functions rather than a composable for the same
// reason `ui/gallery/ingest.ts` is: both callers are independently mounted components, and the state
// they act on lives in stores rather than in either instance.

import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'

/** R-P7: the stepper wraps at both ends. Pure, so the wrap is a test rather than an assumption. */
export function wrappedIndex(index: number, total: number, delta: number): number {
  if (total <= 0) {
    return 0
  }

  return (((index + delta) % total) + total) % total
}

/**
 * Steps the Preview to another image. Stepping releases the outgoing image's working set and encodes
 * the incoming one, which is `usePreviewEncode`'s reaction to `currentImageId` changing rather than
 * anything this function does, and the comparison tab is deliberately left alone (R-P7).
 */
export function stepPreview(delta: number): void {
  const images = useBatchStore().images

  if (images.length < 2) {
    return
  }

  const uiStore = useUiStore()
  const index = images.findIndex((image) => image.id === uiStore.currentImageId)

  if (index === -1) {
    return
  }

  const target = images[wrappedIndex(index, images.length, delta)]

  if (target !== undefined) {
    uiStore.openPreview(target.id)
  }
}
