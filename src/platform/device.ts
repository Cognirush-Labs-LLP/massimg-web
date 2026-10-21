/**
 * Whether this is a phone or tablet, by feature detection and never by user agent (the rule
 * `platform/capability.ts` states). `hover: none` is what separates a touch device from a desktop
 * that happens to have a touchscreen, which `pointer: coarse` alone would misclassify. The design
 * documents define "mobile" only as a layout breakpoint, so this is a heuristic standing in for the
 * device class the limits mean (Technical Design §5.1, §8.3).
 */
export function detectMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  return window.matchMedia('(pointer: coarse) and (hover: none)').matches
}
