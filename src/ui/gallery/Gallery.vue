<script setup lang="ts">
// Gallery stage mode (Technical Design §2: "src/ui/, one directory per stage mode").
// T31 only establishes the exclusive-mounting shell (docs/ui-design.md §3); the real empty
// state, drop zone and thumbnail grid (Functional Design §3.2, R-G1-R-G12) are T33's job. This
// file keeps its real, eventual name so T33 fills it in place rather than renaming a stub.
import { t } from '@/i18n/t'
</script>

<template>
  <div class="stage-mode-placeholder" data-testid="gallery-placeholder">
    <p>{{ t('shell.modeNotYetBuilt') }}</p>
  </div>
</template>
