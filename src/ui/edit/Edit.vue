<script setup lang="ts">
// Edit stage mode (Functional Design R-C1-R-C17, R-K4; Technical Design §6; docs/ui-design.md
// §12). Replaces T31's placeholder. Orchestrator only: `useEditDraftStore` owns the arithmetic
// and the Apply/Cancel/Remove actions, `EditFrame` owns the image/crop-rectangle overlay,
// `EditRatioRow`/`EditBackgroundRow` the ratio chips and background controls, and `EditToolbar`
// (mounted separately by ToolPage.vue's STAGE_TOOLBARS, like every other stage's toolbar) the
// rotate/W-H/Apply/Cancel/Remove controls. Unmounting this component is what releases the draft
// session (`reset()`, R-M4) — nothing here outlives one Edit visit.
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useUiStore } from '@/stores/ui'
import EditBackgroundRow from './EditBackgroundRow.vue'
import EditFrame from './EditFrame.vue'
import EditRatioRow from './EditRatioRow.vue'
import { useEditKeyboard } from './useEditKeyboard'

const draft = useEditDraftStore()
const uiStore = useUiStore()
const { images } = storeToRefs(useBatchStore())

const image = computed(
  () => images.value.find((candidate) => candidate.id === uiStore.currentImageId) ?? null,
)

let initialized = false

/**
 * `EditFrame`'s own `ResizeObserver` measures the host it is given and calls `draft.setFrame()`
 * on mount, and Vue mounts children before parents — so by the time this runs, `draft.frame`
 * already holds a real size in the ordinary case. The watcher below is the fallback for whatever
 * order actually happens (jsdom/test environments without `ResizeObserver`, a slow first layout),
 * not the primary path.
 */
function tryInit(): void {
  if (initialized) {
    return
  }

  const current = image.value
  const hostSize = draft.frame

  if (current === null || hostSize.width <= 0 || hostSize.height <= 0) {
    return
  }

  draft.initFor(current, hostSize)
  initialized = true
}

const stopWatchingFrame = watch(() => draft.frame, tryInit, { immediate: true })

onMounted(() => {
  tryInit()
})

onBeforeUnmount(() => {
  stopWatchingFrame()
  draft.reset()
})

useEditKeyboard()
</script>

<template>
  <div v-if="image" class="edit-mode" data-testid="edit-root">
    <EditRatioRow />
    <EditFrame />
    <EditBackgroundRow v-if="draft.visibleBackgroundRow" />
  </div>
</template>

<style scoped>
.edit-mode {
  display: flex;
  flex-direction: column;
  gap: 14px;
  block-size: 100%;
  min-block-size: 0;
}
</style>
