<script setup lang="ts">
// One of the side panel's three fixed sections — Quality, Dimension, Format, in that order
// (docs/ui-design.md §2). Heading text is passed in already translated by the caller, uppercase
// applied here via CSS text-transform rather than baked into the string (R-L1/R-L5). Body
// content is T35's job (docs/ui-design.md §8-§10) — this is the structural hook.
defineProps<{ heading: string }>()
</script>

<template>
  <section class="panel-section">
    <h2 class="panel-section-heading">{{ heading }}</h2>
    <div class="panel-section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel-section {
  padding-block: 1rem;
  padding-inline: 1rem;
  border-block-end: 1px solid var(--color-border-group);
}

.panel-section:last-child {
  border-block-end: none;
}

.panel-section-heading {
  margin-block: 0 0.5rem;
  margin-inline: 0;
  font-size: 0.8rem;
  font-weight: var(--font-weight-heading);
  letter-spacing: var(--letter-spacing-heading);
  text-transform: uppercase;
  color: var(--color-text-muted);
}
</style>
