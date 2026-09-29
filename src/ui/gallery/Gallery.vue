<script setup lang="ts">
// Gallery stage mode (Technical Design §2: "src/ui/, one directory per stage mode").
//
// T33-A builds the empty state and the selection/drop plumbing (see ingest.ts); the populated
// state still shows the T31 placeholder here until T33-B replaces this branch with the real
// virtualized grid (docs/task-notes/T33-A.md). Drop handling lives at this level rather than
// inside GalleryEmptyState.vue so it keeps working once the batch is populated, not only in the
// empty state (Functional Design §3.2 describes it for the empty state; extending it to the
// populated state is a T33-A decision — the underlying action is identical to the toolbar's own
// Add images/Add folder, just triggered a different way).
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import GalleryEmptyState from './GalleryEmptyState.vue'
import { ingestDrop } from './ingest'

const { images } = storeToRefs(useBatchStore())

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
    <p v-else data-testid="gallery-placeholder">{{ t('shell.modeNotYetBuilt') }}</p>
  </div>
</template>

<style scoped>
.gallery {
  block-size: 100%;
}
</style>
