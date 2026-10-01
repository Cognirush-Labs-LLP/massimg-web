<script setup lang="ts">
// The side panel's content: three sections in fixed order — Quality, Dimension, Format
// (docs/ui-design.md §2, §8-§10). Rendered once by ToolPage.vue, inside either the static
// desktop column or the mobile Drawer, never both at once (avoids two live copies of the same
// settings controls).
import { t } from '@/i18n/t'
import SidePanelSection from './SidePanelSection.vue'
import SidePanelQuality from './SidePanelQuality.vue'
import SidePanelDimension from './SidePanelDimension.vue'
import SidePanelFormat from './SidePanelFormat.vue'
</script>

<template>
  <div class="side-panel-sections">
    <SidePanelSection :heading="t('panel.section.quality')">
      <SidePanelQuality />
    </SidePanelSection>
    <SidePanelSection :heading="t('panel.section.dimension')">
      <SidePanelDimension />
    </SidePanelSection>
    <SidePanelSection :heading="t('panel.section.format')">
      <SidePanelFormat />
    </SidePanelSection>
  </div>
</template>
