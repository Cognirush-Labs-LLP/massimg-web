<script setup lang="ts">
// The Gallery toolbar row (Functional Design §3.2, "Populated state"): Add images, Add folder,
// Clear. Mounted independently of Gallery.vue itself, into StageContainer's `toolbar` slot
// (ToolPage.vue), because `<component :is="stageComponent">` only fills the default slot
// (docs/task-notes/T33-A.md, decision 4). Shares no instance state with Gallery.vue — every
// action here goes straight through ingest.ts's plain exported functions, which act on the global
// store and module-scope services, not on anything owned by a particular component instance.
//
// The grid/list view toggle (R-G7/R-G8) lives here, between Add folder and Clear per
// docs/ui-design.md §6's stated toolbar order, wired straight to useUiStore. It's one switch, not
// two buttons — clicking anywhere on it flips the view — via ToggleSwitch.vue, shared with
// PreviewComparisonPill.vue's Original/Compressed switch.
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import ToolbarButton from '@/app/shell/ToolbarButton.vue'
import ToggleSwitch from '@/app/shell/ToggleSwitch.vue'
import { useUiStore } from '@/stores/ui'
import { addViaFilePicker, addViaFolderPicker, clearGallery } from './ingest'
import { useCapabilities } from './useCapabilities'

const { folderPicker } = useCapabilities()
const uiStore = useUiStore()
const { galleryView } = storeToRefs(uiStore)
</script>

<template>
  <div class="gallery-toolbar">
    <ToolbarButton @click="addViaFilePicker">
      <template #icon>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M8 2.5v11M2.5 8h11"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </template>
      {{ t('gallery.toolbar.addImages') }}
    </ToolbarButton>
    <ToolbarButton v-if="folderPicker" @click="addViaFolderPicker">
      <template #icon>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M1.5 3.5a1 1 0 0 1 1-1h3.4l1.1 1.3h6.5a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <path
            d="M8 6.8v4M6 8.8h4"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </template>
      {{ t('gallery.toolbar.addFolder') }}
    </ToolbarButton>
    <ToggleSwitch
      variant="icons"
      class="view-toggle"
      :checked="galleryView === 'list'"
      :label="t('gallery.toolbar.viewToggleLabel')"
      data-testid="gallery-view-toggle"
      @toggle="uiStore.setGalleryView(galleryView === 'grid' ? 'list' : 'grid')"
    >
      <template #first>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
        </svg>
      </template>
      <template #second>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="1" y="2" width="14" height="2.5" rx="1" fill="currentColor" />
          <rect x="1" y="6.75" width="14" height="2.5" rx="1" fill="currentColor" />
          <rect x="1" y="11.5" width="14" height="2.5" rx="1" fill="currentColor" />
        </svg>
      </template>
    </ToggleSwitch>
    <ToolbarButton quiet @click="clearGallery">
      <template #icon>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.5 7.5v4M9.5 7.5v4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M3.5 4.5h9l-.6 8.4a1 1 0 0 1-1 .9h-5.8a1 1 0 0 1-1-.9l-.6-8.4Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      </template>
      {{ t('gallery.toolbar.clear') }}
    </ToolbarButton>
  </div>
</template>

<style scoped>
.gallery-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.view-toggle {
  margin-inline-start: auto;
}

/* Matches StageContainer.vue's own `@media (max-width: 899.98px)` (SIDE_PANEL_BREAKPOINT_PX),
   also used by ToolbarButton.vue's icon-hiding rule — tightens this row's own gap to match the
   buttons' own tighter mobile padding, so four items (Add Images, Add Folder, the view toggle,
   Clear) keep fitting on one line down through narrow phones instead of wrapping Clear alone. */
@media (max-width: 899.98px) {
  .gallery-toolbar {
    gap: 6px;
  }
}
</style>
