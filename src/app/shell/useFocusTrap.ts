import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

// Hand-rolled rather than a dependency (docs/task-notes/T31.md, Decisions made): the behaviour
// R-K3 needs — Tab/Shift+Tab cycling inside a container, Escape, focus-restore-on-close — is
// small and fully specified, consistent with this project's established minimalism (Technical
// Design §1's curated dependency list, no bundled webfonts).
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface UseFocusTrapOptions {
  /** The trap's boundary. Tab/Shift+Tab cycle among this element's focusable descendants. */
  container: Ref<HTMLElement | null>
  /** Whether the trap is currently engaged. */
  active: Ref<boolean>
  /** Element to return focus to when the trap deactivates (R-K3). */
  returnFocusTo: Ref<HTMLElement | null>
  /** Called on Escape, while active. Does not itself deactivate the trap — the caller does. */
  onEscape: () => void
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * Traps Tab/Shift+Tab focus cycling inside `container` while `active` is true, calls `onEscape`
 * on Escape, and returns focus to `returnFocusTo` when `active` transitions back to false.
 *
 * SSR safety: each caller must only ever be rendered client-side. Drawer.vue relies on
 * `isDesktop` defaulting to `true` during vite-ssg's Node prerender pass (see `useBreakpoint`'s
 * doc comment); ConfirmDialog.vue (R-M9/R-X18's confirmations) is only ever mounted from inside
 * `useBackNavigationGuard`, itself only invoked from `ToolPage.vue`'s client-only `onMounted`.
 */
export function useFocusTrap(options: UseFocusTrapOptions): void {
  const { container, active, returnFocusTo, onEscape } = options

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onEscape()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const root = container.value
    if (!root) {
      return
    }

    const elements = focusableElements(root)
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (!first || !last) {
      event.preventDefault()
      return
    }

    const current = document.activeElement
    const currentIndex = current instanceof HTMLElement ? elements.indexOf(current) : -1

    if (event.shiftKey) {
      if (currentIndex <= 0) {
        event.preventDefault()
        last.focus()
      }
    } else {
      if (currentIndex === -1 || currentIndex === elements.length - 1) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  watch(
    active,
    (isActive, wasActive) => {
      if (isActive && !wasActive) {
        document.addEventListener('keydown', handleKeydown)
        const root = container.value
        if (root) {
          focusableElements(root)[0]?.focus()
        } else {
          // The immediate invocation below runs synchronously when this composable is called
          // during setup(), before the caller's own first render — reached whenever `active` is
          // already true at creation (rather than becoming true later, as Drawer.vue's own usage
          // does), so `container.value` isn't bound to the DOM yet. Defer one tick and retry.
          void nextTick(() => {
            const mountedRoot = container.value
            if (mountedRoot) {
              focusableElements(mountedRoot)[0]?.focus()
            }
          })
        }
      } else if (!isActive && wasActive) {
        document.removeEventListener('keydown', handleKeydown)
        returnFocusTo.value?.focus()
      }
    },
    // `immediate: true` so a container that is already active on its very first render (not
    // just one that becomes active later, e.g. ConfirmDialog.vue, which never toggles `active`
    // after creation) still gets trapped — without it, `wasActive` never exists to compare
    // against and the trap silently never engages. Safe during vite-ssg's Node prerender pass:
    // every caller is only ever rendered client-side (see doc comment above), so this callback
    // never runs where `document` wouldn't exist.
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeydown)
  })
}
