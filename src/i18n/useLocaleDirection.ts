// Syncs <html dir> to the current locale's writing direction (R-L4). `onMounted` is the same
// client-only guard ToolPage.vue already uses for scheduleImageMagickPreload() — it never fires
// during vite-ssg's Node prerender pass, where `document` does not exist.
import { onMounted, watchEffect } from 'vue'
import { isRtl } from './locale'

export function useLocaleDirection(): void {
  onMounted(() => {
    watchEffect(() => {
      document.documentElement.dir = isRtl() ? 'rtl' : 'ltr'
    })
  })
}
