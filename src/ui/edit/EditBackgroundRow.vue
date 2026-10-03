<script setup lang="ts">
// Edit mode's background row (Functional Design R-C13-R-C15, R-C17; docs/ui-design.md §12),
// shown only when the crop spills (Edit.vue gates this component's mounting on
// `draft.showsBackgroundRow`). Swatches plus a native colour picker — no numeric RGBA fields,
// which is a deliberate supersession of docs/sample_design/'s four-field mockup (see ui-design.md
// §12's own note on this).
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { isAlphaCapable } from '@/domain/format'
import type { Rgba } from '@/domain/types'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useSettingsStore } from '@/stores/settings'

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 }

const draft = useEditDraftStore()
const { currentImageId, background } = storeToRefs(draft)
const { images } = storeToRefs(useBatchStore())
const settingsStore = useSettingsStore()

const image = computed(
  () => images.value.find((candidate) => candidate.id === currentImageId.value) ?? null,
)

/**
 * The effective output format, live: the side panel's Format control stays visible and
 * interactive while Edit is open, so a mid-edit format change must re-gate the Transparent
 * swatch (R-C13/R-C14) rather than freeze it at the value seen on entry. Reuses
 * `resolveFormat`/`supportsAlpha` directly — the same resolution path `domain/job.ts` uses — not a
 * new one. Animated sources never reach Edit mode (R-C16), so `resolveFormat` never rejects here.
 */
const alphaCapable = computed(() => {
  const current = image.value
  return (
    current === null ||
    isAlphaCapable(current.sourceFormat, current.isAnimated, settingsStore.format)
  )
})

function isActive(swatch: Rgba): boolean {
  return (
    background.value.r === swatch.r &&
    background.value.g === swatch.g &&
    background.value.b === swatch.b &&
    background.value.a === swatch.a
  )
}

function selectSwatch(swatch: Rgba): void {
  draft.setBackground(swatch)
}

function toHex(value: Rgba): string {
  const channel = (n: number) => n.toString(16).padStart(2, '0')
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`
}

/**
 * A native `<input type="color">` has no alpha channel, so every pick yields full opacity — only
 * the Transparent swatch can author full transparency. This UI genuinely cannot author a partial
 * alpha value, which matches "swatches plus a colour picker, no numeric RGBA fields" (ui-design.md
 * §12).
 */
function onColorInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  draft.setBackground({ r, g, b, a: 1 })
}
</script>

<template>
  <div class="background-row" data-testid="edit-background-row">
    <p class="heading">{{ t('edit.background.heading') }}</p>
    <div class="controls">
      <button
        type="button"
        class="swatch swatch-black"
        :class="{ active: isActive(BLACK) }"
        :aria-label="t('edit.background.swatchBlack')"
        :aria-pressed="isActive(BLACK)"
        data-testid="edit-background-black"
        @click="selectSwatch(BLACK)"
      ></button>
      <button
        type="button"
        class="swatch swatch-white"
        :class="{ active: isActive(WHITE) }"
        :aria-label="t('edit.background.swatchWhite')"
        :aria-pressed="isActive(WHITE)"
        data-testid="edit-background-white"
        @click="selectSwatch(WHITE)"
      ></button>
      <button
        v-if="alphaCapable"
        type="button"
        class="swatch swatch-transparent"
        :class="{ active: isActive(TRANSPARENT) }"
        :aria-label="t('edit.background.swatchTransparent')"
        :aria-pressed="isActive(TRANSPARENT)"
        data-testid="edit-background-transparent"
        @click="selectSwatch(TRANSPARENT)"
      ></button>
      <input
        type="color"
        class="color-picker"
        :value="toHex(background)"
        :aria-label="t('edit.background.colorPickerLabel')"
        data-testid="edit-background-picker"
        @input="onColorInput"
      />
    </div>
    <p v-if="!alphaCapable" class="hint" data-testid="edit-background-jpeg-hint">
      {{ t('edit.background.jpegHint') }}
    </p>
  </div>
</template>

<style scoped>
.background-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.heading {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-micro-label);
  font-weight: var(--font-weight-heading);
  letter-spacing: var(--letter-spacing-micro-label);
  text-transform: uppercase;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swatch {
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  border: 2px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.swatch.active {
  border-color: var(--color-tint);
}

.swatch-black {
  background: #000000;
}

.swatch-white {
  background: #ffffff;
}

.swatch-transparent {
  background-image:
    linear-gradient(45deg, #666 25%, transparent 25%, transparent 75%, #666 75%),
    linear-gradient(45deg, #666 25%, transparent 25%, transparent 75%, #666 75%);
  background-size: 8px 8px;
  background-position:
    0 0,
    4px 4px;
  background-color: #1a1a1a;
}

.color-picker {
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  background: none;
  border: 2px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.hint {
  margin: 0;
  color: var(--color-text-muted-quiet);
  font-size: 12px;
  line-height: 1.4;
}
</style>
