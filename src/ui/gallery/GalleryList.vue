<script setup lang="ts">
// Gallery list body (Functional Design R-G7-R-G12; docs/ui-design.md §7). Deliberately owns no
// lifecycle hooks and imports nothing from thumbnail-service.ts or source-files.ts: list mode
// decodes nothing at all (R-G9), so there is no queue to start here and, on leaving, nothing to
// stop. Not virtualized, unlike GalleryGrid.vue — R-G10's virtualization requirement is scoped to
// grid mode only, and rows are cheap (text-only, no decode).
import { computed } from 'vue'
import { groupImagesByDirectory } from '@/domain/grouping'
import { useBatchStore } from '@/stores/batch'
import GalleryListRow from './GalleryListRow.vue'

const batchStore = useBatchStore()
const groups = computed(() => groupImagesByDirectory(batchStore.images))
</script>

<template>
  <div class="gallery-list" data-testid="gallery-list">
    <template v-for="group in groups" :key="group.directory ?? '__root__'">
      <h3
        v-if="group.directory !== null"
        class="group-header"
        data-testid="gallery-list-group-header"
      >
        {{ group.directory }}
      </h3>
      <GalleryListRow v-for="image in group.images" :key="image.id" :image="image" />
    </template>
  </div>
</template>

<style scoped>
.gallery-list {
  overflow-y: auto;
  flex: 1;
}

.group-header {
  margin: 0;
  padding-block: 6px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-weight: var(--font-weight-heading);
}
</style>
