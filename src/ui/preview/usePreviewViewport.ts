// Preview's inspector state (T36): one canonical viewport, projected into whichever tab is showing.
//
// This composable owns *when* the viewport changes and *which space* a value is in. All of the
// arithmetic lives in `domain/viewport.ts`, and the frame component owns the pointer events — so the
// three concerns stay separable: the maths is unit-testable without a DOM, this is testable without
// pointer events, and the component has no coordinate conversions in it at all.
//
// **Persistence, confirmed with the user, is the point of the whole feature:** the viewport survives
// a settings-driven re-encode of the same image (barring the forced jump to Compressed's own actual
// size that a regenerate now triggers elsewhere — see `Preview.vue`'s `regenerateToken` watcher),
// and resets when stepping to a different image, where a remembered corner would be meaningless. The
// one other thing that moves it is the stored rotation changing, which redefines the canonical space
// itself — the stored point is re-expressed rather than reset, so the user keeps looking at the same
// patch. That path is unreachable today (Edit is a separate stage mode, so entering it unmounts
// Preview and returning mounts a fresh one), and exists so that a future in-place edit cannot
// silently reinterpret the viewport.

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
  type ViewportTabSizes,
} from '@/domain/viewport'
import type { QuarterTurns } from '@/domain/edit'
import type { EditRecord, ImageId } from '@/domain/types'

export type ComparisonTab = 'original' | 'compressed'

export interface PreviewViewportOptions {
  imageId: Ref<ImageId | null>
  edit: Ref<EditRecord | null>
  tab: Ref<ComparisonTab>
  /** Both tabs' best-available restBox/natural sizes, for the Compressed-side scale conversion. */
  tabSizes: Ref<ViewportTabSizes | null>
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

/**
 * Stands in for `tabSizes` before both tabs have at least a placeholder estimate. Deliberately
 * unusable (zero) rather than a guess, so `domain/viewport.ts`'s own "not usable yet" guard falls
 * back to a plain scale passthrough instead of this composable needing its own fallback branch.
 */
const UNUSABLE_TAB_SIZES: ViewportTabSizes = {
  original: { restBox: { width: 0, height: 0 }, natural: { width: 0, height: 0 } },
  compressed: { restBox: { width: 0, height: 0 }, natural: { width: 0, height: 0 } },
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
      : projectViewportToCompressed(
          canonical.value,
          current.cropRect,
          current.quarterTurns,
          options.tabSizes.value ?? UNUSABLE_TAB_SIZES,
        )
  })

  /**
   * Whether `canonical` is still the untouched rest default from the last reset, with no real
   * interaction and no tab-aware anchor written yet. Plain closure state, not a ref: `canonical`'s
   * own identity can't be used for this (Vue wraps an object `ref`'s value in a reactive proxy, so
   * `canonical.value === DEFAULT_VIEWPORT` is never true even right after `canonical.value =
   * DEFAULT_VIEWPORT`), and this needs no DOM/render reactivity of its own — only the explicit calls
   * below ever read or write it.
   */
  let pristine = true

  /**
   * Commits "rest" into canonical the first moment both tabs' sizes are known, anchored to
   * whichever tab is active *right now*. Writing `DEFAULT_VIEWPORT` into canonical directly — the
   * pre-R-P9 behaviour — would instead mean "Original's fit, translated": since canonical is pinned
   * to Original's convention, reading `scale: 1` back on Compressed would density-convert it as if
   * it already were Original's own rest state, producing the wrong percentage the instant Compressed
   * doesn't need the same fit-shrink Original does. Anchoring through the same unproject the active
   * tab's own gestures use guarantees the active tab round-trips to exactly `DEFAULT_VIEWPORT` on
   * read, while the *other* tab correctly shows the density-equivalent — which is what makes R-P9
   * hold from the very first, unzoomed view, not only after a deliberate zoom.
   *
   * Idempotent via `pristine`: both tabs' sizes are not usually known the instant `reset()` runs
   * (the frame's host is measured by a `ResizeObserver` callback that fires after mount, not before),
   * so this is called again whenever `tabSizes` changes and only actually commits once per reset —
   * never once a real interaction (`setLocal`) has happened, and never a second time after it has
   * already anchored.
   */
  function anchorIfPristine(): void {
    if (!pristine) {
      return
    }

    const current = geometry.value
    const sizes = options.tabSizes.value

    if (current.kind !== 'projectable' || sizes === null) {
      return
    }

    canonical.value =
      options.tab.value === 'original'
        ? unprojectViewportFromOriginal(DEFAULT_VIEWPORT, current.quarterTurns)
        : unprojectViewportFromCompressed(
            DEFAULT_VIEWPORT,
            current.cropRect,
            current.quarterTurns,
            sizes,
          )
    pristine = false
  }

  function reset(): void {
    canonical.value = DEFAULT_VIEWPORT
    pristine = true
    anchorIfPristine()
  }

  function setLocal(next: InspectorViewport): void {
    const current = geometry.value

    if (current.kind !== 'projectable' || !isFinitePoint(next)) {
      return
    }

    pristine = false
    canonical.value =
      options.tab.value === 'original'
        ? unprojectViewportFromOriginal(next, current.quarterTurns)
        : unprojectViewportFromCompressed(
            next,
            current.cropRect,
            current.quarterTurns,
            options.tabSizes.value ?? UNUSABLE_TAB_SIZES,
          )
  }

  // `immediate: true`: covers the case where `tabSizes` is already known the instant this runs
  // (e.g. a size already measured before mount in a test), which a plain `watch` would otherwise
  // never fire for, since nothing would subsequently *change* to trigger it.
  watch(options.tabSizes, anchorIfPristine, { immediate: true })

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
