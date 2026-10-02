<script setup lang="ts">
// The side panel's Quality section (Functional Design §4.1, docs/ui-design.md §8, T35). A
// Quality/Size segmented target toggle, writing straight to `useSettingsStore().quality`
// (Technical Design §3.2) — every control here writes the store directly, nothing is buffered
// locally except the Size field's own display state (see below).
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { sizeTargetDisabledReason } from '@/domain/format'
import { BYTES_PER_UNIT } from '@/domain/sizes'
import { useSettingsStore } from '@/stores/settings'

type SizeUnit = 'KB' | 'MB'

const QUALITY_CHIPS = [
  { key: 'panel.quality.chipLow', value: 40, testId: 'quality-chip-low' },
  { key: 'panel.quality.chipMed', value: 70, testId: 'quality-chip-med' },
  { key: 'panel.quality.chipHigh', value: 90, testId: 'quality-chip-high' },
] as const

// Shares `domain/sizes.ts`'s BYTES_PER_UNIT so the target-size parser and the
// display formatter can never drift out of sync.
const BYTES_PER_KB = BYTES_PER_UNIT
const BYTES_PER_MB = BYTES_PER_UNIT ** 2
// No design document states a default Size-target value; 500 KB is chosen as the
// least-surprising starting point (docs/task-notes/T35.md, Decisions made).
const DEFAULT_SIZE_VALUE = 500
const DEFAULT_SIZE_UNIT: SizeUnit = 'KB'

const settings = useSettingsStore()
const { quality, format } = storeToRefs(settings)

// The store only ever holds `targetBytes` (Technical Design §3.2's ResolvedSettings shape), which
// can't be split back into a unique value+unit pair (500000 bytes is both "500 KB" and "0.5 MB").
// These two refs are the field's own display state, independent of the store, so toggling KB/MB
// back and forth never drifts the displayed number through repeated byte<->unit conversions.
const sizeValue = ref(
  quality.value.kind === 'size' ? quality.value.targetBytes / BYTES_PER_KB : DEFAULT_SIZE_VALUE,
)
const sizeUnit = ref<SizeUnit>(DEFAULT_SIZE_UNIT)

function bytesFor(value: number, unit: SizeUnit): number {
  return Math.round(value * (unit === 'KB' ? BYTES_PER_KB : BYTES_PER_MB))
}

// R-Q4's disabling mechanism: only meaningful for a concrete format, since "Don't change" has no
// single format to check per batch — never disabled in that case.
const sizeDisabled = computed(
  () => format.value !== 'dont-change' && sizeTargetDisabledReason(format.value) !== null,
)

function selectQualityTarget(): void {
  if (quality.value.kind === 'quality') {
    return
  }
  // No document specifies what the slider should show when returning from Size; 70 matches
  // useSettingsStore's own initial default (docs/task-notes/T32.md).
  settings.quality = { kind: 'quality', value: 70 }
}

function selectSizeTarget(): void {
  if (quality.value.kind === 'size' || sizeDisabled.value) {
    return
  }
  settings.quality = { kind: 'size', targetBytes: bytesFor(sizeValue.value, sizeUnit.value) }
}

function onSliderInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  settings.quality = { kind: 'quality', value }
}

function setQualityChip(value: number): void {
  settings.quality = { kind: 'quality', value }
}

function onSizeFieldInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const sanitized = target.value.replace(/[^\d.]/g, '')
  target.value = sanitized
  const value = sanitized === '' ? 0 : Number(sanitized)
  sizeValue.value = value
  settings.quality = { kind: 'size', targetBytes: bytesFor(value, sizeUnit.value) }
}

function setUnit(unit: SizeUnit): void {
  sizeUnit.value = unit
  settings.quality = { kind: 'size', targetBytes: bytesFor(sizeValue.value, unit) }
}
</script>

<template>
  <div class="quality-section">
    <div
      class="target-toggle"
      role="group"
      :aria-label="t('panel.quality.targetGroupLabel')"
      data-testid="quality-target-toggle"
    >
      <button
        type="button"
        class="target-toggle-button"
        :class="{ active: quality.kind === 'quality' }"
        :aria-pressed="quality.kind === 'quality'"
        data-testid="quality-target-quality"
        @click="selectQualityTarget"
      >
        {{ t('panel.quality.targetQuality') }}
      </button>
      <button
        type="button"
        class="target-toggle-button"
        :class="{ active: quality.kind === 'size' }"
        :aria-pressed="quality.kind === 'size'"
        :disabled="sizeDisabled"
        data-testid="quality-target-size"
        @click="selectSizeTarget"
      >
        {{ t('panel.quality.targetSize') }}
      </button>
    </div>

    <div v-if="quality.kind === 'quality'" class="quality-controls">
      <div class="quality-readout" data-testid="quality-readout">{{ quality.value }}</div>
      <input
        type="range"
        min="10"
        max="100"
        :value="quality.value"
        :aria-label="t('panel.quality.sliderLabel')"
        class="quality-slider"
        data-testid="quality-slider"
        @input="onSliderInput"
      />
      <div class="chip-row">
        <button
          v-for="chip in QUALITY_CHIPS"
          :key="chip.testId"
          type="button"
          class="chip"
          :class="{ active: quality.value === chip.value }"
          :data-testid="chip.testId"
          @click="setQualityChip(chip.value)"
        >
          {{ t(chip.key) }}
        </button>
      </div>
    </div>

    <div v-else class="size-controls">
      <input
        type="text"
        inputmode="decimal"
        :value="sizeValue"
        :aria-label="t('panel.quality.sizeFieldLabel')"
        class="size-field"
        data-testid="quality-size-field"
        @input="onSizeFieldInput"
      />
      <div
        class="unit-toggle"
        role="group"
        :aria-label="t('panel.quality.unitGroupLabel')"
        data-testid="quality-unit-toggle"
      >
        <button
          type="button"
          class="unit-toggle-button"
          :class="{ active: sizeUnit === 'KB' }"
          :aria-pressed="sizeUnit === 'KB'"
          data-testid="quality-unit-kb"
          @click="setUnit('KB')"
        >
          KB
        </button>
        <button
          type="button"
          class="unit-toggle-button"
          :class="{ active: sizeUnit === 'MB' }"
          :aria-pressed="sizeUnit === 'MB'"
          data-testid="quality-unit-mb"
          @click="setUnit('MB')"
        >
          MB
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quality-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.target-toggle,
.unit-toggle {
  display: flex;
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.target-toggle-button,
.unit-toggle-button {
  flex: 1;
  min-block-size: 36px;
  padding-block: 8px;
  padding-inline: 10px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 13px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.target-toggle-button.active,
.unit-toggle-button.active {
  background: var(--color-tint);
  color: var(--color-primary);
}

.target-toggle-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quality-controls,
.size-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.quality-readout {
  font-family: var(--font-family-mono);
  font-variant-numeric: tabular-nums;
  font-size: 28px;
  font-weight: 700;
}

.quality-slider {
  inline-size: 100%;
}

.chip-row {
  display: flex;
  gap: 8px;
}

.chip {
  flex: none;
  padding-block: 6px;
  padding-inline: 11px;
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

.size-controls {
  flex-direction: row;
  align-items: stretch;
}

.size-field {
  flex: 1;
  min-block-size: 36px;
  padding-inline: 10px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-family: var(--font-family-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.unit-toggle {
  flex: none;
}
</style>
