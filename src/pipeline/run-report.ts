// Joins the Pinia stores a just-finished run left behind into the report model (T41, Functional
// Design §6.6, R-X31; Technical Design §9.3). Pure `domain/report.ts` has no store access of its
// own; this is the one place that reads `runStore`/`batchStore`/`settingsStore` to build its input.
//
// Called once, after every job has settled and before the archive sink closes (see
// `useProcessingRun.ts`'s call site and `run-archive.ts`'s `finish()`), while Processing's
// exclusive mount still guarantees `settingsStore` is frozen for the run's duration.
import {
  buildReport,
  describeReportSettings,
  formatFailureReason,
  formatReportTimestamp,
  formatRejectionReason,
  serializeReport,
  type ReportFailure,
  type ReportFile,
  type ReportSkippedImage,
  type ReportSource,
  type ReportSuccess,
} from '@/domain/report'
import type { ImageId, ImageRecord } from '@/domain/types'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useSettingsStore } from '@/stores/settings'

export const REPORT_ARCHIVE_PATH = 'image_compression_report.txt'

function lookupFile(images: readonly ImageRecord[], imageId: ImageId): ReportFile {
  const image = images.find((candidate) => candidate.id === imageId)
  return { name: image?.name ?? imageId, relativePath: image?.relativePath ?? null }
}

/**
 * Builds `image_compression_report.txt`'s bytes from the just-finished run's real outcomes. Only
 * called for a multi-image run (R-X16: a single-image run has no report at all).
 */
export function buildRunReportEntry(): { path: string; bytes: Uint8Array } {
  const runStore = useRunStore()
  const batchStore = useBatchStore()
  const settingsStore = useSettingsStore()

  const images = batchStore.images

  const successes: ReportSuccess[] = runStore.successes.map((success) => ({
    file: lookupFile(images, success.imageId),
    inputBytes: success.inputBytes,
    outputBytes: success.outputBytes,
    caveats: runStore.caveats.find((entry) => entry.imageId === success.imageId)?.caveats ?? [],
  }))

  const failures: ReportFailure[] = runStore.failures.map((failure) => ({
    file: lookupFile(images, failure.imageId),
    reason: formatFailureReason(failure.reason),
  }))

  // Selection-time rejections (R-X9/R-I2) merge into Skipped, ahead of runtime size-target skips —
  // they happened first, before the run started. Batch-/folder-wide rejections (no single file,
  // `name === null`) don't fit the report's per-file row shape and are excluded.
  const rejectedSkips: ReportSkippedImage[] = batchStore.rejections
    .filter((entry) => entry.name !== null)
    .map((entry) => ({
      file: { name: entry.name!, relativePath: entry.relativePath },
      reason: formatRejectionReason(entry.reason),
    }))
  const sizeTargetSkips: ReportSkippedImage[] = runStore.skipped.map((skipped) => ({
    file: lookupFile(images, skipped.imageId),
    reason: skipped.reason,
  }))

  const source: ReportSource = {
    run: formatReportTimestamp(runStore.runStartedAt ?? new Date()),
    settings: describeReportSettings({
      quality: settingsStore.quality,
      dimension: settingsStore.dimension,
      format: settingsStore.format,
    }),
    successes,
    failures,
    skippedImages: [...rejectedSkips, ...sizeTargetSkips],
  }

  const yaml = serializeReport(buildReport(source))

  return { path: REPORT_ARCHIVE_PATH, bytes: new TextEncoder().encode(yaml) }
}
