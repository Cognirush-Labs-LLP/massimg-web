<script setup lang="ts">
// Gallery stage mode (Technical Design §2: "src/ui/, one directory per stage mode").
//
// T33-A builds the empty state and the selection/drop plumbing (see ingest.ts). T33-B adds the
// populated header row and the virtualized grid body; T34 adds the list body alongside it
// (docs/ui-design.md §6, "Populated header row (Gallery, both view modes)" - the title/meta/
// affordance line live here, above the grid/list branch, rather than inside either body
// component, so both view modes reuse it unchanged). The v-if/v-else between GalleryGrid and
// GalleryList fully unmounts the false branch before mounting the true one, which is what makes
// GalleryGrid's own onUnmounted -> getThumbnailService().stop() fire on a grid-to-list switch with
// no extra wiring here (R-G12).
// Drop handling lives at this level rather than inside GalleryEmptyState.vue so it keeps working
// once the batch is populated, not only in the empty state (Functional Design §3.2 describes it
// for the empty state; extending it to the populated state is a T33-A decision - the underlying
// action is identical to the toolbar's own Add images/Add folder, just triggered a different way).
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { formatUiSize } from '@/domain/sizes'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'
import GalleryEmptyState from './GalleryEmptyState.vue'
import GalleryGrid from './GalleryGrid.vue'
import GalleryList from './GalleryList.vue'
import { ingestDrop } from './ingest'

const { images } = storeToRefs(useBatchStore())
const { galleryView } = storeToRefs(useUiStore())

const metaText = computed(() =>
  t('gallery.meta', {
    count: images.value.length,
    size: formatUiSize(images.value.reduce((total, image) => total + image.sizeBytes, 0)),
  }),
)

function onDrop(event: DragEvent): void {
  event.preventDefault()
  const dataTransfer = event.dataTransfer
  if (dataTransfer) {
    void ingestDrop(dataTransfer)
  }
}

function onDragOver(event: DragEvent): void {
  // Required for the element to become a valid drop target at all.
  event.preventDefault()
}
</script>

<template>
  <div class="gallery" data-testid="gallery-root" @dragover="onDragOver" @drop="onDrop">
    <GalleryEmptyState v-if="images.length === 0" />
    <div v-else class="gallery-populated">
      <div class="gallery-header">
        <div class="title-row">
          <h2 class="title">{{ t('gallery.title') }}</h2>
          <span class="divider" aria-hidden="true">·</span>
          <p class="meta">{{ metaText }}</p>
        </div>
        <p class="affordance">{{ t('gallery.affordance') }}</p>
      </div>
      <GalleryGrid v-if="galleryView === 'grid'" />
      <GalleryList v-else />
    </div>
  </div>
</template>

<style scoped>
.gallery {
  block-size: 100%;
}

.gallery-populated {
  display: flex;
  block-size: 100%;
  flex-direction: column;
  gap: 14px;
}

.title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.title {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 15px;
  font-weight: var(--font-weight-heading);
  letter-spacing: 0.02em;
}

.divider {
  color: var(--color-text-muted-quiet);
  font-size: 12px;
}

.meta {
  margin: 0;
  color: var(--color-text-muted-quiet);
  font-family: var(--font-family-mono);
  font-size: 12px;
}

.affordance {
  margin: 0;
  color: var(--color-text-muted-quiet);
  font-size: 12.5px;
}
</style>
