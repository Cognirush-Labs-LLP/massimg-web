<script setup lang="ts">
// The Gallery empty state (Functional Design §3.2): dashed drop zone covering the stage, headline,
// accepted-formats line, and the two Select buttons. Drag-and-drop itself is handled by the parent
// (Gallery.vue attaches the listeners on the stage so drop works in the populated state too, not
// only here) — this component owns only the two buttons, both calling straight into ingest.ts
// (docs/task-notes/T33-A.md, decision 2: no shared instance state needed for that to work).
import { t } from '@/i18n/t'
import { addViaFilePicker, addViaFolderPicker } from './ingest'
import { useCapabilities } from './useCapabilities'

const { folderPicker } = useCapabilities()
</script>

<template>
  <div class="empty-state" data-testid="gallery-empty-state">
    <p class="headline">{{ t('gallery.emptyState.headline') }}</p>
    <p class="formats">{{ t('gallery.emptyState.formats') }}</p>
    <div class="actions">
      <button type="button" class="select-images" @click="addViaFilePicker">
        {{ t('gallery.emptyState.selectImages') }}
      </button>
      <button v-if="folderPicker" type="button" class="select-folder" @click="addViaFolderPicker">
        {{ t('gallery.emptyState.selectFolder') }}
      </button>
    </div>
    <!-- R-V1/R-V3. Two complete sentences in two elements, never one sentence assembled from two
         translated fragments (R-L5), and neither is a link: a third link inside the drop zone
         would compete with the drop target and the two calls to action, and the footer on the
         same screen already links the Privacy page. -->
    <div class="privacy">
      <p>{{ t('gallery.emptyState.privacy') }}</p>
      <p>{{ t('gallery.emptyState.privacyAnalytics') }}</p>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-block-size: 320px;
  block-size: 100%;
  padding-block: 40px;
  padding-inline: 24px;
  text-align: center;
  background: var(--color-surface-tile);
  border: 1.5px dashed var(--color-border-control);
  border-radius: var(--radius-lg);
}

.headline {
  margin: 0;
  max-inline-size: 16ch;
  font-size: clamp(22px, 4vw, 34px);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -1px;
}

.formats {
  margin: 0;
  font-family: var(--font-family-mono);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--color-text-muted-quiet);
}

.privacy {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-inline-size: 48ch;
}

.privacy p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  text-wrap: balance;
  color: var(--color-text-muted-quiet);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-block-start: 4px;
}

.select-images,
.select-folder {
  min-block-size: 44px;
  padding-block: 12px;
  padding-inline: 22px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: var(--font-weight-wordmark);
  cursor: pointer;
}

.select-images {
  background: var(--color-tint);
  border: none;
  color: var(--color-primary);
}

.select-folder {
  background: transparent;
  border: 1px solid var(--color-border-control);
  color: var(--color-primary);
}
</style>
