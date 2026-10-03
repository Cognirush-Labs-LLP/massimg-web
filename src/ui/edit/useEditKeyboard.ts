// R-K4/R-K2: Escape cancels without applying, Enter applies. A window-level `keydown` listener
// following `Preview.vue`'s existing precedent: scoped off whenever focus is inside a form
// control, where Escape/Enter already mean something to the control itself.
import { onBeforeUnmount, onMounted } from 'vue'
import { useEditDraftStore } from '@/stores/edit-draft'

function isFormControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, select, textarea, [contenteditable="true"]') !== null
  )
}

/** Apply/Cancel/Remove are real `<button>`s that already activate on Enter natively — only Enter
 * needs to skip a focused button, so pressing it there doesn't both click it and re-fire this
 * handler. Escape has no such double-fire risk and must still work with a button focused (e.g.
 * right after clicking Rotate). */
function isButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button') !== null
}

export function useEditKeyboard(): void {
  const draft = useEditDraftStore()

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }

    if (isFormControl(event.target)) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      draft.cancel()
    } else if (event.key === 'Enter' && !isButton(event.target)) {
      event.preventDefault()
      draft.apply()
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
