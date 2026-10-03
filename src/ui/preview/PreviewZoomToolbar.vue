<script setup lang="ts">
// The Preview inspector's zoom controls — Fit, Actual size, and a live percent readout — rendered
// beside the Original/Compressed pill rather than over the image itself (an overlay was tried and
// looked bad). Purely presentational: `PreviewFrame.vue` owns the viewport state and the
// pixel-perfect/rest-state arithmetic (`domain/viewport.ts`); `Preview.vue` reads that frame's
// exposed state and passes it down here, the same division PreviewComparisonPill already uses for
// its own row.
import { t } from '@/i18n/t'

defineProps<{
  percent: number
  fitDisabled: boolean
  actualSizeDisabled: boolean
}>()

const emit = defineEmits<{ fit: []; actualSize: [] }>()
</script>

<template>
  <div class="zoom-toolbar" data-testid="preview-zoom-toolbar">
    <button
      type="button"
      class="zoom-toolbar-button"
      :disabled="fitDisabled"
      data-testid="preview-zoom-fit"
      @click="emit('fit')"
    >
      {{ t('preview.frame.zoomFit') }}
    </button>
    <button
      type="button"
      class="zoom-toolbar-button"
      :disabled="actualSizeDisabled"
      data-testid="preview-zoom-actual-size"
      @click="emit('actualSize')"
    >
      {{ t('preview.frame.zoomActualSize') }}
    </button>
    <span class="zoom-toolbar-readout" data-testid="preview-zoom-readout">
      {{ t('preview.frame.zoomPercent', { percent }) }}
    </span>
  </div>
</template>

<style scoped>
.zoom-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
}

.zoom-toolbar-button {
  min-block-size: 30px;
  padding-block: 5px;
  padding-inline: 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.zoom-toolbar-button:disabled {
  color: var(--color-text-muted-quiet);
  cursor: not-allowed;
}

.zoom-toolbar-readout {
  min-inline-size: 36px;
  padding-inline: 4px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
</style>
