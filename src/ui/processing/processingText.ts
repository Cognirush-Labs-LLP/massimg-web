// Translated reason text for the Processing view's Failed/Skipped lists (R-X11, §6.3). A sibling
// of src/ui/gallery/imageMeta.ts's role for Gallery badges — small, pure, independently testable
// formatting, kept out of Processing.vue's template.
//
// Deliberately NOT src/domain/report.ts's `formatSkippedReason`/`formatCaveat`: those produce
// hardcoded English for the locale-independent downloadable report (R-X32) and are not translatable
// on-screen UI text.
import { formatUiSize } from '@/domain/sizes'
import type { FailureReason, SizeTargetSkipReason } from '@/domain/types'
import { t } from '@/i18n/t'

/**
 * `reason.kind` is exactly `FailureReason`'s closed set once a pipeline `JobFailure` has already
 * been coerced onto it (see `useProcessingRun.ts`'s outcome mapping) — `unimplemented` and other
 * pipeline-only reasons fold onto `encode-failed` before reaching this function.
 */
export function describeFailureReason(reason: FailureReason): string {
  switch (reason.kind) {
    case 'decode-failed':
      return t('processing.failure.decode')
    case 'encode-failed':
      return t('processing.failure.encode')
    case 'out-of-memory':
      return t('processing.failure.memory')
  }
}

export function describeSkipReason(reason: SizeTargetSkipReason): string {
  return t('processing.skip.reason', {
    target: formatUiSize(reason.targetBytes),
    achieved: formatUiSize(reason.achievedBytes),
    width: reason.width,
    height: reason.height,
    format: reason.format.toUpperCase(),
  })
}
