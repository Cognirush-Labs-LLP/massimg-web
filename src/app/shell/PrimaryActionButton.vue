<script setup lang="ts">
// The one primary call-to-action (Functional Design R-A1-R-A4, docs/ui-design.md §10). Rendered
// twice by ToolPage.vue — once pinned to the static side panel's footer (>=900px), once as a
// fixed bottom bar outside the drawer (<900px) — never repositioned, because the mobile
// placement must sit outside the drawer's transform context so opening/closing the drawer can
// never cover or remove it.
//
// `count` and `disabled` come from `useBatchStore` (image count, and `disabled` = batch is
// empty, R-A3) via the caller — ToolPage.vue reads the store, this component stays a plain,
// store-free leaf like Header.vue and Drawer.vue. `metaLine` (R-A2, R-F4, T35) is the same:
// already-translated text computed by ToolPage.vue from `describePrimaryActionOutput`
// (domain/job.ts) — this component only renders it, so it never needs its own store access.
import { computed } from 'vue'
import { t } from '@/i18n/t'

const props = withDefaults(
  defineProps<{
    count?: number
    disabled?: boolean
    metaLine?: string
  }>(),
  { count: 0, disabled: true, metaLine: '' },
)

const label = computed(() => t('action.compressLabel', { count: props.count }))
</script>

<template>
  <div class="primary-action-wrap">
    <button type="button" class="primary-action" :disabled="disabled">
      {{ label }}
    </button>
    <p v-if="metaLine" class="primary-action-meta" data-testid="primary-action-meta">
      {{ metaLine }}
    </p>
  </div>
</template>

<style scoped>
.primary-action-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.primary-action-meta {
  margin: 0;
  text-align: center;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}

.primary-action {
  inline-size: 100%;
  min-block-size: 44px;
  padding-block: 0.9rem;
  padding-inline: 1rem;
  background: var(--color-tint);
  border: none;
  border-radius: var(--radius-lg);
  color: var(--color-primary);
  font-size: 1rem;
  font-weight: var(--font-weight-wordmark);
  cursor: pointer;
}

.primary-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
