<script setup lang="ts">
// Shared pill button for stage toolbars (GalleryToolbar.vue, PreviewToolbar.vue — both mounted
// into StageContainer.vue's `toolbar` slot). Icon + label above the side-panel breakpoint; below
// it (StageContainer.vue's own `@media (max-width: 899.98px)`, SIDE_PANEL_BREAKPOINT_PX) the icon
// drops and only the label remains, so a cramped toolbar never shrinks a button down to a bare
// icon a user might hesitate to tap (Clear in particular).
//
// `iconOnlyMobile` is the one deliberate exception to that rule (Preview toolbar's "Add Images",
// confirmed with the user): below the breakpoint it flips the icon back on and visually hides the
// label instead of dropping it, rather than removing the label from the DOM — the accessible name
// (and `.text()` in tests) still comes from the label, only its on-screen box collapses, so this
// stays a screen-reader-visible label, not a true bare-icon button.
//
// A store-free leaf, like PrimaryActionButton.vue — every attribute Vue doesn't claim as a prop
// (data-testid, aria-label, disabled, @click, ...) falls through to the root <button> as usual.
defineProps<{ quiet?: boolean; iconOnlyMobile?: boolean }>()
</script>

<template>
  <button
    type="button"
    class="toolbar-button"
    :class="{ quiet, 'icon-only-mobile': iconOnlyMobile }"
  >
    <span v-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <span class="label"><slot /></span>
  </button>
</template>

<style scoped>
.toolbar-button {
  display: flex;
  align-items: center;
  gap: 6px;
  min-block-size: 36px;
  padding-block: 7px;
  padding-inline: 12px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.toolbar-button:disabled {
  color: var(--color-text-muted-quiet);
  cursor: not-allowed;
}

.toolbar-button.quiet {
  background: transparent;
  color: var(--color-text-muted);
}

.icon {
  display: flex;
}

@media (max-width: 899.98px) {
  .icon {
    display: none;
  }

  .toolbar-button {
    padding-inline: 10px;
  }

  /* The `iconOnlyMobile` exception: put the icon back and visually collapse the label instead of
     removing it, so the button keeps its accessible name (and its `.text()` in tests) — only the
     on-screen box shrinks to the icon's footprint. Higher specificity than the two rules above, so
     it wins regardless of source order. */
  .toolbar-button.icon-only-mobile .icon {
    display: flex;
  }

  .toolbar-button.icon-only-mobile {
    padding-inline: 9px;
  }

  .toolbar-button.icon-only-mobile .label {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}
</style>
