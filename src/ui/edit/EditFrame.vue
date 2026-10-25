<script setup lang="ts">
// Edit mode's frame (Functional Design R-C1-R-C12, R-K4, R-R4; Technical Design §6;
// docs/ui-design.md §12): the image, the darkened exterior, the checkerboard/fill under spill,
// the crop rectangle with four corner handles, and the live true-output-pixels W×H badge.
//
// No canvas, no `createImageBitmap`: the image is a plain `<img>` on an object URL of the source
// `File` (same convention PreviewFrame.vue uses for its Original tab), letting the browser decode
// and apply EXIF orientation itself. Edit mode never encodes anything — it only edits
// `EditRecord`, and leaves re-encoding to Preview's own debounced watcher on return.
//
// Rotation is display-only, achieved with CSS rather than by physically rotating pixels: the
// image's CSS box is sized at the image's *unrotated* dimensions, centred at the same point
// `imageRectInFrame` always centres at regardless of rotation, then spun with
// `transform: rotate()`. A quarter turn swaps a box's visual footprint exactly the way
// `rotateSize` swaps width/height, so this reproduces `geometry.imageRect` without a second pixel
// buffer.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  snapMoveToImage,
  snapResizeToImage,
  type FrameRect,
  type ResizeAnchor,
} from '@/domain/edit'
import { getSourceFile } from '@/platform/source-files'
import { t, type MessageKey } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'

/** Frame-pixel nudge steps for arrow-key move/resize (R-K4). Not specified by any design
 * document; chosen as sensible, feel-tuned defaults — see docs/task-notes/T37.md. */
const MOVE_STEP = 2
const MOVE_STEP_COARSE = 20

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
type Corner = (typeof CORNERS)[number]

const OPPOSITE_ANCHOR: Record<Corner, ResizeAnchor> = {
  'top-left': 'bottom-right',
  'top-right': 'bottom-left',
  'bottom-left': 'top-right',
  'bottom-right': 'top-left',
}

const HANDLE_LABELS: Record<Corner, MessageKey> = {
  'top-left': 'edit.frame.handleTopLeft',
  'top-right': 'edit.frame.handleTopRight',
  'bottom-left': 'edit.frame.handleBottomLeft',
  'bottom-right': 'edit.frame.handleBottomRight',
}

const ARROW_DELTAS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

const draft = useEditDraftStore()
const { geometry, quarterTurns, source, currentImageId } = storeToRefs(draft)
const { images } = storeToRefs(useBatchStore())

const image = computed(
  () => images.value.find((candidate) => candidate.id === currentImageId.value) ?? null,
)
const fileName = computed(() => image.value?.name ?? '')

const host = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

function measureHost(): void {
  const element = host.value
  if (element === null) {
    return
  }
  draft.setFrame({ width: element.clientWidth, height: element.clientHeight })
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && host.value !== null) {
    resizeObserver = new ResizeObserver(measureHost)
    resizeObserver.observe(host.value)
  }
  measureHost()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// Object URL lifecycle for the source file (no encode involved, see header comment).
const imageUrl = ref<string | null>(null)
let currentObjectUrl: string | null = null
let sourceGeneration = 0

function revokeCurrentUrl(): void {
  if (currentObjectUrl !== null) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
}

watch(
  currentImageId,
  async (id) => {
    const expected = ++sourceGeneration
    revokeCurrentUrl()
    imageUrl.value = null
    const file = id === null ? undefined : await getSourceFile(id).catch(() => undefined)
    if (sourceGeneration !== expected) return
    if (file === undefined) {
      imageUrl.value = null
      return
    }
    const url = URL.createObjectURL(file)
    currentObjectUrl = url
    imageUrl.value = url
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  sourceGeneration += 1
  revokeCurrentUrl()
})

const resolved = computed(() => {
  const value = geometry.value
  return value.kind === 'resolved' ? value : null
})

const badgeText = computed(() => {
  const value = resolved.value
  if (value === null) {
    return ''
  }
  return t('edit.frame.badge', { width: value.output.size.width, height: value.output.size.height })
})

function px(value: number): string {
  return `${value}px`
}

const imageStyle = computed(() => {
  const value = resolved.value
  if (value === null || source.value.width <= 0 || source.value.height <= 0) {
    return { display: 'none' }
  }

  const centerX = value.imageRect.left + value.imageRect.width / 2
  const centerY = value.imageRect.top + value.imageRect.height / 2
  const unrotatedWidth = source.value.width * value.drawScale
  const unrotatedHeight = source.value.height * value.drawScale

  return {
    left: px(centerX - unrotatedWidth / 2),
    top: px(centerY - unrotatedHeight / 2),
    width: px(unrotatedWidth),
    height: px(unrotatedHeight),
    transform: `rotate(${quarterTurns.value * 90}deg)`,
  }
})

function rectBoxStyle(rect: FrameRect): Record<string, string> {
  return { left: px(rect.left), top: px(rect.top), width: px(rect.width), height: px(rect.height) }
}

const rectStyle = computed(() => (resolved.value === null ? {} : rectBoxStyle(resolved.value.rect)))
const fillStyle = computed(() => rectStyle.value)

const fillColorStyle = computed(() => {
  const { r, g, b, a } = draft.background
  return { backgroundColor: `rgba(${r}, ${g}, ${b}, ${a})` }
})

const darkenStyle = computed(() => {
  const value = resolved.value
  const frameSize = draft.frame

  if (value === null) {
    return { top: {}, bottom: {}, left: {}, right: {} }
  }

  const { rect } = value

  return {
    top: { left: px(0), top: px(0), width: px(frameSize.width), height: px(Math.max(0, rect.top)) },
    bottom: {
      left: px(0),
      top: px(rect.top + rect.height),
      width: px(frameSize.width),
      height: px(Math.max(0, frameSize.height - (rect.top + rect.height))),
    },
    left: {
      left: px(0),
      top: px(rect.top),
      width: px(Math.max(0, rect.left)),
      height: px(rect.height),
    },
    right: {
      left: px(rect.left + rect.width),
      top: px(rect.top),
      width: px(Math.max(0, frameSize.width - (rect.left + rect.width))),
      height: px(rect.height),
    },
  }
})

const stageStyle = computed(() => ({
  width: px(draft.frame.width),
  height: px(draft.frame.height),
}))

interface MoveDrag {
  pointerId: number
  startClientX: number
  startClientY: number
  startRect: FrameRect
}

interface ResizeDrag {
  pointerId: number
  corner: Corner
  startClientX: number
  startClientY: number
  startRect: FrameRect
}

const moveDrag = ref<MoveDrag | null>(null)
const resizeDrag = ref<ResizeDrag | null>(null)

function onRectPointerDown(event: PointerEvent): void {
  if (moveDrag.value !== null || resizeDrag.value !== null) {
    return
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  draft.setDragging(true)
  moveDrag.value = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startRect: draft.displayRect,
  }
}

/** The live image box to snap against, mid-gesture — rotation/zoom don't change during a plain
 * rect drag, so reading it fresh on every move is simplest and always correct. */
function currentImageRect(): FrameRect | null {
  return resolved.value?.imageRect ?? null
}

function snapIfPossible(candidate: FrameRect): FrameRect {
  const imageRect = currentImageRect()
  return imageRect === null ? candidate : snapMoveToImage(candidate, imageRect)
}

function onRectPointerMove(event: PointerEvent): void {
  const drag = moveDrag.value
  if (drag === null || event.pointerId !== drag.pointerId) {
    return
  }
  const dx = event.clientX - drag.startClientX
  const dy = event.clientY - drag.startClientY
  draft.setRectFromMove(
    snapIfPossible({
      left: drag.startRect.left + dx,
      top: drag.startRect.top + dy,
      width: drag.startRect.width,
      height: drag.startRect.height,
    }),
  )
}

function onRectPointerUp(event: PointerEvent): void {
  if (moveDrag.value?.pointerId === event.pointerId) {
    moveDrag.value = null
    draft.setDragging(false)
  }
}

function cornerCandidate(start: FrameRect, corner: Corner, dx: number, dy: number): FrameRect {
  switch (corner) {
    case 'top-left':
      return {
        left: start.left + dx,
        top: start.top + dy,
        width: start.width - dx,
        height: start.height - dy,
      }
    case 'top-right':
      return {
        left: start.left,
        top: start.top + dy,
        width: start.width + dx,
        height: start.height - dy,
      }
    case 'bottom-left':
      return {
        left: start.left + dx,
        top: start.top,
        width: start.width - dx,
        height: start.height + dy,
      }
    case 'bottom-right':
      return {
        left: start.left,
        top: start.top,
        width: start.width + dx,
        height: start.height + dy,
      }
  }
}

function onHandlePointerDown(corner: Corner, event: PointerEvent): void {
  event.stopPropagation()
  if (moveDrag.value !== null || resizeDrag.value !== null) {
    return
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  draft.setDragging(true)
  resizeDrag.value = {
    pointerId: event.pointerId,
    corner,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startRect: draft.displayRect,
  }
}

function onHandlePointerMove(event: PointerEvent): void {
  const drag = resizeDrag.value
  if (drag === null || event.pointerId !== drag.pointerId) {
    return
  }
  const dx = event.clientX - drag.startClientX
  const dy = event.clientY - drag.startClientY
  const anchor = OPPOSITE_ANCHOR[drag.corner]
  const candidate = cornerCandidate(drag.startRect, drag.corner, dx, dy)
  const imageRect = currentImageRect()
  draft.setRectFromResize(
    imageRect === null ? candidate : snapResizeToImage(candidate, anchor, imageRect),
    anchor,
  )
}

function onHandlePointerUp(event: PointerEvent): void {
  if (resizeDrag.value?.pointerId === event.pointerId) {
    resizeDrag.value = null
    draft.setDragging(false)
  }
}

function onRectKeydown(event: KeyboardEvent): void {
  const delta = ARROW_DELTAS[event.key]
  if (delta === undefined) {
    return
  }
  event.preventDefault()
  const step = event.shiftKey ? MOVE_STEP_COARSE : MOVE_STEP
  const rect = draft.displayRect
  draft.setRectFromMove(
    snapIfPossible({
      left: rect.left + delta.dx * step,
      top: rect.top + delta.dy * step,
      width: rect.width,
      height: rect.height,
    }),
  )
}

function onHandleKeydown(corner: Corner, event: KeyboardEvent): void {
  const delta = ARROW_DELTAS[event.key]
  if (delta === undefined) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  const step = event.shiftKey ? MOVE_STEP_COARSE : MOVE_STEP
  const anchor = OPPOSITE_ANCHOR[corner]
  const candidate = cornerCandidate(draft.displayRect, corner, delta.dx * step, delta.dy * step)
  const imageRect = currentImageRect()
  draft.setRectFromResize(
    imageRect === null ? candidate : snapResizeToImage(candidate, anchor, imageRect),
    anchor,
  )
}
</script>

<template>
  <div ref="host" class="edit-frame-host" data-testid="edit-frame-host">
    <div class="edit-stage" :style="stageStyle" data-testid="edit-frame-stage">
      <div class="fill-checkerboard" :style="fillStyle"></div>
      <div class="fill-color" :style="{ ...fillStyle, ...fillColorStyle }"></div>

      <img
        v-if="imageUrl"
        class="edit-image"
        :src="imageUrl"
        :alt="t('edit.frame.imageAlt', { filename: fileName })"
        :style="imageStyle"
        draggable="false"
        data-testid="edit-frame-image"
      />

      <div class="darken" :style="darkenStyle.top"></div>
      <div class="darken" :style="darkenStyle.bottom"></div>
      <div class="darken" :style="darkenStyle.left"></div>
      <div class="darken" :style="darkenStyle.right"></div>

      <div
        v-if="resolved"
        class="crop-rect"
        :style="rectStyle"
        tabindex="0"
        role="group"
        :aria-label="t('edit.frame.rectLabel')"
        data-testid="edit-frame-rect"
        @pointerdown="onRectPointerDown"
        @pointermove="onRectPointerMove"
        @pointerup="onRectPointerUp"
        @pointercancel="onRectPointerUp"
        @keydown="onRectKeydown"
      >
        <span class="badge" data-testid="edit-frame-badge">{{ badgeText }}</span>

        <div
          v-for="corner in CORNERS"
          :key="corner"
          :class="['handle', `handle-${corner}`]"
          tabindex="0"
          role="button"
          :aria-label="t(HANDLE_LABELS[corner])"
          :data-testid="`edit-frame-handle-${corner}`"
          @pointerdown="onHandlePointerDown(corner, $event)"
          @pointermove="onHandlePointerMove"
          @pointerup="onHandlePointerUp"
          @pointercancel="onHandlePointerUp"
          @keydown="onHandleKeydown(corner, $event)"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.edit-frame-host {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-block-size: 0;
  inline-size: 100%;
  overflow: hidden;
}

.edit-stage {
  position: relative;
  overflow: hidden;
  background: var(--color-surface-panel);
  border: 1px solid var(--color-border-group);
}

.fill-checkerboard {
  position: absolute;
  background-image:
    linear-gradient(45deg, #666 25%, transparent 25%, transparent 75%, #666 75%),
    linear-gradient(45deg, #666 25%, transparent 25%, transparent 75%, #666 75%);
  background-size: 12px 12px;
  background-position:
    0 0,
    6px 6px;
  background-color: #1a1a1a;
}

.fill-color {
  position: absolute;
}

.edit-image {
  position: absolute;
  max-inline-size: none;
  max-block-size: none;
}

.darken {
  position: absolute;
  /* Opacity not specified anywhere; a feel-tuned placeholder (docs/task-notes/T37.md). */
  background: rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

.crop-rect {
  position: absolute;
  border: 2px solid var(--color-tint);
  touch-action: none;
  cursor: move;
}

.crop-rect:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.badge {
  position: absolute;
  inset-inline-start: 4px;
  inset-block-start: 4px;
  padding-block: 2px;
  padding-inline: 6px;
  background: rgba(0, 0, 0, 0.65);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-family: var(--font-family-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.handle {
  position: absolute;
  inline-size: 10px;
  block-size: 10px;
  background: var(--color-tint);
  border: 1px solid var(--color-primary);
  border-radius: 2px;
}

.handle::before {
  content: '';
  position: absolute;
  inset: -17px;
}

.handle:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.handle-top-left {
  inset-inline-start: -5px;
  inset-block-start: -5px;
  cursor: nwse-resize;
}

.handle-top-right {
  inset-inline-end: -5px;
  inset-block-start: -5px;
  cursor: nesw-resize;
}

.handle-bottom-left {
  inset-inline-start: -5px;
  inset-block-end: -5px;
  cursor: nesw-resize;
}

.handle-bottom-right {
  inset-inline-end: -5px;
  inset-block-end: -5px;
  cursor: nwse-resize;
}
</style>
