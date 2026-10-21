import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { FormatSetting } from '@/domain/format'
import type { BatchSettings, QualitySetting } from '@/domain/job'
import type { BatchDimension } from '@/domain/types'

/**
 * Batch-wide settings (Technical Design §3.2): quality mode and value, dimension rule and value,
 * output format. This is exactly the shape `resolveSettings(image, batchSettings)`
 * (`src/domain/job.ts`) expects as its `BatchSettings` argument, resolved per image alongside
 * each `ImageRecord.edit`.
 *
 * Per-image state is `edit` on `ImageRecord` itself (`useBatchStore`), never duplicated here —
 * docs/ui-design.md §4: "These are never per-image."
 *
 * Any change here invalidates every in-flight Preview encode (R-P3). This store is only the
 * reactive trigger; the debounce/token mechanism that discards a superseded encode is T36's
 * (docs/ui-design.md §11) — nothing here does that itself.
 */
export const useSettingsStore = defineStore('settings', () => {
  // Default target type is Quality, not Size (docs/ui-design.md §8, "Quality target (default)").
  // The default numeric value (70) is not specified anywhere in the design documents — the panel
  // only offers three shortcut chips (LOW 40 / MED 70 / HIGH 90) with none marked as the initial
  // slider position. 70 (the MED chip) is chosen as the least-surprising default; see
  // docs/task-notes/T32.md, Decisions made.
  const quality = ref<QualitySetting>({ kind: 'quality', value: 70 })

  // "Original size" is the only dimension row with no stated alternative default
  // (functional-design.md §4.2, docs/ui-design.md §9).
  const dimension = ref<BatchDimension>({ kind: 'original' })

  // R-F1: "Don't change" is the explicit default.
  const format = ref<FormatSetting>('dont-change')

  // An animated source written as a format that cannot animate (JPEG, AVIF) is saved as animated
  // WebP rather than losing its animation; unchecking it takes the first frame instead.
  const animatedAsWebp = ref(true)

  const batch = computed<BatchSettings>(() => ({
    quality: quality.value,
    dimension: dimension.value,
    format: format.value,
    animatedAsWebp: animatedAsWebp.value,
  }))

  return { quality, dimension, format, animatedAsWebp, batch }
})
