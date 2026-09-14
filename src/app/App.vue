<script setup lang="ts">
// Placeholder root component. This only proves Vite + Vue + Pinia boot correctly.
// The real shell (routing, stage-mode switching) is built in T31+, per
// docs/technical-design.md §2.
//
// --- T07 marker ---------------------------------------------------------
// TokensDemo is mounted below, temporarily, so the design tokens added in
// T07 render somewhere reachable via `pnpm dev`/`pnpm build` without a real
// router (that's T31's job). Remove this import and <TokensDemo /> (and,
// optionally, src/app/TokensDemo.vue) once T31 replaces this placeholder, or
// move the demo to a dedicated dev-only route if one exists by then. See
// docs/task-notes/T07.md.
// -------------------------------------------------------------------------
import TokensDemo from './TokensDemo.vue'

// --- T08 marker ----------------------------------------------------------
// I18nDemo is mounted below, temporarily, so the i18n scaffold added in T08
// (src/i18n/t.ts + src/i18n/en/{messages,context}.json) renders somewhere
// reachable via `pnpm dev`/`pnpm build` without a real router (that's T31's
// job), proving a parameterised string renders correctly end to end. Remove
// this import and <I18nDemo /> (and, optionally, src/app/I18nDemo.vue) once
// T31 replaces this placeholder. See docs/task-notes/T08.md.
// ---------------------------------------------------------------------------
import I18nDemo from './I18nDemo.vue'
</script>

<template>
  <main class="app-placeholder">
    <p>icompress scaffold OK</p>
  </main>
  <!-- T07 marker: temporary token demo, see comment above and docs/task-notes/T07.md -->
  <TokensDemo />
  <!-- T08 marker: temporary i18n demo, see comment above and docs/task-notes/T08.md -->
  <I18nDemo />
</template>

<style scoped>
.app-placeholder {
  font-family: system-ui, sans-serif;
  padding: 1rem;
}
</style>
