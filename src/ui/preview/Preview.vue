<script setup lang="ts">
// Preview stage mode (Functional Design §3.3, R-P1-R-P8, R-M3; Technical Design §4, §5.3;
// docs/ui-design.md §11). Replaces T31's placeholder.
//
// This component is the orchestrator and holds no arithmetic: `usePreviewEncode` owns the encode
// lifecycle and the working set, `transform-line.ts` owns what the line says, `PreviewFrame` owns
// the frame and the inspector, and the toolbar is mounted separately into the stage's toolbar slot
// by ToolPage.vue. Unmounting it is what releases Preview's data (R-M4), which is why none of that
// state lives above this component.
//
// `PreviewZoomToolbar` is the one exception to "no arithmetic lives above PreviewFrame": it is
// purely presentational, and reads/drives `PreviewFrame`'s own viewport state through a template
// ref rather than owning anything itself, because it renders beside the Original/Compressed pill
// here rather than as an overlay on the image (that was tried and looked bad).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { withTrailingResize, type PixelSize } from '@/domain/edit'
import {
  dimensionSettingForRecovery,
  singleImageDimensions,
  standardSmallerRecoveryDimensions,
  type BatchSettings,
} from '@/domain/job'
import { formatUiSize } from '@/domain/sizes'
import type { Rgba } from '@/domain/types'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { useSettingsStore } from '@/stores/settings'
import { useUiStore } from '@/stores/ui'
import { ingestDrop } from '@/ui/gallery/ingest'
import PreviewComparisonPill from './PreviewComparisonPill.vue'
import PreviewFrame from './PreviewFrame.vue'
import PreviewTransformLine from './PreviewTransformLine.vue'
import PreviewZoomToolbar from './PreviewZoomToolbar.vue'
import LoadingStatus from './LoadingStatus.vue'
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
  allowRecovery: computed(() => images.value.length === 1),
})

const transformLine = computed(() =>
  image.value === null ? null : describeTransformLine(image.value, settings.value),
)

const standardDimensionSuggestion = computed<PixelSize | null>(() => {
  const current = image.value
  const verified = encode.dimensionSuggestion.value

  if (current === null || verified === null) return null

  return standardSmallerRecoveryDimensions(settingsStore.dimension, verified, current.edit !== null)
})

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

const frame = ref<InstanceType<typeof PreviewFrame> | null>(null)

/** Reads `PreviewFrame`'s exposed zoom state; `null` whenever the frame itself isn't mounted. */
const zoomToolbar = computed(() => ({
  visible: frame.value?.showsZoomToolbar ?? false,
  percent: frame.value?.zoomPercent ?? 0,
  fitDisabled: frame.value === null || !frame.value.zoomed,
  actualSizeDisabled: frame.value?.atActualSize ?? true,
}))

function onZoomFit(): void {
  frame.value?.onFitClick()
}

function onZoomActualSize(): void {
  frame.value?.onActualSizeClick()
}

function fillName(fill: Rgba): string {
  if (fill.r === 255 && fill.g === 255 && fill.b === 255) return t('preview.size.colorWhite')
  if (fill.r === 0 && fill.g === 0 && fill.b === 0) return t('preview.size.colorBlack')
  return t('preview.size.colorRgb', { red: fill.r, green: fill.g, blue: fill.b })
}

function useJpegSuggestion(): void {
  settingsStore.format = 'jpeg'
}

function useDimensionSuggestion(suggestion: PixelSize | null): void {
  const current = image.value

  if (current === null || suggestion === null) return

  if (current.edit !== null) {
    useBatchStore().updateImage(current.id, {
      edit: withTrailingResize(current.edit, suggestion),
    })
    return
  }

  settingsStore.dimension = dimensionSettingForRecovery(settingsStore.dimension, suggestion)
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
    <div v-if="encode.phase.value !== 'encoding' || zoomToolbar.visible" class="top-row">
      <!-- R-P4: hidden, not stale, while an encode is in flight. -->
      <PreviewComparisonPill
        v-if="encode.phase.value !== 'encoding'"
        :tab="comparisonTab"
        :original-bytes="image.sizeBytes"
        :compressed-bytes="encode.compressedBytes.value"
        @toggle="toggleTab"
      />
      <PreviewZoomToolbar
        v-if="zoomToolbar.visible"
        :percent="zoomToolbar.percent"
        :fit-disabled="zoomToolbar.fitDisabled"
        :actual-size-disabled="zoomToolbar.actualSizeDisabled"
        @fit="onZoomFit"
        @actual-size="onZoomActualSize"
      />
    </div>

    <PreviewTransformLine v-if="transformLine" :line="transformLine" />

    <section
      v-if="encode.unreachable.value"
      class="recovery"
      data-testid="preview-size-unreachable"
      role="status"
    >
      <p>
        {{
          t('preview.size.unreachable', {
            target: formatUiSize(encode.unreachable.value.targetBytes),
            width: encode.unreachable.value.width,
            height: encode.unreachable.value.height,
            format: encode.unreachable.value.format.toUpperCase(),
            achieved: formatUiSize(encode.unreachable.value.achievedBytes),
          })
        }}
      </p>
      <p v-if="images.length > 1">
        {{ t('preview.size.batch', { count: images.length }) }}
      </p>
      <p v-else-if="image.isAnimated">{{ t('preview.size.animationNoRecovery') }}</p>
      <LoadingStatus
        v-else-if="encode.recoveryPhase.value === 'checking'"
        :message="t('preview.size.checking')"
        data-testid="preview-recovery-loading"
      />
      <div v-if="images.length === 1 && !image.isAnimated" class="recovery__actions">
        <button
          v-if="encode.jpegSuggestion.value"
          type="button"
          class="recovery__action"
          data-testid="preview-use-jpeg"
          @click="useJpegSuggestion"
        >
          {{
            encode.jpegSuggestion.value.flattenedFill
              ? t('preview.size.useJpegFlattened', {
                  color: fillName(encode.jpegSuggestion.value.flattenedFill),
                  size: formatUiSize(encode.jpegSuggestion.value.outputBytes),
                })
              : t('preview.size.useJpeg', {
                  size: formatUiSize(encode.jpegSuggestion.value.outputBytes),
                })
          }}
        </button>
        <button
          v-if="encode.dimensionSuggestion.value"
          type="button"
          class="recovery__action"
          data-testid="preview-use-dimensions"
          @click="useDimensionSuggestion(encode.dimensionSuggestion.value)"
        >
          {{
            t('preview.size.useDimensions', {
              width: encode.dimensionSuggestion.value.width,
              height: encode.dimensionSuggestion.value.height,
              size: formatUiSize(encode.dimensionSuggestion.value.outputBytes),
            })
          }}
        </button>
        <button
          v-if="standardDimensionSuggestion"
          type="button"
          class="recovery__action"
          data-testid="preview-use-smaller-dimensions"
          @click="useDimensionSuggestion(standardDimensionSuggestion)"
        >
          {{
            t('preview.size.useSmallerDimensions', {
              width: standardDimensionSuggestion.width,
              height: standardDimensionSuggestion.height,
            })
          }}
        </button>
        <p
          v-if="
            encode.recoveryPhase.value === 'done' &&
            !encode.jpegSuggestion.value &&
            !encode.dimensionSuggestion.value
          "
          data-testid="preview-recovery-none"
        >
          {{ t('preview.size.noAlternative') }}
        </p>
      </div>
    </section>

    <PreviewFrame
      v-if="!encode.unreachable.value"
      ref="frame"
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

.top-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.recovery {
  inline-size: min(100%, 760px);
  padding-block: 12px;
  padding-inline: 14px;
  margin-block: auto;
  border: 1px solid var(--color-border-control);
  border-inline-start: 3px solid var(--color-tint);
  border-radius: var(--radius-lg);
  background: var(--color-surface-tile);
  color: var(--color-primary);
  font-size: 0.875rem;
  line-height: 1.5;
}

.recovery p {
  margin: 0;
}

.recovery p + p,
.recovery__actions {
  margin-block-start: 8px;
}

.recovery > p:not(:first-child) {
  color: var(--color-text-muted);
}

.recovery__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.recovery__action {
  min-block-size: 36px;
  padding-inline: 12px;
  border: 1px solid var(--color-border-control);
  border-radius: 999px;
  background: var(--color-surface-control);
  color: var(--color-primary);
  cursor: pointer;
}

.recovery__action:hover,
.recovery__action:focus-visible {
  border-color: var(--color-tint);
}
</style>
