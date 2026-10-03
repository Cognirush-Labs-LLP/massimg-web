<script setup lang="ts">
// The comparison pill (Functional Design §3.3, R-P4, R-P5, R-K6, R-K8; docs/ui-design.md §11):
//
//   500 KB   [ Original | Compressed ]   250 KB   50% ↓
//
// One switch, not two buttons: "clicking anywhere on it flips between Original and Compressed, so
// the user can flick back and forth without aiming at a specific half". The halves are therefore
// plain text inside the control, and the active one is marked by its own background rather than by
// colour alone (R-K8) — via ToggleSwitch.vue, shared with GalleryToolbar.vue's grid/list switch.
//
// It renders nothing at all while an encode is in flight: R-P4 wants the figures hidden rather than
// showing numbers that describe settings the user has already changed.
import { computed } from 'vue'
import { t } from '@/i18n/t'
import ToggleSwitch from '@/app/shell/ToggleSwitch.vue'
import { useBreakpoint } from '@/app/shell/useBreakpoint'
import { describeSizeComparison, formatUiSize } from '@/domain/sizes'
import type { ComparisonTab } from './usePreviewViewport'

const props = defineProps<{
  tab: ComparisonTab
  originalBytes: number
  /** `null` while no measured result exists — the pill is hidden in that state. */
  compressedBytes: number | null
}>()

const emit = defineEmits<{ toggle: [] }>()

// Below the side-panel breakpoint the figures drop to one fraction digit (e.g. "74.5 KB" instead
// of "74.53 KB") so two sizes, the toggle and the change figure keep fitting beside each other in
// the narrow toolbar.
const { isDesktop } = useBreakpoint()
const sizeFractionDigits = computed(() => (isDesktop.value ? 2 : 1))
const formatSize = (bytes: number): string =>
  formatUiSize(bytes, undefined, sizeFractionDigits.value)

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
      {{ formatSize(originalBytes) }}
    </span>

    <ToggleSwitch
      variant="pill"
      :checked="tab === 'compressed'"
      :label="t('preview.comparison.toggleLabel')"
      data-testid="preview-comparison-toggle"
      @toggle="emit('toggle')"
    >
      <template #first>{{ t('preview.comparison.original') }}</template>
      <template #second>{{ t('preview.comparison.compressed') }}</template>
    </ToggleSwitch>

    <span class="size compressed-size" data-testid="preview-compressed-size">
      {{ formatSize(compressedBytes) }}
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

/* Matches ToolbarButton.vue's own `@media (max-width: 899.98px)` (SIDE_PANEL_BREAKPOINT_PX) —
   the figures shrink a notch to match `sizeFractionDigits` dropping to one digit above, so the
   pill stays compact in the narrow toolbar without the Original/Compressed switch itself changing
   size. */
@media (max-width: 899.98px) {
  .comparison {
    gap: 8px;
  }

  .size,
  .change {
    font-size: 11px;
  }
}
</style>
