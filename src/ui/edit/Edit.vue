<script setup lang="ts">
// Edit stage mode (Technical Design §2). T31 only establishes the exclusive-mounting shell
// (docs/ui-design.md §3); real content (rotation, crop rectangle, ratio row, background row,
// R-C1-R-C17) is T37's job. Kept at its real, eventual name so T37 fills it in place.
import { t } from '@/i18n/t'
</script>

<template>
  <div class="stage-mode-placeholder" data-testid="edit-placeholder">
    <p>{{ t('shell.modeNotYetBuilt') }}</p>
  </div>
</template>
