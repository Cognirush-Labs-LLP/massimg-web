import { onMounted, ref, type Ref } from 'vue'
import { getCapabilities } from '@/platform/capability'

// R-I31: where folder selection is unavailable, the control is hidden rather than shown and
// failing. Defaults `folderPicker` to `false` until resolved client-side (mirrors
// useBreakpoint.ts's SSR-safe pattern: `getCapabilities()` touches `document`/`navigator`, which
// don't exist during vite-ssg's Node prerender pass, so the probe only runs inside `onMounted`).
export function useCapabilities(): { folderPicker: Ref<boolean> } {
  const folderPicker = ref(false)

  onMounted(() => {
    void getCapabilities().then((capabilities) => {
      folderPicker.value = capabilities.folderPicker
    })
  })

  return { folderPicker }
}
