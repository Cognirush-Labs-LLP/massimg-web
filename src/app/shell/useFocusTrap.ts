import { onBeforeUnmount, watch, type Ref } from 'vue'

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
 * Only ever set up from a component that is itself conditionally mounted on the client breakpoint
 * (docs/ui-design.md §2's mobile drawer) — see `useBreakpoint`'s doc comment for why that already
 * keeps this SSR-safe without an extra guard here: during vite-ssg's Node prerender pass,
 * `isDesktop` defaults to `true`, so the drawer component this composable lives in is never
 * rendered there in the first place.
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
        }
      } else if (!isActive && wasActive) {
        document.removeEventListener('keydown', handleKeydown)
        returnFocusTo.value?.focus()
      }
    },
    // `immediate: true` so a container that is already active on its very first render (not
    // just one that becomes active later) still gets trapped — without it, `wasActive` never
    // exists to compare against and the trap silently never engages. Safe during vite-ssg's
    // Node prerender pass regardless: Drawer.vue (this composable's only caller) is itself only
    // ever rendered client-side (see useBreakpoint's doc comment), so this callback never runs
    // where `document` wouldn't exist.
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeydown)
  })
}
