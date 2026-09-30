<script setup lang="ts">
// One Gallery grid tile (Functional Design R-G1-R-G6; docs/ui-design.md §6 "Tile anatomy").
// Deliberately two sibling buttons rather than a button-in-a-button: `open-button` covers the
// thumbnail/filename/meta and opens Preview (R-G1), `remove-button` is a separate, absolutely
// positioned control (R-G2 — removing this tile never affects any other tile, and clicking it
// must not also open Preview). Badges are plain text, not colour-only (R-K10).
import { computed } from 'vue'
import { t } from '@/i18n/t'
import type { ImageRecord } from '@/domain/types'
import { useUiStore } from '@/stores/ui'
import { removeIngestedImage } from './ingest'
import { badgeLabel, badgesFor, metaTextFor } from './imageMeta'

const props = defineProps<{
  image: ImageRecord
  thumbnailUrl: string | null
}>()

const uiStore = useUiStore()

const badges = computed(() => badgesFor(props.image))
const metaText = computed(() => metaTextFor(props.image))
const removeLabel = computed(() => t('gallery.tile.remove', { filename: props.image.name }))

function open(): void {
  uiStore.openPreview(props.image.id)
}

function remove(event: MouseEvent): void {
  event.stopPropagation()
  removeIngestedImage(props.image.id)
}
</script>

<template>
  <div class="tile" data-testid="gallery-tile" :data-image-id="image.id">
    <div v-if="badges.length > 0" class="badges">
      <span v-for="badge in badges" :key="badge" class="badge" :class="`badge-${badge}`">
        {{ badgeLabel[badge] }}
      </span>
    </div>
    <button
      type="button"
      class="remove-button"
      data-testid="gallery-tile-remove"
      :aria-label="removeLabel"
      @click="remove"
    >
      ×
    </button>
    <button type="button" class="open-button" data-testid="gallery-tile-open" @click="open">
      <span class="thumb" :class="{ placeholder: !thumbnailUrl }">
        <img v-if="thumbnailUrl" :src="thumbnailUrl" alt="" loading="lazy" />
      </span>
      <span class="filename">{{ image.name }}</span>
      <span class="meta">{{ metaText }}</span>
    </button>
  </div>
</template>

<style scoped>
.tile {
  position: relative;
}

.badges {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  inset-block-start: 6px;
  inset-inline-start: 6px;
  max-inline-size: calc(100% - 36px);
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

.remove-button {
  position: absolute;
  z-index: 2;
  inset-block-start: 6px;
  inset-inline-end: 6px;
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

.open-button {
  display: flex;
  inline-size: 100%;
  padding: 0;
  background: none;
  border: none;
  text-align: start;
  cursor: pointer;
  flex-direction: column;
}

.thumb {
  display: block;
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--color-surface-control);
  border-radius: var(--radius-md);
}

.thumb img {
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
}

.filename {
  margin-block-start: 6px;
  overflow: hidden;
  color: var(--color-primary);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  margin-block-start: 2px;
  color: var(--color-text-muted-quiet);
  font-family: var(--font-family-mono);
  font-size: 11px;
}
</style>
