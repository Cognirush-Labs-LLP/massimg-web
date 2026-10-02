// Preview's inspector state (T36): one canonical viewport, projected into whichever tab is showing.
//
// This composable owns *when* the viewport changes and *which space* a value is in. All of the
// arithmetic lives in `domain/viewport.ts`, and the frame component owns the pointer events — so the
// three concerns stay separable: the maths is unit-testable without a DOM, this is testable without
// pointer events, and the component has no coordinate conversions in it at all.
//
// **Persistence, confirmed with the user, is the point of the whole feature:** the viewport survives
// a settings-driven re-encode of the same image, so quality can be tuned while looking at one
// detail, and resets when stepping to a different image, where a remembered corner would be
// meaningless. The one other thing that moves it is the stored rotation changing, which redefines
// the canonical space itself — the stored point is re-expressed rather than reset, so the user keeps
// looking at the same patch. That path is unreachable today (Edit is a separate stage mode, so
// entering it unmounts Preview and returning mounts a fresh one), and exists so that a future
// in-place edit cannot silently reinterpret the viewport.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  DEFAULT_VIEWPORT,
  projectViewportToCompressed,
  projectViewportToOriginal,
  rotateViewportBetweenQuarterTurns,
  unprojectViewportFromCompressed,
  unprojectViewportFromOriginal,
  viewportEditGeometry,
  type InspectorViewport,
  type ViewportEditGeometry,
} from '@/domain/viewport'
import type { QuarterTurns } from '@/domain/edit'
import type { EditRecord, ImageId } from '@/domain/types'

export type ComparisonTab = 'original' | 'compressed'

export interface PreviewViewportOptions {
  imageId: Ref<ImageId | null>
  edit: Ref<EditRecord | null>
  tab: Ref<ComparisonTab>
}

export interface PreviewViewport {
  /** Fractions of the rotated, uncropped source. Replaced, never mutated. */
  canonical: Ref<InspectorViewport>
  /** The same viewport in the active tab's own space, which is what the frame renders with. */
  local: ComputedRef<InspectorViewport>
  /** False when the stored edit cannot be projected, so the frame leaves its gestures unbound. */
  interactive: ComputedRef<boolean>
  /** Whether the user has zoomed in at all — the frame reads this for its cursor and touch rules. */
  zoomed: ComputedRef<boolean>
  /** Writes back a viewport that is already in the active tab's space. */
  setLocal: (next: InspectorViewport) => void
  reset: () => void
}

function isFinitePoint(viewport: InspectorViewport): boolean {
  return (
    Number.isFinite(viewport.center.x) &&
    Number.isFinite(viewport.center.y) &&
    Number.isFinite(viewport.scale)
  )
}

export function usePreviewViewport(options: PreviewViewportOptions): PreviewViewport {
  const canonical = ref<InspectorViewport>(DEFAULT_VIEWPORT)
  const geometry = computed<ViewportEditGeometry>(() => viewportEditGeometry(options.edit.value))

  const local = computed<InspectorViewport>(() => {
    const current = geometry.value

    if (current.kind !== 'projectable') {
      return DEFAULT_VIEWPORT
    }

    return options.tab.value === 'original'
      ? projectViewportToOriginal(canonical.value, current.quarterTurns)
      : projectViewportToCompressed(canonical.value, current.cropRect)
  })

  function reset(): void {
    canonical.value = DEFAULT_VIEWPORT
  }

  function setLocal(next: InspectorViewport): void {
    const current = geometry.value

    if (current.kind !== 'projectable' || !isFinitePoint(next)) {
      return
    }

    canonical.value =
      options.tab.value === 'original'
        ? unprojectViewportFromOriginal(next, current.quarterTurns)
        : unprojectViewportFromCompressed(next, current.cropRect)
  }

  const storedQuarterTurns = computed<QuarterTurns | null>(() =>
    geometry.value.kind === 'projectable' ? geometry.value.quarterTurns : null,
  )

  watch([options.imageId, storedQuarterTurns], ([imageId, turns], previous) => {
    const [previousImageId, previousTurns] = previous ?? [null, null]

    if (imageId !== previousImageId) {
      // R-P7 steps to a different image: a remembered corner of the previous photograph says
      // nothing about this one. The comparison tab is deliberately *not* reset with it.
      reset()
      return
    }

    if (turns !== previousTurns && turns !== null && previousTurns !== null) {
      canonical.value = rotateViewportBetweenQuarterTurns(canonical.value, previousTurns, turns)
    }
  })

  return {
    canonical,
    local,
    interactive: computed(() => geometry.value.kind === 'projectable'),
    zoomed: computed(() => local.value.scale > 1),
    setLocal,
    reset,
  }
}
