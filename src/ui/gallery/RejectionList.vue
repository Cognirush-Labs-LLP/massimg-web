<script setup lang="ts">
// Selection-time rejection list (T39, Functional Design §10, R-E2): one dismissible panel, not one
// alert per file, shown whenever the batch store holds rejection entries from the most recent
// selection action. Mounted in ToolPage.vue (the shell that persists across every stage mode),
// not inside Gallery.vue itself — a selection that adds exactly one image auto-opens Preview
// (R-M1), unmounting Gallery immediately, so a rejection from that same selection would otherwise
// vanish the instant it appeared had this lived inside Gallery's own component tree.
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { describeRejection } from './rejectionText'

const batchStore = useBatchStore()
const { rejections } = storeToRefs(batchStore)
</script>

<template>
  <section v-if="rejections.length > 0" class="rejection-list" data-testid="rejection-list">
    <div class="rejection-header">
      <h2>{{ t('rejection.heading') }}</h2>
      <button
        type="button"
        class="dismiss"
        data-testid="rejection-dismiss"
        @click="batchStore.dismissRejections()"
      >
        {{ t('rejection.dismiss') }}
      </button>
    </div>
    <ul>
      <li v-for="entry in rejections" :key="entry.id" data-testid="rejection-entry">
        {{ describeRejection(entry) }}
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rejection-list {
  margin-block: 10px 0;
  margin-inline: 18px;
  padding-block: 12px;
  padding-inline: 14px;
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  background: var(--color-surface-tile);
  text-align: start;
}

.rejection-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-block-end: 6px;
}

.rejection-header h2 {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: var(--font-weight-control);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.dismiss {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-tint);
  font-size: 12px;
  cursor: pointer;
}

ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  color: var(--color-text-muted);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
</style>
