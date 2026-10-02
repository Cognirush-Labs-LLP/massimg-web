<script setup lang="ts">
// The Preview toolbar row (Functional Design §3.3, R-M3, R-P7, R-C16; docs/ui-design.md §11):
// Back to images, Add more images, the `3 / 6` stepper, and Edit / Edit changes.
//
// Mounted independently of Preview.vue, into StageContainer's `toolbar` slot via ToolPage.vue's
// STAGE_TOOLBARS map — `<component :is>` fills only the default slot, so a mode's toolbar cannot
// come from inside that mode's own component instance (the same arrangement GalleryToolbar.vue
// documents). It therefore shares no instance state with the frame: everything here goes through the
// stores and through `stepping.ts`'s plain functions.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'
import { addViaFilePicker } from '@/ui/gallery/ingest'
import { stepPreview } from './stepping'

const uiStore = useUiStore()
const { currentImageId } = storeToRefs(uiStore)
const { images } = storeToRefs(useBatchStore())

const index = computed(() => images.value.findIndex((image) => image.id === currentImageId.value))
const image = computed(() => images.value[index.value] ?? null)
/** docs/ui-design.md §11: the stepper appears "only when the batch has more than one image". */
const showsStepper = computed(() => images.value.length > 1 && index.value !== -1)

const stepperText = computed(() =>
  t('preview.toolbar.stepper', { index: index.value + 1, total: images.value.length }),
)

// R-C16: editing is not offered for an animated source in this version, and the reason is stated
// inline rather than left as a control that silently does nothing. The button stays visible and
// disabled so the note beside it has something to explain.
const animated = computed(() => image.value?.isAnimated === true)
const editLabel = computed(() =>
  image.value?.edit != null ? t('preview.toolbar.editChanges') : t('preview.toolbar.edit'),
)

function openEdit(): void {
  const id = currentImageId.value

  if (id !== null && !animated.value) {
    uiStore.openEdit(id)
  }
}
</script>

<template>
  <div class="preview-toolbar">
    <button
      type="button"
      class="toolbar-button"
      data-testid="preview-back"
      @click="uiStore.backToGallery()"
    >
      {{ t('preview.toolbar.back') }}
    </button>

    <button
      type="button"
      class="toolbar-button"
      data-testid="preview-add-more"
      @click="addViaFilePicker"
    >
      {{ t('preview.toolbar.addMore') }}
    </button>

    <div v-if="showsStepper" class="stepper" data-testid="preview-stepper">
      <button
        type="button"
        class="stepper-button"
        :aria-label="t('preview.toolbar.previous')"
        data-testid="preview-step-previous"
        @click="stepPreview(-1)"
      >
        ‹
      </button>
      <span class="stepper-position" data-testid="preview-stepper-position">{{ stepperText }}</span>
      <button
        type="button"
        class="stepper-button"
        :aria-label="t('preview.toolbar.next')"
        data-testid="preview-step-next"
        @click="stepPreview(1)"
      >
        ›
      </button>
    </div>

    <div class="trailing">
      <p v-if="animated" class="edit-note" data-testid="preview-edit-animated-note">
        {{ t('preview.toolbar.editAnimatedReason') }}
      </p>
      <button
        type="button"
        class="toolbar-button"
        :disabled="animated || image === null"
        data-testid="preview-edit"
        @click="openEdit"
      >
        {{ editLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.preview-toolbar {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.toolbar-button {
  min-block-size: 36px;
  padding-block: 7px;
  padding-inline: 12px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.toolbar-button:disabled {
  color: var(--color-text-muted-quiet);
  cursor: not-allowed;
}

.stepper {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
}

.stepper-button {
  min-inline-size: 32px;
  min-block-size: 30px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 15px;
  font-weight: var(--font-weight-wordmark);
  line-height: 1;
  cursor: pointer;
}

.stepper-position {
  min-inline-size: 52px;
  padding-inline: 6px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.trailing {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-inline-start: auto;
}

.edit-note {
  margin: 0;
  color: var(--color-text-muted-quiet);
  font-size: 11.5px;
  max-inline-size: 34ch;
}
</style>
