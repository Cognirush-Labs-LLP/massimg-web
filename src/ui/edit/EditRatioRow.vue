<script setup lang="ts">
// Edit mode's ratio row (Functional Design R-C1-R-C12; docs/ui-design.md §12): Free · 1:1 · 4:5 ·
// 16:9 · 9:16, above the frame. Chip-row pattern copied from SidePanelQuality.vue's quality chips.
import { storeToRefs } from 'pinia'
import { RATIO_IDS, type RatioId } from '@/domain/edit'
import { t, type MessageKey } from '@/i18n/t'
import { useEditDraftStore } from '@/stores/edit-draft'

const RATIO_LABELS: Record<RatioId, MessageKey> = {
  free: 'edit.ratio.free',
  '1:1': 'edit.ratio.square',
  '4:5': 'edit.ratio.portrait45',
  '16:9': 'edit.ratio.landscape169',
  '9:16': 'edit.ratio.portrait916',
}

const draft = useEditDraftStore()
const { ratioId } = storeToRefs(draft)
</script>

<template>
  <div
    class="ratio-row"
    role="group"
    :aria-label="t('edit.ratio.groupLabel')"
    data-testid="edit-ratio-row"
  >
    <button
      v-for="id in RATIO_IDS"
      :key="id"
      type="button"
      class="chip"
      :class="{ active: ratioId === id }"
      :aria-pressed="ratioId === id"
      :data-testid="`edit-ratio-${id}`"
      @click="draft.setRatio(id)"
    >
      {{ t(RATIO_LABELS[id]) }}
    </button>
  </div>
</template>

<style scoped>
.ratio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  flex: none;
  min-block-size: 32px;
  padding-block: 6px;
  padding-inline: 12px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.chip.active {
  background: var(--color-surface-tile);
  border-color: var(--color-tint);
  color: var(--color-primary);
}
</style>
