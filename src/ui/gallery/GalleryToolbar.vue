<script setup lang="ts">
// The Gallery toolbar row (Functional Design §3.2, "Populated state"): Add images, Add folder,
// Clear. Mounted independently of Gallery.vue itself, into StageContainer's `toolbar` slot
// (ToolPage.vue), because `<component :is="stageComponent">` only fills the default slot
// (docs/task-notes/T33-A.md, decision 4). Shares no instance state with Gallery.vue — every
// action here goes straight through ingest.ts's plain exported functions, which act on the global
// store and module-scope services, not on anything owned by a particular component instance.
//
// Deliberately no grid/list view toggle: R-G7/R-G8 are T34's job, added into this same component
// once list mode exists.
import { t } from '@/i18n/t'
import { addViaFilePicker, addViaFolderPicker, clearGallery } from './ingest'
import { useCapabilities } from './useCapabilities'

const { folderPicker } = useCapabilities()
</script>

<template>
  <div class="gallery-toolbar">
    <button type="button" class="toolbar-button" @click="addViaFilePicker">
      {{ t('gallery.toolbar.addImages') }}
    </button>
    <button v-if="folderPicker" type="button" class="toolbar-button" @click="addViaFolderPicker">
      {{ t('gallery.toolbar.addFolder') }}
    </button>
    <button type="button" class="toolbar-button clear-button" @click="clearGallery">
      {{ t('gallery.toolbar.clear') }}
    </button>
  </div>
</template>

<style scoped>
.gallery-toolbar {
  display: flex;
  gap: 8px;
}

.toolbar-button {
  min-block-size: 36px;
  padding-block: 7px;
  padding-inline: 12px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.clear-button {
  background: transparent;
  color: var(--color-text-muted);
}
</style>
