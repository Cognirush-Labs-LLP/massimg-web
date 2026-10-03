import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_CROP_LIMITS,
  aspectRatioFor,
  constrainCropRect,
  cropRectForTypedDimension,
  editOpsFor,
  fitScale,
  geometryEdit,
  hasSpill,
  imageRectInFrame,
  resolveCropGeometry,
  resolveCropInput,
  rotateCropInput,
  rotateSize,
  toFrameRect,
  trailingResizeOp,
  type CropGeometry,
  type CropGeometryInput,
  type FrameRect,
  type PixelSize,
  type QuarterTurns,
  type RatioId,
  type RectAnchor,
  type TypedDimension,
} from '@/domain/edit'
import { isAlphaCapable } from '@/domain/format'
import type { EditOp, EditRecord, ImageId, ImageRecord, Rgba } from '@/domain/types'
import { useBatchStore } from './batch'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

const ZERO_SIZE: PixelSize = { width: 0, height: 0 }
const IDENTITY_RECT: FrameRect = { left: 0, top: 0, width: 0, height: 0 }
const TRANSPARENT_BLACK: Rgba = { r: 0, g: 0, b: 0, a: 0 }
const OPAQUE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const CROP_RECT_EPSILON = 1e-4

function sameOp(a: EditOp, b: EditOp): boolean {
  if (a.kind === 'rotate' && b.kind === 'rotate') {
    return a.quarterTurns === b.quarterTurns
  }

  if (a.kind === 'crop' && b.kind === 'crop') {
    return (
      Math.abs(a.rect.x - b.rect.x) < CROP_RECT_EPSILON &&
      Math.abs(a.rect.y - b.rect.y) < CROP_RECT_EPSILON &&
      Math.abs(a.rect.width - b.rect.width) < CROP_RECT_EPSILON &&
      Math.abs(a.rect.height - b.rect.height) < CROP_RECT_EPSILON &&
      a.zoom === b.zoom &&
      a.background.r === b.background.r &&
      a.background.g === b.background.g &&
      a.background.b === b.background.b &&
      a.background.a === b.background.a
    )
  }

  // Unreachable in practice: `entryOps` has its trailing resize stripped by `geometryEdit` before
  // capture, and `editOpsFor` never emits one, so neither side of this comparison ever carries a
  // `resize` op. Handled anyway so every `EditOp` kind is accounted for.
  return a.kind === 'resize' && b.kind === 'resize' && a.width === b.width && a.height === b.height
}

function sameOps(a: readonly EditOp[], b: readonly EditOp[]): boolean {
  if (a.length !== b.length) {
    return false
  }

  return a.every((opA, index) => {
    const opB = b[index]
    return opB !== undefined && sameOp(opA, opB)
  })
}

/**
 * Edit mode's transient, per-session draft state (Functional Design R-C1-R-C17, R-K4; Technical
 * Design §6; docs/ui-design.md §12). A Pinia store, but not in the "survives a mode switch" sense
 * docs/ui-design.md §4 otherwise means by one: `Edit.vue` and `EditToolbar.vue` are mounted as two
 * independent siblings by `ToolPage.vue` (`STAGE_COMPONENTS.edit` / `STAGE_TOOLBARS.edit`), so
 * neither props/emits nor provide/inject can bridge them — a store is the only mechanism this
 * codebase uses for state reachable from two components that aren't in each other's ancestor
 * chain. `Edit.vue` calls `reset()` in `onBeforeUnmount`, the same way Preview discards its working
 * set on unmount, so nothing here outlives one Edit session.
 */
export const useEditDraftStore = defineStore('edit-draft', () => {
  const currentImageId = ref<ImageId | null>(null)
  const quarterTurns = ref<QuarterTurns>(0)
  // The last rect fed into `resolveCropGeometry`, in frame pixels. Read it through `displayRect`
  // below, not directly: this ref can momentarily hold an out-of-bounds proposal mid-drag, and
  // `displayRect` is always the constrained value every mutation should actually build on.
  const rect = ref<FrameRect>(IDENTITY_RECT)
  const ratioId = ref<RatioId>('free')
  const zoom = ref(1)
  const background = ref<Rgba>(TRANSPARENT_BLACK)
  const frame = ref<PixelSize>(ZERO_SIZE)
  const source = ref<PixelSize>(ZERO_SIZE)

  // Snapshot taken at entry, used only by `apply()`'s "did the crop geometry change" comparison
  // (T36-A's trailing-resize rule): `entryOps` is the rotate/crop portion with any trailing
  // recovery resize already stripped, `entryTrailingResize` that resize if there was one.
  const entryOps = ref<EditOp[]>([])
  const entryTrailingResize = ref<Extract<EditOp, { kind: 'resize' }> | null>(null)
  const entryVersion = ref(0)

  const input = computed<CropGeometryInput>(() => ({
    source: source.value,
    quarterTurns: quarterTurns.value,
    frame: frame.value,
    zoom: zoom.value,
    rect: rect.value,
    ratio: aspectRatioFor(ratioId.value),
    limits: DEFAULT_CROP_LIMITS,
  }))

  const geometry = computed<CropGeometry>(() => resolveCropGeometry(input.value))

  /** The authoritative, constrained rect every mutation and every render should read. */
  const displayRect = computed<FrameRect>(() => {
    const resolved = geometry.value
    return resolved.kind === 'resolved' ? resolved.rect : rect.value
  })

  const showsBackgroundRow = computed(() => {
    const resolved = geometry.value
    return resolved.kind === 'resolved' && hasSpill(resolved.output.spill)
  })

  const BACKGROUND_ROW_DEBOUNCE_MS = 1000
  // True for the duration of a pointer drag/resize gesture on the crop rectangle (set by
  // `EditFrame.vue`). While true, `visibleBackgroundRow` below is frozen at whatever it already
  // shows, rather than reacting to every intermediate position the gesture passes through.
  const dragging = ref(false)
  /**
   * What `EditBackgroundRow.vue` actually mounts on — never `showsBackgroundRow` directly. The
   * background row has real layout height, and Edit's stage is a flex column, so mounting it
   * mid-drag shrinks the measured frame height *while a gesture is still computing deltas against
   * the old one* — one raw geometry change feeding back into another, mid-gesture. Frozen while
   * `dragging` is true, and debounced by `BACKGROUND_ROW_DEBOUNCE_MS` once it ends, so the row
   * only ever changes after the user has settled on a position. See docs/task-notes/T37.md,
   * Surprises.
   */
  const visibleBackgroundRow = ref(false)
  let backgroundRowTimer: ReturnType<typeof setTimeout> | null = null

  function clearBackgroundRowTimer(): void {
    if (backgroundRowTimer !== null) {
      clearTimeout(backgroundRowTimer)
      backgroundRowTimer = null
    }
  }

  watch([showsBackgroundRow, dragging], ([shouldShow, isDragging]) => {
    clearBackgroundRowTimer()

    if (isDragging) {
      return
    }

    backgroundRowTimer = setTimeout(() => {
      visibleBackgroundRow.value = shouldShow
      backgroundRowTimer = null
    }, BACKGROUND_ROW_DEBOUNCE_MS)
  })

  function setDragging(value: boolean): void {
    dragging.value = value
  }

  const hasStoredEdit = computed(
    () => entryOps.value.length > 0 || entryTrailingResize.value !== null,
  )

  function currentDrawScale(): number {
    const resolved = geometry.value
    if (resolved.kind === 'resolved') {
      return resolved.drawScale
    }
    return fitScale(rotateSize(source.value, quarterTurns.value), frame.value) * zoom.value
  }

  /**
   * Seeds the draft from an image entering Edit mode. Ratio is never read from the stored edit —
   * `EditOp['crop']` has no ratio field at all, since a locked ratio is pure interface state that
   * is never persisted per-image (R-C11 only means anything if it instead persists across images
   * for the session; see `useUiStore().editRatioPreference`).
   */
  function initFor(image: ImageRecord, hostSize: PixelSize): void {
    const uiStore = useUiStore()

    currentImageId.value = image.id
    source.value = { width: image.width, height: image.height }
    frame.value = hostSize
    ratioId.value = uiStore.editRatioPreference

    const geometryOnly = geometryEdit(image.edit)
    entryOps.value = geometryOnly?.ops ?? []
    entryTrailingResize.value = trailingResizeOp(image.edit?.ops ?? [])
    entryVersion.value = image.edit?.version ?? 0

    const rotateOp = entryOps.value.find(
      (op): op is Extract<EditOp, { kind: 'rotate' }> => op.kind === 'rotate',
    )
    const cropOp = entryOps.value.find(
      (op): op is Extract<EditOp, { kind: 'crop' }> => op.kind === 'crop',
    )
    const turns = rotateOp?.quarterTurns ?? 0

    quarterTurns.value = turns

    if (cropOp !== undefined) {
      zoom.value = cropOp.zoom
      background.value = cropOp.background
      const rotatedSource = rotateSize(source.value, turns)
      const drawScale = fitScale(rotatedSource, hostSize) * cropOp.zoom
      const imageRect = imageRectInFrame(rotatedSource, hostSize, drawScale)
      rect.value = toFrameRect(cropOp.rect, imageRect)
    } else {
      const defaults = resolveCropInput({
        source: source.value,
        frame: hostSize,
        quarterTurns: turns,
        ratio: aspectRatioFor(ratioId.value),
        limits: DEFAULT_CROP_LIMITS,
      })
      zoom.value = defaults.zoom
      rect.value = defaults.rect
      // R-C13/R-C14: default fill is fully transparent when the effective format supports alpha,
      // otherwise opaque white (mirrors R-C17's white fallback used elsewhere for an undisclosed
      // flatten). Live gating of the Transparent swatch itself happens in EditBackgroundRow.vue —
      // this only decides the *starting* value for a fresh (not re-opened) edit.
      background.value = isAlphaCapable(
        image.sourceFormat,
        image.isAnimated,
        useSettingsStore().format,
      )
        ? TRANSPARENT_BLACK
        : OPAQUE_WHITE
    }

    // Bypasses the debounce on entry: a reopened edit that already spills should show the row
    // immediately, not a second after the frame first paints.
    clearBackgroundRowTimer()
    dragging.value = false
    visibleBackgroundRow.value = showsBackgroundRow.value
  }

  function reset(): void {
    clearBackgroundRowTimer()
    dragging.value = false
    visibleBackgroundRow.value = false
    currentImageId.value = null
    quarterTurns.value = 0
    rect.value = IDENTITY_RECT
    ratioId.value = 'free'
    zoom.value = 1
    background.value = TRANSPARENT_BLACK
    frame.value = ZERO_SIZE
    source.value = ZERO_SIZE
    entryOps.value = []
    entryTrailingResize.value = null
    entryVersion.value = 0
  }

  /**
   * Updates the measured host size, re-anchoring the rect so it keeps selecting the same
   * fraction of the (rotated) source rather than silently reinterpreting its raw frame-pixel
   * coordinates under a different frame. Without this, any frame-size change that happens after
   * `initFor` — a genuine window resize mid-edit, but also just the toolbar reflowing once
   * `EditToolbar.vue` renders its Remove-edit button a tick after `EditFrame.vue`'s own first
   * `ResizeObserver` measurement — would leave the crop silently drifted (see docs/task-notes/T37.md,
   * Surprises).
   */
  function setFrame(size: PixelSize): void {
    const previous = geometry.value
    frame.value = size

    // Guards against a transient zero/invalid measurement (a host briefly at `clientWidth: 0`
    // before layout, which a test environment can report persistently rather than for one tick)
    // corrupting the rect into a degenerate value that the *next*, valid measurement can no
    // longer recover from — `previous.kind` would already read 'unresolvable' by then, since it,
    // too, is derived from this same (by-then-corrupted) `frame.value`.
    if (previous.kind !== 'resolved' || size.width <= 0 || size.height <= 0) {
      return
    }

    const rotatedSource = rotateSize(source.value, quarterTurns.value)
    const drawScale = fitScale(rotatedSource, size) * zoom.value
    const imageRect = imageRectInFrame(rotatedSource, size, drawScale)
    rect.value = toFrameRect(previous.normalisedRect, imageRect)
  }

  /** Quarter-turn rotate + reset the crop to the fit point (R-C3). */
  function rotate(delta: QuarterTurns): void {
    const next = rotateCropInput(input.value, delta)
    quarterTurns.value = next.quarterTurns
    rect.value = next.rect
    zoom.value = next.zoom
  }

  function setRatio(id: RatioId): void {
    ratioId.value = id
    useUiStore().setEditRatioPreference(id)
  }

  /** Zoom intentionally does not rescale the rect — a fixed rect under a changed zoom is exactly
   * what makes zooming change the output size (R-C7). */
  function setZoom(value: number): void {
    zoom.value = value
  }

  function setBackground(value: Rgba): void {
    background.value = value
  }

  function setTypedDimension(typed: TypedDimension): void {
    rect.value = cropRectForTypedDimension({ ...input.value, rect: displayRect.value }, typed)
  }

  /** A position-only move: `resolveCropGeometry`'s own centre-anchored constraint reduces to a
   * plain positional clamp when width/height are unchanged. */
  function setRectFromMove(candidate: FrameRect): void {
    rect.value = candidate
  }

  /** The one call site that must constrain with the real drag/resize anchor directly, since
   * `resolveCropGeometry` always anchors at the centre internally. */
  function setRectFromResize(candidate: FrameRect, anchor: RectAnchor): void {
    rect.value = constrainCropRect(candidate, {
      frame: frame.value,
      drawScale: currentDrawScale(),
      ratio: aspectRatioFor(ratioId.value),
      limits: DEFAULT_CROP_LIMITS,
      anchor,
    })
  }

  /**
   * Stores the current rotation + crop as this image's edit (R-C4: a rotate-only edit is still
   * real and storable). Applying changed crop geometry drops any prior recovery resize; applying
   * with the geometry unchanged from entry preserves it (T36-A).
   */
  function apply(): void {
    const resolved = geometry.value
    const id = currentImageId.value

    if (resolved.kind !== 'resolved' || id === null) {
      return
    }

    // A Pinia `ref<Rgba>`'s `.value` getter returns a reactive Proxy wrapping the object (Vue's
    // `ref()` reactifies object values on read); `useBatchStore().updateImage` strips this (and
    // any reactivity nested inside `entryTrailingResize`) before the edit re-enters the store, so
    // this doesn't need to happen here too — see `batch.ts`'s `sanitizedEdit` and
    // docs/task-notes/T37.md, Surprises.
    const newOps = editOpsFor(resolved, zoom.value, background.value)
    const geometryChanged = !sameOps(newOps, entryOps.value)
    const finalOps =
      !geometryChanged && entryTrailingResize.value !== null
        ? [...newOps, entryTrailingResize.value]
        : newOps

    const nextEdit: EditRecord | null =
      finalOps.length === 0 ? null : { ops: finalOps, version: entryVersion.value + 1 }

    useBatchStore().updateImage(id, { edit: nextEdit })
    useUiStore().closeEdit()
  }

  /**
   * Restores rotation, crop rect, locked ratio, zoom and background to their values on entering
   * Edit mode (R-C10). Correct by construction, not by explicit restore logic: no store write
   * happens anywhere else during an Edit session, so the stored `ImageRecord.edit` — including any
   * trailing recovery resize — was simply never touched.
   */
  function cancel(): void {
    useUiStore().closeEdit()
  }

  function remove(): void {
    const id = currentImageId.value

    if (id === null) {
      return
    }

    useBatchStore().updateImage(id, { edit: null })
    useUiStore().closeEdit()
  }

  return {
    currentImageId,
    quarterTurns,
    ratioId,
    zoom,
    background,
    frame,
    source,
    geometry,
    displayRect,
    showsBackgroundRow,
    visibleBackgroundRow,
    hasStoredEdit,
    initFor,
    reset,
    setFrame,
    setDragging,
    rotate,
    setRatio,
    setZoom,
    setBackground,
    setTypedDimension,
    setRectFromMove,
    setRectFromResize,
    apply,
    cancel,
    remove,
  }
})

export type EditDraftStore = ReturnType<typeof useEditDraftStore>
