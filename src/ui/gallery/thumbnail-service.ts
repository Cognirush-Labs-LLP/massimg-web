// Lazily-created singleton wrapping platform/thumbnails.ts's ThumbnailService (T33-B, Technical
// Design §1.1's stated exception: "the bounded, batch-scoped thumbnail Blob cache... completed
// entries may survive mode changes"). GalleryGrid.vue's own component instance is destroyed every
// time the user leaves Gallery grid mode — a tile click opens Preview, Clear empties the batch
// back to the empty state, and so on, per the exclusive stage-mode mounting in Gallery.vue/
// ToolPage.vue. If the ThumbnailService lived inside that component, every such trip would throw
// the cache away and every return to Gallery would reread every source file it had already
// decoded. Keeping it here at module scope, created once and reused across remounts, mirrors
// ingest.ts's `probeService` singleton for the identical reason.
import { ref } from 'vue'
import { createThumbnailService } from '@/platform/thumbnails'
import type { ThumbnailService } from '@/platform/thumbnails'

/**
 * Bumped whenever a thumbnail lands in the cache. The cache itself is a plain, non-reactive Map
 * (Technical Design §1.1), so this is the seam GalleryGrid/GalleryTile read alongside
 * `service.urlFor(id)` to know when to re-render — see docs/task-notes/T20.md, "onReady is the
 * re-render signal".
 */
export const thumbnailTick = ref(0)

let service: ThumbnailService | null = null

export function getThumbnailService(): ThumbnailService {
  if (!service) {
    service = createThumbnailService({
      onReady: () => {
        thumbnailTick.value += 1
      },
    })
  }
  return service
}
