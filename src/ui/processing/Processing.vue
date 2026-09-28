<script setup lang="ts">
// Processing stage mode (Technical Design §2). T31 only establishes the exclusive-mounting
// shell (docs/ui-design.md §3); real content (counter, donut, failure list, Cancel/Download,
// R-X1-R-X31) is T38's job. Kept at its real, eventual name so T38 fills it in place.
import { t } from '@/i18n/t'
</script>

<template>
  <div class="stage-mode-placeholder" data-testid="processing-placeholder">
    <p>{{ t('shell.modeNotYetBuilt') }}</p>
  </div>
</template>
