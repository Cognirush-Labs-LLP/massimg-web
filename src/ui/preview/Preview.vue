<script setup lang="ts">
// Preview stage mode (Functional Design §3.3, R-P1-R-P8, R-M3; Technical Design §4, §5.3;
// docs/ui-design.md §11). Replaces T31's placeholder.
//
// This component is the orchestrator and holds no arithmetic: `usePreviewEncode` owns the encode
// lifecycle and the working set, `transform-line.ts` owns what the line says, `PreviewFrame` owns
// the frame and the inspector, and the toolbar is mounted separately into the stage's toolbar slot
// by ToolPage.vue. Unmounting it is what releases Preview's data (R-M4), which is why none of that
// state lives above this component.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { PixelSize } from '@/domain/edit'
import { singleImageDimensions, type BatchSettings } from '@/domain/job'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ingestDrop } from '@/ui/gallery/ingest'
import PreviewComparisonPill from './PreviewComparisonPill.vue'
import PreviewFrame from './PreviewFrame.vue'
import PreviewTransformLine from './PreviewTransformLine.vue'
import { stepPreview } from './stepping'
import { describeTransformLine } from './transform-line'
import { usePreviewEncode } from './usePreviewEncode'

const uiStore = useUiStore()
const { currentImageId, comparisonTab } = storeToRefs(uiStore)
const { images } = storeToRefs(useBatchStore())
const settingsStore = useSettingsStore()

const image = computed(
  () => images.value.find((candidate) => candidate.id === currentImageId.value) ?? null,
)

const settings = computed<BatchSettings>(() => ({
  quality: settingsStore.quality,
  dimension: settingsStore.dimension,
  format: settingsStore.format,
}))

const encode = usePreviewEncode({
  image,
  settings,
  wantsOriginal: computed(() => comparisonTab.value === 'original'),
})

const transformLine = computed(() =>
  image.value === null ? null : describeTransformLine(image.value, settings.value),
)

/**
 * The shape to give the frame before the active tab's own raster has loaded: the source's size on
 * the Original tab, the size the current settings will produce on the Compressed tab. Both can be
 * `null` while the background dimension probe has not reached this image.
 */
const placeholderSize = computed<PixelSize | null>(() => {
  const current = image.value

  if (current === null || current.width === 0 || current.height === 0) {
    return null
  }

  return comparisonTab.value === 'original'
    ? { width: current.width, height: current.height }
    : singleImageDimensions(current, settings.value.dimension)
})

function toggleTab(): void {
  uiStore.setComparisonTab(comparisonTab.value === 'compressed' ? 'original' : 'compressed')
}

/**
 * Dropping a file onto Preview adds it the same way Gallery's own drop target does (ingest.ts's
 * `ingestDrop`) — `onBatchCountChanged` already returns to Gallery once the batch grows past one
 * image, so no Preview-specific transition logic is needed here.
 */
function onDrop(event: DragEvent): void {
  event.preventDefault()
  const dataTransfer = event.dataTransfer
  if (dataTransfer) {
    void ingestDrop(dataTransfer)
  }
}

function onDragOver(event: DragEvent): void {
  // Required for the element to become a valid drop target at all.
  event.preventDefault()
}

/**
 * R-K2: arrow keys step through the batch in Preview. Bound to the window rather than to the
 * stepper, so it works wherever focus happens to be — except inside a control that owns the arrow
 * keys itself, which the quality slider in the side panel does.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
  ) {
    return
  }

  const target = event.target

  if (
    target instanceof HTMLElement &&
    target.closest('input, select, textarea, [contenteditable="true"]') !== null
  ) {
    return
  }

  event.preventDefault()
  stepPreview(event.key === 'ArrowLeft' ? -1 : 1)
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div
    v-if="image"
    class="preview"
    data-testid="preview-root"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- R-P4: hidden, not stale, while an encode is in flight. -->
    <PreviewComparisonPill
      v-if="encode.phase.value !== 'encoding'"
      :tab="comparisonTab"
      :original-bytes="image.sizeBytes"
      :compressed-bytes="encode.compressedBytes.value"
      @toggle="toggleTab"
    />

    <PreviewTransformLine v-if="transformLine" :line="transformLine" />

    <PreviewFrame
      :image-id="image.id"
      :file-name="image.name"
      :edit="image.edit"
      :tab="comparisonTab"
      :phase="encode.phase.value"
      :compressed-url="encode.compressedUrl.value"
      :original-url="encode.originalUrl.value"
      :original-unrenderable="encode.originalUnrenderable.value"
      :error="encode.error.value"
      :placeholder-size="placeholderSize"
      @retry="encode.retry()"
      @original-unrenderable="encode.reportOriginalUnrenderable()"
    />
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  block-size: 100%;
  min-block-size: 0;
}
</style>
