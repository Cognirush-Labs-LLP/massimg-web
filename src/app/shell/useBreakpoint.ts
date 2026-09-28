import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

// The layout is space-driven, not device-driven (Functional Design R-R1, docs/ui-design.md §2):
// a static side-panel column at and above this width, an off-canvas drawer below it. Kept as a
// literal here and in each shell component's matching CSS media query — see the comment beside
// each `@media (min-width: 900px)` — rather than a shared token, because CSS custom properties
// can't be read inside a media-query condition without a PostCSS custom-media plugin, which
// isn't configured (not worth adding for one number).
export const SIDE_PANEL_BREAKPOINT_PX = 900

/**
 * Whether the viewport is at or above the side-panel breakpoint. Defaults to `true` (the
 * desktop/static-column layout) so this is safe to evaluate during vite-ssg's Node prerender
 * pass, where `window` does not exist (Technical Design §12.1/§12.3) — `matchMedia` is only
 * touched inside `onMounted`, which never fires during that pass. This default also matches
 * what a crawler with no JavaScript would see, and produces no hydration mismatch on the
 * client: the client's own initial render uses the same default before `onMounted` corrects it,
 * so the two agree at the point Vue actually diffs them.
 */
export function useBreakpoint(): { isDesktop: Ref<boolean> } {
  const isDesktop = ref(true)
  let mediaQueryList: MediaQueryList | null = null

  function handleChange(event: MediaQueryListEvent): void {
    isDesktop.value = event.matches
  }

  onMounted(() => {
    mediaQueryList = window.matchMedia(`(min-width: ${SIDE_PANEL_BREAKPOINT_PX}px)`)
    isDesktop.value = mediaQueryList.matches
    mediaQueryList.addEventListener('change', handleChange)
  })

  onBeforeUnmount(() => {
    mediaQueryList?.removeEventListener('change', handleChange)
  })

  return { isDesktop }
}
