// Badge and meta-text presentation shared by the grid tile (T33-B) and the list row (T34), so the
// two view modes can't silently drift apart on badge order or the pending/error dimension text
// (docs/ui-design.md §7: "Same badge set and order as grid tiles").
import { t } from '@/i18n/t'
import { formatUiSize } from '@/domain/sizes'
import type { ImageRecord } from '@/domain/types'
import { dimensionErrors } from './ingest'

export type BadgeKind = 'edited' | 'animated' | 'failed' | 'skipped'

export const badgeLabel: Record<BadgeKind, string> = {
  edited: t('gallery.badge.edited'),
  animated: t('gallery.badge.animated'),
  failed: t('gallery.badge.failed'),
  skipped: t('gallery.badge.skipped'),
}

// Fixed order per docs/ui-design.md §6/§7: EDITED -> ANIMATED -> SKIPPED/FAILED.
export function badgesFor(image: ImageRecord): BadgeKind[] {
  const list: BadgeKind[] = []
  if (image.edit) {
    list.push('edited')
  }
  if (image.isAnimated) {
    list.push('animated')
  }
  if (image.status === 'failed') {
    list.push('failed')
  }
  if (image.status === 'skipped') {
    list.push('skipped')
  }
  return list
}

export function dimensionTextFor(image: ImageRecord): string {
  if (dimensionErrors.has(image.id)) {
    return t('gallery.tile.dimensionError')
  }
  if (image.width === 0 || image.height === 0) {
    return t('gallery.tile.dimensionPending')
  }
  return `${image.width}×${image.height}`
}

export function metaTextFor(image: ImageRecord): string {
  return t('gallery.tile.meta', {
    dimensions: dimensionTextFor(image),
    size: formatUiSize(image.sizeBytes),
  })
}
