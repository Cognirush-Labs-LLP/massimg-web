// Translated reason text for the selection-time rejection list (T39, Functional Design §10,
// R-E1/R-I20/R-I21). A sibling of `imageMeta.ts`'s and `processingText.ts`'s role: small, pure,
// independently testable formatting kept out of the component template. Every message names the
// file (or states it concerns the whole folder/batch, for entries with no single file), states the
// actual value and the cap where one exists, and states what to do next — never "something went
// wrong". `file-too-large` and `heic-decoder-unavailable` also name the desktop application,
// since both are hard browser/memory limits rather than a product choice (R-I21).
import { formatUiSize } from '@/domain/sizes'
import type { RejectionEntry } from '@/domain/rejection'
import { t } from '@/i18n/t'

export function describeRejection(entry: RejectionEntry): string {
  const reason = entry.reason

  switch (reason.kind) {
    case 'unhandled':
      switch (reason.reason) {
        case 'psd':
          return t('rejection.reason.psd', { name: entry.name ?? '' })
        case 'ico':
          return t('rejection.reason.ico', { name: entry.name ?? '' })
        case 'svg':
          return t('rejection.reason.svg', { name: entry.name ?? '' })
        case 'camera-raw':
          return t('rejection.reason.cameraRaw', { name: entry.name ?? '' })
        case 'animated-avif':
          return t('rejection.reason.animatedAvif', { name: entry.name ?? '' })
      }
      break
    case 'heic-decoder-unavailable':
      return t('rejection.reason.heicUnavailable', { name: entry.name ?? '' })
    case 'file-too-large':
      return t('rejection.reason.fileTooLarge', {
        name: entry.name ?? '',
        actual: formatUiSize(reason.actualBytes),
        cap: formatUiSize(reason.capBytes),
      })
    case 'batch-count-exceeded':
      return t('rejection.reason.batchCountExceeded', { actual: reason.actual, cap: reason.cap })
    case 'folder-empty':
      return t('rejection.reason.folderEmpty')
    case 'folder-depth-exceeded':
      return t('rejection.reason.folderDepthExceeded', { actual: reason.actual, cap: reason.cap })
    case 'folder-file-count-exceeded':
      return t('rejection.reason.folderFileCountExceeded', {
        actual: reason.actual,
        cap: reason.cap,
      })
  }
}
