<script setup lang="ts">
// The Preview stage frame (R-P1, R-P4, R-P6, R-P8, R-I16; docs/ui-design.md §11, §14).
//
// Two things it must get right structurally:
//
//   - **The encoded bytes go straight into an `<img>`**, never through a canvas, so the browser
//     applies the embedded colour profile itself and the preview matches the downloaded file
//     (R-I16). The same element plays an animated result on both tabs (R-P8) for free, which a
//     canvas would have cost a frame scheduler to reproduce.
//   - **The frame box starts as a tight contain-fit rectangle** (R-P6): the host area is measured,
//     the frame takes the active image's aspect ratio inside it capped at the image's own pixel size
//     (never upscaled — `restBoxSize`), and the image is positioned within the frame by
//     `resolveViewportFrameRect`. As the user zooms in, the frame itself grows toward the full host
//     area (`resolveViewportBox`) rather than staying pinned at rest size. A crop changes the
//     *active* aspect, so flipping tabs can change the frame's shape — which is the honest thing for
//     it to do.
//
// Zoom and pan are direct manipulation only, by the user's own decision: wheel or pinch to zoom
// about the pointer, drag to pan, no slider and no toolbar chrome. The arithmetic is all in
// `domain/viewport.ts`; this component converts pointer events into frame points and nothing else.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n/t'
import type { PixelSize } from '@/domain/edit'
import {
  clampViewportScale,
  panViewport,
  resolveViewportBox,
  resolveViewportFrameRect,
  restBoxSize,
  zoomViewportAt,
  type FramePoint,
} from '@/domain/viewport'
import type { EditRecord, EncodableFormat, ImageId } from '@/domain/types'
import LoadingStatus from './LoadingStatus.vue'
import { usePreviewViewport, type ComparisonTab } from './usePreviewViewport'
import type { PreviewEncodeError, PreviewPhase } from './usePreviewEncode'

const props = defineProps<{
  imageId: ImageId | null
  fileName: string
  edit: EditRecord | null
  tab: ComparisonTab
  phase: PreviewPhase
  compressedUrl: string | null
  originalUrl: string | null
  originalUnrenderable: boolean
  error: PreviewEncodeError | null
  /**
   * The output size the current settings predict, used only to give the "Creating preview" box the
   * right shape before the result exists, so the frame does not jump when it arrives.
   */
  placeholderSize: PixelSize | null
}>()

const emit = defineEmits<{ retry: []; 'original-unrenderable': [] }>()

/**
 * Wheel zoom sensitivity, per pixel of normalised wheel delta, and the stronger factor for a
 * trackpad pinch (which arrives as a ctrl-modified wheel event with much smaller deltas). Neither
 * figure is specified anywhere — they are feel-tuned placeholders.
 */
const WHEEL_ZOOM_PER_PIXEL = 0.002
const PINCH_ZOOM_PER_PIXEL = 0.01
/** `deltaMode` normalisation: Firefox reports lines rather than pixels for a mouse wheel. */
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 400

const FORMAT_DISPLAY_NAME: Record<EncodableFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
  avif: 'AVIF',
  gif: 'GIF',
}

const host = ref<HTMLElement | null>(null)
const frame = ref<HTMLElement | null>(null)
const hostSize = ref<PixelSize>({ width: 0, height: 0 })
const originalNatural = ref<PixelSize | null>(null)
const compressedNatural = ref<PixelSize | null>(null)
const dragging = ref(false)

let resizeObserver: ResizeObserver | null = null
/**
 * A pointer's raw client position — deliberately not a `FramePoint`, and not assignable to one
 * (`clientX`/`clientY` rather than `left`/`top`, the same device `FramePoint`'s own doc comment
 * uses). The frame's own box can now resize between two pointers' events (it depends on zoom
 * scale), so a point already converted into frame space at one pointer's last event can go stale
 * relative to the frame space another pointer's event just caused it to resize into. Client
 * coordinates have no such staleness — the real viewport doesn't move — so each pointer's position
 * is kept in client space and converted into frame space fresh, once, only at the point of use (the
 * pinch midpoint passed to `zoomViewportAt`; a pan delta needs no conversion at all, since the
 * difference between two client points equals the difference between their frame-space equivalents
 * regardless of any resize in between — translation cancels out of a subtraction).
 */
interface ClientPoint {
  clientX: number
  clientY: number
}

const activePointers = new Map<number, ClientPoint>()
let pinchDistance: number | null = null

const viewport = usePreviewViewport({
  imageId: computed(() => props.imageId),
  edit: computed(() => props.edit),
  tab: computed(() => props.tab),
})

const showsOriginal = computed(() => props.tab === 'original')

/** What the active tab has to draw, or `null` when the frame is showing a state instead. */
const activeUrl = computed<string | null>(() => {
  if (showsOriginal.value) {
    return props.originalUnrenderable ? null : props.originalUrl
  }

  return props.phase === 'ready' ? props.compressedUrl : null
})

const naturalSize = computed<PixelSize | null>(() =>
  showsOriginal.value ? originalNatural.value : compressedNatural.value,
)

/**
 * Rest-state contain-fit of the active image inside the measured host (R-P6), capped at the image's
 * own pixel size so it is never upscaled. Falls back to the predicted output size while an encode is
 * running, and to the host itself when neither is known yet, so the state text always has somewhere
 * to sit.
 */
const restBox = computed<PixelSize | null>(() => {
  if (hostSize.value.width <= 0 || hostSize.value.height <= 0) {
    return null
  }

  const basis = naturalSize.value ?? props.placeholderSize

  if (basis === null || basis.width <= 0 || basis.height <= 0) {
    return hostSize.value
  }

  return restBoxSize(basis, hostSize.value)
})

/**
 * The frame's actual CSS box: `restBox` at rest, growing toward the host area as the user zooms in
 * (`resolveViewportBox`). Must read the current scale — this is what makes zooming use the host's
 * available space rather than clipping within a box frozen at rest size.
 */
const frameSize = computed<PixelSize | null>(() => {
  const box = restBox.value

  if (box === null) {
    return null
  }

  // Clamped the same way `resolveViewportFrameRect` clamps internally, so this box and the image
  // rect placed inside it (`imageRect`, below) can never disagree about which scale is current.
  return resolveViewportBox(box, hostSize.value, clampViewportScale(viewport.local.value.scale))
})

const imageRect = computed(() => {
  const box = restBox.value

  if (box === null) {
    return null
  }

  return resolveViewportFrameRect(box, hostSize.value, viewport.local.value)
})

const zoomed = computed(() => viewport.zoomed.value)

const frameStyle = computed(() =>
  frameSize.value === null
    ? {}
    : { inlineSize: `${frameSize.value.width}px`, blockSize: `${frameSize.value.height}px` },
)

// Physical `left`/`top` deliberately, not logical insets: this is a geometric placement inside a
// clipping box, measured from the frame's top-left corner in both writing directions, rather than a
// layout decision that should mirror in a right-to-left locale (R-L4 governs the latter).
const imageStyle = computed(() => {
  const rect = imageRect.value

  if (rect === null) {
    return { inset: '0', inlineSize: '100%', blockSize: '100%' }
  }

  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
})

const canInspect = computed(
  () => viewport.interactive.value && naturalSize.value !== null && restBox.value !== null,
)

const altText = computed(() =>
  showsOriginal.value
    ? t('preview.frame.altOriginal', { filename: props.fileName })
    : t('preview.frame.altCompressed', { filename: props.fileName }),
)

const errorMessage = computed(() => {
  const failure = props.error

  if (failure === null) {
    return null
  }

  switch (failure.kind) {
    case 'decode-failed':
      return t('preview.error.decode', { filename: props.fileName })
    case 'encode-failed':
      return t('preview.error.encode', { filename: props.fileName })
    case 'out-of-memory':
      return t('preview.error.memory', { filename: props.fileName })
    case 'unsupported':
      return t('preview.error.unsupported', {
        filename: props.fileName,
        format: FORMAT_DISPLAY_NAME[failure.format],
      })
    case 'animated-avif':
      return t('preview.error.animatedAvif', { filename: props.fileName })
    case 'source-missing':
      return t('preview.error.sourceMissing', { filename: props.fileName })
    default: {
      const unknown: never = failure
      throw new Error(`unhandled preview failure: ${JSON.stringify(unknown)}`)
    }
  }
})

/** Retrying cannot change the outcome for an input that has no encoder at all. */
const retryable = computed(() => props.error !== null && props.error.kind !== 'animated-avif')

const showsError = computed(() => !showsOriginal.value && props.phase === 'error')
const showsCreating = computed(() => !showsOriginal.value && props.phase === 'encoding')

/** R-K5: the encode starting, finishing or failing is otherwise a purely visual change. */
const announcement = computed(() => {
  if (props.phase === 'encoding') {
    return t('preview.frame.creating')
  }

  if (props.phase === 'ready') {
    return t('preview.frame.ready')
  }

  return errorMessage.value ?? ''
})

function measureHost(): void {
  const element = host.value

  if (element === null) {
    return
  }

  hostSize.value = { width: element.clientWidth, height: element.clientHeight }
}

function onImageLoad(event: Event): void {
  const image = event.target as HTMLImageElement
  const size = { width: image.naturalWidth, height: image.naturalHeight }

  if (showsOriginal.value) {
    originalNatural.value = size
  } else {
    compressedNatural.value = size
  }
}

function onImageError(): void {
  if (showsOriginal.value) {
    emit('original-unrenderable')
  }
}

function framePoint(
  event: { clientX: number; clientY: number },
  box: DOMRect | null,
): FramePoint | null {
  if (box === null) {
    return null
  }

  return { left: event.clientX - box.left, top: event.clientY - box.top }
}

function normalisedWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === 1) {
    return event.deltaY * PIXELS_PER_LINE
  }

  if (event.deltaMode === 2) {
    return event.deltaY * PIXELS_PER_PAGE
  }

  return event.deltaY
}

function onWheel(event: WheelEvent): void {
  const box = restBox.value

  if (!canInspect.value || box === null) {
    return
  }

  // Not passive: the page must not scroll while the pointer is over the inspector.
  event.preventDefault()

  const point = framePoint(event, frame.value?.getBoundingClientRect() ?? null)

  if (point === null) {
    return
  }

  const perPixel = event.ctrlKey ? PINCH_ZOOM_PER_PIXEL : WHEEL_ZOOM_PER_PIXEL
  const factor = Math.exp(-normalisedWheelDelta(event) * perPixel)
  const current = viewport.local.value

  viewport.setLocal(zoomViewportAt(box, hostSize.value, current, point, current.scale * factor))
}

/**
 * The distance and midpoint between the two active pointers, in client space — resize-invariant,
 * so this needs no frame measurement at all. Only `distance`'s *ratio* across two calls and the
 * midpoint's eventual frame-space conversion (`onPointerMove`, where it's actually used) are
 * meaningful; both are unaffected by computing it in client rather than frame coordinates, since
 * the two spaces differ only by a translation that cancels out of a difference.
 */
function pinchState(): { distance: number; midpoint: ClientPoint } | null {
  const [first, second] = [...activePointers.values()]

  if (first === undefined || second === undefined) {
    return null
  }

  const dx = second.clientX - first.clientX
  const dy = second.clientY - first.clientY

  return {
    distance: Math.hypot(dx, dy),
    midpoint: { clientX: first.clientX + dx / 2, clientY: first.clientY + dy / 2 },
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!canInspect.value) {
    return
  }

  activePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
  frame.value?.setPointerCapture(event.pointerId)
  dragging.value = true
  pinchDistance = pinchState()?.distance ?? null
}

function onPointerMove(event: PointerEvent): void {
  const previous = activePointers.get(event.pointerId)
  const box = restBox.value

  if (previous === undefined || box === null) {
    return
  }

  const current: ClientPoint = { clientX: event.clientX, clientY: event.clientY }
  activePointers.set(event.pointerId, current)

  const pinch = activePointers.size >= 2 ? pinchState() : null

  if (pinch !== null && pinchDistance !== null && pinchDistance > 0 && pinch.distance > 0) {
    // The one place a frame-space point is actually needed, so it's the one place a frame
    // measurement happens — fresh, for this event only, never stored.
    const midpoint = framePoint(pinch.midpoint, frame.value?.getBoundingClientRect() ?? null)

    if (midpoint === null) {
      return
    }

    const factor = pinch.distance / pinchDistance
    const viewportCurrent = viewport.local.value

    pinchDistance = pinch.distance
    viewport.setLocal(
      zoomViewportAt(box, hostSize.value, viewportCurrent, midpoint, viewportCurrent.scale * factor),
    )
    return
  }

  viewport.setLocal(
    panViewport(box, hostSize.value, viewport.local.value, {
      left: current.clientX - previous.clientX,
      top: current.clientY - previous.clientY,
    }),
  )
}

function onPointerUp(event: PointerEvent): void {
  activePointers.delete(event.pointerId)

  if (activePointers.size < 2) {
    pinchDistance = null
  }

  if (activePointers.size === 0) {
    dragging.value = false
  }
}

// A new raster means a new natural size: a dimension rule or a crop changes the compressed output's
// own pixel size, and the frame must not keep sizing itself from the previous one.
watch(
  () => props.compressedUrl,
  () => {
    compressedNatural.value = null
  },
)

watch(
  () => props.originalUrl,
  () => {
    originalNatural.value = null
  },
)

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && host.value !== null) {
    // Same guard as GalleryGrid.vue: vite-ssg renders this component once in Node, and jsdom has no
    // ResizeObserver either. Observing the host rather than the frame, because the frame's own size
    // is set by this callback's own result.
    resizeObserver = new ResizeObserver(measureHost)
    resizeObserver.observe(host.value)
  }

  measureHost()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// Exposed for the component test, which drives the viewport directly rather than synthesising a
// wheel gesture against a layout jsdom does not have.
defineExpose({ viewport })
</script>

<template>
  <div ref="host" class="frame-host" data-testid="preview-frame-host">
    <div
      ref="frame"
      class="frame"
      :class="{ grabbable: canInspect && zoomed, grabbing: dragging }"
      :style="frameStyle"
      data-testid="preview-frame"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img
        v-if="activeUrl"
        :key="activeUrl"
        class="frame-image"
        :src="activeUrl"
        :alt="altText"
        :style="imageStyle"
        draggable="false"
        data-testid="preview-image"
        :data-tab="tab"
        @load="onImageLoad"
        @error="onImageError"
      />

      <LoadingStatus
        v-if="showsCreating"
        class="frame-state"
        :message="t('preview.frame.creating')"
        data-testid="preview-creating"
      />

      <div v-else-if="showsError" class="frame-state frame-error" data-testid="preview-error">
        <p class="error-message">{{ errorMessage }}</p>
        <button
          v-if="retryable"
          type="button"
          class="retry-button"
          data-testid="preview-retry"
          @click="emit('retry')"
        >
          {{ t('preview.error.retry') }}
        </button>
      </div>

      <p
        v-else-if="showsOriginal && originalUnrenderable"
        class="frame-state"
        data-testid="preview-original-unavailable"
      >
        {{ t('preview.frame.originalUnavailable', { filename: fileName }) }}
      </p>
    </div>

    <p class="announcement" role="status" aria-live="polite">{{ announcement }}</p>
  </div>
</template>

<style scoped>
.frame-host {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-block-size: 0;
  inline-size: 100%;
  overflow: hidden;
}

.frame {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  max-inline-size: 100%;
  max-block-size: 100%;
  overflow: hidden;
  background: var(--color-surface-panel);
  border: 1px solid var(--color-border-group);
  /* No border-radius: the preview must show the image's actual corners, not rounded ones, so the
     user sees exactly what the file contains. */
  /* The inspector handles its own gestures, so the browser must not also pan or zoom the page from
     a drag that starts here. */
  touch-action: none;
  user-select: none;
}

.frame.grabbable {
  cursor: grab;
}

.frame.grabbing {
  cursor: grabbing;
}

.frame-image {
  position: absolute;
  /* base.css caps every image at 100% of its container; a zoomed image is deliberately wider than
     the frame it is clipped by, so that cap is lifted here and nowhere else. */
  max-inline-size: none;
  max-block-size: none;
  object-fit: contain;
}

.frame-state {
  margin: 0;
  padding-inline: 18px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-align: center;
}

.frame-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.error-message {
  margin: 0;
  color: var(--color-primary);
  font-family: var(--font-family-display);
  font-size: 13px;
  line-height: 1.45;
  max-inline-size: 42ch;
}

.retry-button {
  min-block-size: 36px;
  padding-block: 7px;
  padding-inline: 14px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 12.5px;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

/* Visually hidden, still announced (R-K5). No such utility class exists globally yet; T38's run
   progress will want the same thing and should promote this rather than copy it. */
.announcement {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
