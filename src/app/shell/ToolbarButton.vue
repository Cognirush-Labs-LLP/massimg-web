<script setup lang="ts">
// Shared pill button for stage toolbars (GalleryToolbar.vue, PreviewToolbar.vue — both mounted
// into StageContainer.vue's `toolbar` slot). Icon + label above the side-panel breakpoint; below
// it (StageContainer.vue's own `@media (max-width: 899.98px)`, SIDE_PANEL_BREAKPOINT_PX) the icon
// drops and only the label remains, so a cramped toolbar never shrinks a button down to a bare
// icon a user might hesitate to tap (Clear in particular). A store-free leaf, like
// PrimaryActionButton.vue — every attribute Vue doesn't claim as a prop (data-testid, aria-label,
// disabled, @click, ...) falls through to the root <button> as usual.
defineProps<{ quiet?: boolean }>()
</script>

<template>
  <button type="button" class="toolbar-button" :class="{ quiet }">
    <span v-if="$slots.icon" class="icon"><slot name="icon" /></span>
    <slot />
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
}
</style>
