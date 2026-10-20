<script setup lang="ts">
// Stage region (docs/ui-design.md §2): a mode-specific toolbar row that wraps rather than
// scrolls horizontally (R-R2), plus a scrollable body hosting the mounted stage-mode component.
// T31 builds this structural container; toolbar content per mode is T33-T38's job.
</script>

<template>
  <main class="stage">
    <div class="stage-toolbar">
      <slot name="toolbar" />
    </div>
    <div class="stage-body">
      <slot />
    </div>
  </main>
</template>

<style scoped>
.stage {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-inline-size: 0;
}

.stage-toolbar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding-block: 14px;
  padding-inline: 18px;
  border-block-end: 1px solid var(--color-border-group);
}

.stage-toolbar:empty {
  display: none;
}

.stage-body {
  flex: 1;
  min-block-size: 0;
  overflow-y: auto;
  padding: 18px;
}

/* No extra bottom clearance below 900px. T31 reserved 96px here because its
   .mobile-action-bar (ToolPage.vue) was `position: fixed` and overlapped the scrolled-to-bottom
   stage; T43 made that bar an ordinary flex item, which takes its own space at the end of
   .tool-page and overlaps nothing, so the reservation became dead space — 96px of it, costing
   Preview about 17% of its frame height on a phone. If that bar is ever made an overlay again,
   this clearance has to come back with it — tests/e2e/app.spec.ts pins the contract. */
</style>
