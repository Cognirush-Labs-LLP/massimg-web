<script setup lang="ts">
// Preview stage mode (Technical Design §2). T31 only establishes the exclusive-mounting shell
// (docs/ui-design.md §3); real content (encode-on-entry, comparison pill, transform line,
// R-P1-R-P8) is T36's job. Kept at its real, eventual name so T36 fills it in place.
import { t } from '@/i18n/t'
</script>

<template>
  <div class="stage-mode-placeholder" data-testid="preview-placeholder">
    <p>{{ t('shell.modeNotYetBuilt') }}</p>
  </div>
</template>
