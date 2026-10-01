<script setup lang="ts">
// The side panel's Dimension section (Functional Design §4.2, docs/ui-design.md §9, T35): an
// accordion of four mutually-exclusive radio rows writing to `useSettingsStore().dimension`
// (Technical Design §3.2), plus the R-D2/R-D3 crop-override notes computed from
// `useBatchStore().images`.
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { t, type MessageKey } from '@/i18n/t'
import { hasCropOp } from '@/domain/edit'
import type { ResolvedDimension } from '@/domain/types'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'

type DimensionKind = ResolvedDimension['kind']

interface DimensionChip {
  key: MessageKey
  value: number
}

interface DimensionRowConfig {
  kind: DimensionKind
  labelKey: MessageKey
  chips: DimensionChip[]
}

const ROWS: DimensionRowConfig[] = [
  { kind: 'original', labelKey: 'panel.dimension.rowOriginal', chips: [] },
  {
    kind: 'fit-long-edge',
    labelKey: 'panel.dimension.rowFitLongEdge',
    chips: [
      { key: 'panel.dimension.chipHd', value: 1280 },
      { key: 'panel.dimension.chipFhd', value: 1920 },
      { key: 'panel.dimension.chip2k', value: 2560 },
      { key: 'panel.dimension.chip4k', value: 3840 },
      { key: 'panel.dimension.chipIg', value: 1080 },
    ],
  },
  {
    kind: 'fixed-width',
    labelKey: 'panel.dimension.rowFixedWidth',
    chips: [
      { key: 'panel.dimension.chipIg', value: 1080 },
      { key: 'panel.dimension.chipWeb', value: 1200 },
      { key: 'panel.dimension.chipMail', value: 800 },
      { key: 'panel.dimension.chipPrint', value: 3000 },
    ],
  },
  {
    kind: 'fixed-height',
    labelKey: 'panel.dimension.rowFixedHeight',
    chips: [
      { key: 'panel.dimension.chipIg', value: 1350 },
      { key: 'panel.dimension.chipHd', value: 720 },
      { key: 'panel.dimension.chipFhd', value: 1080 },
    ],
  },
]

// No design document states a default pixel value for a row before a chip or a typed value picks
// one; these mirror the sample mockup's own initial field values (docs/task-notes/T35.md,
// Decisions made) and are written to the store the instant a row is selected, since every control
// here writes the store immediately rather than waiting for further input.
const DEFAULT_PIXELS: Record<DimensionKind, number> = {
  original: 0,
  'fit-long-edge': 1920,
  'fixed-width': 1080,
  'fixed-height': 1080,
}

const batchStore = useBatchStore()
const { images } = storeToRefs(batchStore)
const settings = useSettingsStore()
const { dimension } = storeToRefs(settings)

// Per-row display value, independent of which row is currently active/in the store, so switching
// between rows never loses what was typed into another (same reasoning as SidePanelQuality's
// size-field state).
const lastValues = ref<Record<DimensionKind, number>>({ ...DEFAULT_PIXELS })
if (dimension.value.kind !== 'original') {
  lastValues.value[dimension.value.kind] = dimension.value.pixels
}

const croppedCount = computed(
  () => images.value.filter((image) => hasCropOp(image.edit?.ops ?? [])).length,
)
// R-D3: the accordion disables only when the *entire* batch is that one cropped image.
const isSingleCropped = computed(() => images.value.length === 1 && croppedCount.value === 1)
// R-D2: more than one image, at least one cropped — a note, not a disable.
const showMultiNote = computed(() => images.value.length > 1 && croppedCount.value > 0)
const disabled = computed(() => isSingleCropped.value)

function selectRow(kind: DimensionKind): void {
  if (disabled.value) {
    return
  }
  settings.dimension =
    kind === 'original' ? { kind: 'original' } : { kind, pixels: lastValues.value[kind] }
}

function onFieldInput(kind: DimensionKind, event: Event): void {
  if (kind === 'original') {
    return
  }
  const target = event.target as HTMLInputElement
  const sanitized = target.value.replace(/[^\d]/g, '')
  target.value = sanitized
  const pixels = sanitized === '' ? 0 : Number(sanitized)
  lastValues.value[kind] = pixels
  if (dimension.value.kind === kind) {
    settings.dimension = { kind, pixels }
  }
}

function setChip(kind: DimensionKind, value: number): void {
  if (kind === 'original') {
    return
  }
  lastValues.value[kind] = value
  settings.dimension = { kind, pixels: value }
}
</script>

<template>
  <div class="dimension-section">
    <p v-if="isSingleCropped" class="dimension-note" data-testid="dimension-note-single">
      {{ t('panel.dimension.noteSingleCropped') }}
    </p>
    <p v-else-if="showMultiNote" class="dimension-note" data-testid="dimension-note-multi">
      {{ t('panel.dimension.noteMultiCropped', { count: croppedCount }) }}
    </p>

    <div
      class="dimension-accordion"
      role="radiogroup"
      :aria-label="t('panel.dimension.groupLabel')"
      data-testid="dimension-accordion"
    >
      <div
        v-for="row in ROWS"
        :key="row.kind"
        class="dimension-row"
        :class="{ expanded: dimension.kind === row.kind }"
      >
        <label class="dimension-row-head" :class="{ disabled }">
          <span class="dimension-dot" aria-hidden="true"></span>
          <input
            type="radio"
            name="dimension-row"
            class="dimension-radio"
            :checked="dimension.kind === row.kind"
            :disabled="disabled"
            :data-testid="`dimension-row-${row.kind}`"
            @change="selectRow(row.kind)"
          />
          <span>{{ t(row.labelKey) }}</span>
        </label>

        <div
          v-if="dimension.kind === row.kind && row.kind !== 'original'"
          class="dimension-row-body"
        >
          <input
            type="text"
            inputmode="numeric"
            class="dimension-field"
            :value="lastValues[row.kind]"
            :aria-label="t(row.labelKey)"
            :data-testid="`dimension-field-${row.kind}`"
            @input="onFieldInput(row.kind, $event)"
          />
          <div class="chip-row">
            <button
              v-for="chip in row.chips"
              :key="`${chip.key}-${chip.value}`"
              type="button"
              class="chip"
              :class="{ active: lastValues[row.kind] === chip.value }"
              :data-testid="`dimension-chip-${row.kind}-${chip.value}`"
              @click="setChip(row.kind, chip.value)"
            >
              {{ t(chip.key, { value: chip.value }) }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dimension-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dimension-note {
  margin: 0;
  padding-block: 8px;
  padding-inline: 10px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.dimension-accordion {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dimension-row {
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.dimension-row.expanded {
  background: var(--color-surface-control);
  border-color: var(--color-border-control);
}

.dimension-row-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-block: 11px;
  padding-inline: 12px;
  font-size: 13.5px;
  font-weight: var(--font-weight-control);
  color: var(--color-primary);
  cursor: pointer;
}

.dimension-row-head.disabled {
  color: var(--color-text-muted-quiet);
  cursor: not-allowed;
}

.dimension-dot {
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  border: 1.5px solid var(--color-border-control);
  border-radius: 50%;
}

.dimension-row.expanded .dimension-dot {
  border-color: var(--color-tint);
}

.dimension-radio {
  position: absolute;
  opacity: 0;
  inline-size: 1px;
  block-size: 1px;
}

.dimension-row-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-block-end: 12px;
  padding-inline: 12px;
}

.dimension-field {
  min-block-size: 36px;
  padding-inline: 10px;
  background: var(--color-surface-panel);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-family: var(--font-family-mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  flex: none;
  padding-block: 6px;
  padding-inline: 11px;
  background: var(--color-surface-panel);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.chip.active {
  border-color: var(--color-tint);
  color: var(--color-primary);
}
</style>
