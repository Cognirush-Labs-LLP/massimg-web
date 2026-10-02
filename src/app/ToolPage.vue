<script setup lang="ts">
// The compressor tool's own page, mounted at '/' (Technical Design §12.3, R-S1). Owns the
// header/stage/side-panel shell (docs/ui-design.md §2) and exclusive stage-mode mounting
// (docs/ui-design.md §3, Technical Design §1.1) — everything Half 2 of T31 describes. Deliberately
// separate from App.vue (the thin vite-ssg root) because T43 wraps App.vue with an outer site
// header/footer later; this page's own chrome must already live inside the routed page, not the
// app root.
import { computed, onMounted, ref, type Component } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { scheduleImageMagickPreload } from '@/pipeline/codecs/loader'
import Gallery from '@/ui/gallery/Gallery.vue'
import GalleryToolbar from '@/ui/gallery/GalleryToolbar.vue'
import Preview from '@/ui/preview/Preview.vue'
import PreviewToolbar from '@/ui/preview/PreviewToolbar.vue'
import Edit from '@/ui/edit/Edit.vue'
import Processing from '@/ui/processing/Processing.vue'
import Header from './shell/Header.vue'
import StageContainer from './shell/StageContainer.vue'
import SidePanel from './shell/SidePanel.vue'
import Drawer from './shell/Drawer.vue'
import PrimaryActionButton from './shell/PrimaryActionButton.vue'
import { useUiStore, type StageMode } from '@/stores/ui'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { describePrimaryActionOutput } from '@/domain/job'
import type { EncodableFormat } from '@/domain/types'
import { useBreakpoint } from './shell/useBreakpoint'

const uiStore = useUiStore()
const { stageMode, drawerOpen } = storeToRefs(uiStore)
const batchStore = useBatchStore()
const { images } = storeToRefs(batchStore)
const settingsStore = useSettingsStore()
const { isDesktop } = useBreakpoint()

const STAGE_COMPONENTS: Record<StageMode, Component> = {
  gallery: Gallery,
  preview: Preview,
  edit: Edit,
  processing: Processing,
}
const stageComponent = computed(() => STAGE_COMPONENTS[stageMode.value])

// The panel is not shown during Processing — it is replaced entirely by run status
// (docs/ui-design.md §2, §13); there is nothing to configure mid-run. The persistent Compress
// button is part of Gallery/Preview/Edit chrome for the same reason: Processing supplies its
// own actions (Cancel, then Download/Back to images, T38).
const showPanel = computed(() => stageMode.value !== 'processing')

const imageCount = computed(() => images.value.length)
const primaryActionDisabled = computed(() => imageCount.value === 0)

// The breadcrumb's `PREVIEW · abc.jpg` / `EDIT · abc.jpg` forms (docs/ui-design.md §2). Header.vue
// has computed them since T31; this is the real value its `activeFileName` prop was waiting for.
const activeFileName = computed(
  () => images.value.find((image) => image.id === uiStore.currentImageId)?.name ?? '',
)

// Facts-only meta line beneath the Compress button (R-A2, R-F4, T35). Format acronyms are
// deliberately not translated (see SidePanelFormat.vue's own note) — only "Original formats" is
// an actual sentence.
const FORMAT_DISPLAY_NAME: Record<EncodableFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
  avif: 'AVIF',
  gif: 'GIF',
}

const primaryActionMeta = computed(() => {
  const summary = describePrimaryActionOutput(images.value, {
    quality: settingsStore.quality,
    dimension: settingsStore.dimension,
    format: settingsStore.format,
  })

  if (summary.kind === 'empty') {
    return ''
  }

  if (summary.kind === 'multi') {
    return summary.formatLabel === 'original'
      ? t('action.meta.multiOriginal', { count: summary.count })
      : t('action.meta.multiFormat', {
          count: summary.count,
          format: FORMAT_DISPLAY_NAME[summary.formatLabel],
        })
  }

  const format =
    summary.formatLabel === 'original' ? null : FORMAT_DISPLAY_NAME[summary.formatLabel]

  if (summary.dimensions === null) {
    return format === null
      ? t('action.meta.singleOriginalPending')
      : t('action.meta.singleFormatPending', { format })
  }

  const { width, height } = summary.dimensions

  return format === null
    ? t('action.meta.singleOriginalWithDimensions', { width, height })
    : t('action.meta.singleFormatWithDimensions', { format, width, height })
})

// A second, independently mounted component per stage mode, rendered into StageContainer's
// `toolbar` slot — `<component :is="stageComponent">` above only fills the default slot, so a
// mode's toolbar content (Gallery's Add images/Add folder/Clear, from T33-A) can't come from
// inside that same component instance. Only 'gallery' has one so far; T35-T38 add the rest as
// their own stage modes need toolbar content. The Gallery entry is gated on a non-empty batch
// here (rather than the component rendering nothing for an empty batch) so this doesn't depend on
// StageContainer's `.stage-toolbar:empty` CSS rule matching a component that renders only a
// comment node.
const STAGE_TOOLBARS: Partial<Record<StageMode, Component>> = {
  gallery: GalleryToolbar,
  preview: PreviewToolbar,
}
const stageToolbar = computed(() =>
  stageMode.value === 'gallery' && imageCount.value === 0
    ? null
    : (STAGE_TOOLBARS[stageMode.value] ?? null),
)

// Not store state (docs/ui-design.md §4 lists only drawer *open* state as store-owned): a live
// DOM handle for focus-return has the same non-serializable, DOM-coupled character the
// binary-data rule guards against in spirit, so it stays local to the component that opens it.
const drawerOpener = ref<HTMLElement | null>(null)

function openPanel(opener: HTMLElement): void {
  drawerOpener.value = opener
  uiStore.openDrawer()
}

// Client-only: vite-ssg runs this component once in Node at build time, where `window`, WASM
// and workers don't exist (Technical Design §12.1/§12.3). `onMounted` never fires during that
// pass, which is what makes this safe — moved here from the old src/app/main.ts module scope.
onMounted(() => {
  scheduleImageMagickPreload()
})
</script>

<template>
  <div class="tool-page">
    <Header
      :stage-mode="stageMode"
      :is-desktop="isDesktop"
      :selected-count="imageCount"
      :active-file-name="activeFileName"
      @open-panel="openPanel"
    />

    <div class="tool-body">
      <StageContainer>
        <template v-if="stageToolbar" #toolbar>
          <component :is="stageToolbar" />
        </template>
        <component :is="stageComponent" />
      </StageContainer>

      <aside
        v-if="isDesktop && showPanel"
        class="side-panel-static"
        :aria-label="t('shell.panelLabel')"
      >
        <div class="side-panel-scroll">
          <SidePanel />
        </div>
        <div class="side-panel-footer">
          <PrimaryActionButton
            :count="imageCount"
            :disabled="primaryActionDisabled"
            :meta-line="primaryActionMeta"
          />
        </div>
      </aside>

      <Drawer v-if="!isDesktop && showPanel" v-model="drawerOpen" :return-focus-to="drawerOpener">
        <SidePanel />
      </Drawer>
    </div>

    <div v-if="!isDesktop && showPanel" class="mobile-action-bar">
      <PrimaryActionButton
        :count="imageCount"
        :disabled="primaryActionDisabled"
        :meta-line="primaryActionMeta"
      />
    </div>
  </div>
</template>

<style scoped>
.tool-page {
  display: flex;
  flex-direction: column;
  block-size: 100vh;
  min-block-size: 100vh;
  overflow: hidden;
}

.tool-body {
  display: flex;
  flex: 1;
  min-block-size: 0;
  position: relative;
}

.side-panel-static {
  display: flex;
  flex: none;
  flex-direction: column;
  inline-size: 344px;
  min-block-size: 0;
  background: var(--color-surface-panel);
  border-inline-start: 1px solid var(--color-border-group);
}

.side-panel-scroll {
  flex: 1;
  min-block-size: 0;
  overflow-y: auto;
}

.side-panel-footer {
  flex: none;
  padding-block: 14px 18px;
  padding-inline: 16px;
  border-block-start: 1px solid var(--color-border-group);
}

.mobile-action-bar {
  position: fixed;
  z-index: 20;
  inset-inline: 0;
  inset-block-end: 0;
  padding-block: 12px 16px;
  padding-inline: 14px;
  background: var(--color-surface-panel);
  border-block-start: 1px solid var(--color-border-group);
}
</style>
