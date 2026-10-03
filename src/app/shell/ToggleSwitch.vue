<script setup lang="ts">
// Shared two-option toggle for stage toolbars (GalleryToolbar.vue's grid/list view toggle,
// PreviewComparisonPill.vue's Original/Compressed switch). One control, not two buttons: clicking
// anywhere on it flips the state, so the user doesn't have to aim at a specific half — and it is a
// single `role="switch"` rather than two `aria-pressed` buttons, since the two halves are mutually
// exclusive rather than independently pressable (R-K6).
//
// `variant` picks which of the two existing looks to render: `icons` is the flush, clipped-corner
// square-button look (GalleryToolbar's grid/list glyphs); `pill` is the padded, gapped, rounded-half
// look (PreviewComparisonPill's Original/Compressed text). Both predate this component unchanged —
// `variant` exists so neither one's appearance moved when the markup merged.
const props = defineProps<{
  checked: boolean
  /** Accessible name for the switch (not itself visible text) — plain `label`, not `ariaLabel`, so
   * it isn't mistaken by lint/type-checking for the native `aria-label` HTML attribute. */
  label: string
  variant: 'icons' | 'pill'
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    class="toggle-switch"
    :class="variant"
    role="switch"
    :aria-checked="checked"
    :aria-label="props.label"
    @click="emit('toggle')"
  >
    <span class="half" :class="{ active: !checked }"><slot name="first" /></span>
    <span class="half" :class="{ active: checked }"><slot name="second" /></span>
  </button>
</template>

<style scoped>
.toggle-switch {
  display: flex;
  flex-shrink: 0;
  /* Chromium's UA stylesheet gives a <button> its own default padding (observed: 1px 6px) even
     with `appearance: none` (that resets native painting, not the UA stylesheet's box-model
     declarations) — left unset here, it insets both halves from the container's edges, showing a
     sliver of the container's own background between a flush "active" half and the rounded
     border. `.pill` already overrides this with its own padding; `.icons` relies on this zero. */
  padding: 0;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.half {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.half.active {
  background: var(--color-primary);
  color: var(--color-surface-control);
}

.toggle-switch.icons {
  overflow: hidden;
}

.toggle-switch.icons .half {
  min-inline-size: 36px;
  min-block-size: 36px;
  padding: 7px;
}

.toggle-switch.pill {
  gap: 3px;
  padding: 3px;
}

.toggle-switch.pill .half {
  min-block-size: 30px;
  padding-block: 6px;
  padding-inline: 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
}
</style>
