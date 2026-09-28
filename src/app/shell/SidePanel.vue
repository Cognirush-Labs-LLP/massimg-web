<script setup lang="ts">
// The side panel's content: three sections in fixed order — Quality, Dimension, Format
// (docs/ui-design.md §2, §8-§10). Rendered once by ToolPage.vue, inside either the static
// desktop column or the mobile Drawer, never both at once (avoids two live copies of the same
// settings controls once T35 adds real form inputs to each section).
import { t } from '@/i18n/t'
import SidePanelSection from './SidePanelSection.vue'
</script>

<template>
  <div class="side-panel-sections">
    <SidePanelSection :heading="t('panel.section.quality')">
      <!-- T35: quality target selector, slider, shortcut chips (docs/ui-design.md §8). -->
    </SidePanelSection>
    <SidePanelSection :heading="t('panel.section.dimension')">
      <!-- T35: dimension accordion (docs/ui-design.md §9). -->
    </SidePanelSection>
    <SidePanelSection :heading="t('panel.section.format')">
      <!-- T35: format dropdown (docs/ui-design.md §10). -->
    </SidePanelSection>
  </div>
</template>
