<script setup lang="ts">
// Edit mode's toolbar (Functional Design R-C1-R-C12; docs/ui-design.md §12): Rotate left/right,
// output W/H fields, Remove edit, Cancel, Apply. Mounted independently of Edit.vue, into
// StageContainer's `toolbar` slot via ToolPage.vue's STAGE_TOOLBARS map (the same arrangement
// GalleryToolbar.vue/PreviewToolbar.vue document) — it shares no instance state with Edit.vue's
// own component tree, only `useEditDraftStore()`.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import ToolbarButton from '@/app/shell/ToolbarButton.vue'
import { useEditDraftStore } from '@/stores/edit-draft'

// Not specified by any design document — a feel-tuned range, same spirit as Preview's own
// undocumented MAX_VIEWPORT_SCALE placeholder. Below 1 lets the crop rectangle spill past the
// image (R-C9), which is the only way to reach the background row at all.
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 0.05

const draft = useEditDraftStore()
const { geometry, hasStoredEdit, zoom } = storeToRefs(draft)

const outputSize = computed(() =>
  geometry.value.kind === 'resolved' ? geometry.value.output.size : null,
)
const disabled = computed(() => geometry.value.kind !== 'resolved')
const zoomPercent = computed(() => Math.round(zoom.value * 100))

const isDefaultZoom = computed(() => zoomPercent.value === 100)

function onZoomInput(event: Event): void {
  draft.setZoom(Number((event.target as HTMLInputElement).value))
}

function onZoomReset(): void {
  draft.setZoom(1)
}

function onWidthInput(event: Event): void {
  const sanitized = (event.target as HTMLInputElement).value.replace(/[^\d]/g, '')
  const pixels = sanitized === '' ? 0 : Number(sanitized)
  if (pixels > 0) {
    draft.setTypedDimension({ kind: 'width', pixels })
  }
}

function onHeightInput(event: Event): void {
  const sanitized = (event.target as HTMLInputElement).value.replace(/[^\d]/g, '')
  const pixels = sanitized === '' ? 0 : Number(sanitized)
  if (pixels > 0) {
    draft.setTypedDimension({ kind: 'height', pixels })
  }
}
</script>

<template>
  <div class="edit-toolbar">
    <div class="rotate-group" role="group" :aria-label="t('edit.toolbar.rotateGroupLabel')">
      <ToolbarButton :disabled="disabled" data-testid="edit-rotate-left" @click="draft.rotate(3)">
        <template #icon>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M6 2.5A5.5 5.5 0 1 0 11.5 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
            <path
              d="M6 1v3h3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </template>
        {{ t('edit.toolbar.rotateLeft') }}
      </ToolbarButton>
      <ToolbarButton :disabled="disabled" data-testid="edit-rotate-right" @click="draft.rotate(1)">
        <template #icon>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M10 2.5A5.5 5.5 0 1 1 4.5 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
            <path
              d="M10 1v3H7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </template>
        {{ t('edit.toolbar.rotateRight') }}
      </ToolbarButton>
    </div>

    <div class="zoom-group">
      <span class="field-label">{{ t('edit.zoom.sliderLabel') }}</span>
      <input
        type="range"
        :min="ZOOM_MIN"
        :max="ZOOM_MAX"
        :step="ZOOM_STEP"
        :disabled="disabled"
        :value="zoom"
        :aria-label="t('edit.zoom.sliderLabel')"
        class="zoom-slider"
        data-testid="edit-zoom-slider"
        @input="onZoomInput"
      />
      <span class="zoom-readout" data-testid="edit-zoom-readout">{{ zoomPercent }}%</span>
      <button
        type="button"
        class="zoom-reset"
        :disabled="disabled || isDefaultZoom"
        data-testid="edit-zoom-reset"
        @click="onZoomReset"
      >
        {{ t('edit.zoom.actualSize') }}
      </button>
    </div>

    <div class="dimension-fields">
      <label class="field">
        <span class="field-label">{{ t('edit.toolbar.widthLabel') }}</span>
        <input
          type="text"
          inputmode="numeric"
          class="field-input"
          :disabled="disabled"
          :value="outputSize?.width ?? ''"
          :aria-label="t('edit.toolbar.widthLabel')"
          data-testid="edit-width-field"
          @input="onWidthInput"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t('edit.toolbar.heightLabel') }}</span>
        <input
          type="text"
          inputmode="numeric"
          class="field-input"
          :disabled="disabled"
          :value="outputSize?.height ?? ''"
          :aria-label="t('edit.toolbar.heightLabel')"
          data-testid="edit-height-field"
          @input="onHeightInput"
        />
      </label>
    </div>

    <div class="trailing">
      <ToolbarButton v-if="hasStoredEdit" quiet data-testid="edit-remove" @click="draft.remove()">
        {{ t('edit.toolbar.removeEdit') }}
      </ToolbarButton>
      <ToolbarButton data-testid="edit-cancel" @click="draft.cancel()">
        {{ t('edit.toolbar.cancel') }}
      </ToolbarButton>
      <ToolbarButton :disabled="disabled" data-testid="edit-apply" @click="draft.apply()">
        {{ t('edit.toolbar.apply') }}
      </ToolbarButton>
    </div>
  </div>
</template>

<style scoped>
.edit-toolbar {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.rotate-group,
.zoom-group,
.dimension-fields,
.trailing {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-slider {
  inline-size: 90px;
}

.zoom-readout {
  min-inline-size: 36px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.zoom-reset {
  min-block-size: 22px;
  padding-inline: 7px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.zoom-reset:disabled {
  color: var(--color-text-muted-quiet);
  cursor: not-allowed;
}

.trailing {
  margin-inline-start: auto;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-label {
  color: var(--color-text-muted);
  font-size: 12px;
}

.field-input {
  inline-size: 64px;
  min-block-size: 32px;
  padding-inline: 8px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-family: var(--font-family-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}

.field-input:disabled {
  color: var(--color-text-muted-quiet);
}
</style>
