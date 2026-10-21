<script setup lang="ts">
// One Gallery list row (Functional Design R-G7-R-G12; docs/ui-design.md §7 "Row anatomy").
// Deliberately imports nothing from thumbnail-service.ts and takes no thumbnailUrl prop: list
// mode generates no thumbnails and decodes nothing at all (R-G9), satisfied by construction here
// rather than by a runtime check. Otherwise mirrors GalleryTile.vue's two-sibling-button
// structure and shares its badge/dimension text via imageMeta.ts (same fixed EDITED -> ANIMATED
// -> FAILED order, same pending/error dimension text).
import { computed } from 'vue'
import { t } from '@/i18n/t'
import { splitPath } from '@/domain/naming'
import type { ImageRecord } from '@/domain/types'
import { useUiStore } from '@/stores/ui'
import { removeIngestedImage } from './ingest'
import { animationOutcome } from '@/domain/job'
import { useSettingsStore } from '@/stores/settings'
import { badgeLabel, badgesFor, metaTextFor } from './imageMeta'

const props = defineProps<{
  image: ImageRecord
}>()

const uiStore = useUiStore()
const settingsStore = useSettingsStore()

const badges = computed(() =>
  badgesFor(props.image, animationOutcome(props.image, settingsStore.batch)),
)
const metaText = computed(() => metaTextFor(props.image))
const removeLabel = computed(() => t('gallery.tile.remove', { filename: props.image.name }))

// Row anatomy per ui-design.md §7: "Relative path (only present for folder-sourced images) +
// filename." A folder-root file (relativePath with no directory component) has nothing to show
// beyond its filename, same as a loose pick.
const directoryPrefix = computed(() => {
  if (props.image.relativePath === null) {
    return null
  }
  const { directory } = splitPath(props.image.relativePath)
  return directory === '' ? null : `${directory}/`
})

function open(): void {
  uiStore.openPreview(props.image.id)
}

function remove(event: MouseEvent): void {
  event.stopPropagation()
  removeIngestedImage(props.image.id)
}
</script>

<template>
  <div class="row" data-testid="gallery-list-row" :data-image-id="image.id">
    <button type="button" class="open-button" data-testid="gallery-list-row-open" @click="open">
      <span v-if="badges.length > 0" class="badges">
        <span v-for="badge in badges" :key="badge" class="badge" :class="`badge-${badge}`">
          {{ badgeLabel[badge] }}
        </span>
      </span>
      <span class="filename">
        <span v-if="directoryPrefix" class="directory">{{ directoryPrefix }}</span>
        {{ image.name }}
      </span>
      <span class="meta">{{ metaText }}</span>
    </button>
    <button
      type="button"
      class="remove-button"
      data-testid="gallery-list-row-remove"
      :aria-label="removeLabel"
      @click="remove"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-block: 8px;
  padding-inline: 10px;
  border-block-end: 1px solid var(--color-border-control);
}

.badges {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.badge {
  padding-block: 2px;
  padding-inline: 6px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: var(--font-weight-control);
  letter-spacing: 0.04em;
}

.badge-first-frame {
  border-color: var(--color-border-warning);
  color: var(--color-text-warning);
}

.open-button {
  display: flex;
  overflow: hidden;
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 0;
  background: none;
  border: none;
  text-align: start;
  cursor: pointer;
}

.filename {
  overflow: hidden;
  color: var(--color-primary);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory {
  color: var(--color-text-muted-quiet);
}

.meta {
  flex-shrink: 0;
  margin-inline-start: auto;
  color: var(--color-text-muted-quiet);
  font-family: var(--font-family-mono);
  font-size: 11px;
}

.remove-button {
  position: relative;
  flex-shrink: 0;
  inline-size: 22px;
  block-size: 22px;
  padding: 0;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

/* Enlarges the tappable area more horizontally than vertically: rows stack with only an 8px
   block padding and a 1px border between them, so vertical growth risks landing on the next
   row's own remove button, while the row's own inline padding gives horizontal room to spare. */
.remove-button::after {
  content: '';
  position: absolute;
  inset-block-start: -5px;
  inset-block-end: -5px;
  inset-inline-start: -10px;
  inset-inline-end: -10px;
}
</style>
