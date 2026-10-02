<script setup lang="ts">
// The comparison pill (Functional Design §3.3, R-P4, R-P5, R-K6, R-K8; docs/ui-design.md §11):
//
//   500 KB   [ Original | Compressed ]   250 KB   50% ↓
//
// One switch, not two buttons: "clicking anywhere on it flips between Original and Compressed, so
// the user can flick back and forth without aiming at a specific half". The halves are therefore
// plain text inside the control, and the active one is marked by its own background rather than by
// colour alone (R-K8) — the same segmented pattern GalleryToolbar.vue established.
//
// It renders nothing at all while an encode is in flight: R-P4 wants the figures hidden rather than
// showing numbers that describe settings the user has already changed.
import { computed } from 'vue'
import { t } from '@/i18n/t'
import { describeSizeComparison, formatUiSize } from '@/domain/sizes'
import type { ComparisonTab } from './usePreviewViewport'

const props = defineProps<{
  tab: ComparisonTab
  originalBytes: number
  /** `null` while no measured result exists — the pill is hidden in that state. */
  compressedBytes: number | null
}>()

const emit = defineEmits<{ toggle: [] }>()

const comparison = computed(() =>
  props.compressedBytes === null
    ? null
    : describeSizeComparison(props.originalBytes, props.compressedBytes),
)

const changeText = computed(() => {
  const change = comparison.value

  if (change === null) {
    return ''
  }

  if (change.direction === 'unchanged') {
    return t('preview.comparison.unchanged')
  }

  if (change.direction === 'increase') {
    return change.belowOnePercent
      ? t('preview.comparison.increaseUnderOne')
      : t('preview.comparison.increase', { percent: change.percent })
  }

  return change.belowOnePercent
    ? t('preview.comparison.reductionUnderOne')
    : t('preview.comparison.reduction', { percent: change.percent })
})
</script>

<template>
  <div v-if="compressedBytes !== null" class="comparison" data-testid="preview-comparison">
    <span class="size original-size" data-testid="preview-original-size">
      {{ formatUiSize(originalBytes) }}
    </span>

    <button
      type="button"
      class="pill"
      role="switch"
      :aria-checked="tab === 'compressed'"
      :aria-label="t('preview.comparison.toggleLabel')"
      data-testid="preview-comparison-toggle"
      @click="emit('toggle')"
    >
      <span class="half" :class="{ active: tab === 'original' }">
        {{ t('preview.comparison.original') }}
      </span>
      <span class="half" :class="{ active: tab === 'compressed' }">
        {{ t('preview.comparison.compressed') }}
      </span>
    </button>

    <span class="size compressed-size" data-testid="preview-compressed-size">
      {{ formatUiSize(compressedBytes) }}
    </span>

    <span
      class="change"
      :class="comparison?.direction"
      data-testid="preview-size-change"
      :data-direction="comparison?.direction"
    >
      {{ changeText }}
    </span>
  </div>
</template>

<style scoped>
.comparison {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.size {
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.compressed-size {
  color: var(--color-primary);
}

.pill {
  display: flex;
  gap: 3px;
  padding: 3px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.half {
  min-block-size: 30px;
  display: flex;
  align-items: center;
  padding-block: 6px;
  padding-inline: 12px;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
}

.half.active {
  background: var(--color-primary);
  color: var(--color-surface-control);
}

.change {
  font-family: var(--font-family-mono);
  font-size: 12px;
  font-weight: var(--font-weight-wordmark);
  font-variant-numeric: tabular-nums;
}

/* §14.1 reserves tint for the reduction figure. An increase is legitimate (R-P5) and is not an
   error, so it stays in ordinary text colour — with the up glyph carrying the direction as well,
   since colour never carries information alone (R-K8). */
.change.reduction {
  color: var(--color-tint);
}

.change.increase,
.change.unchanged {
  color: var(--color-primary);
}
</style>
