<script setup lang="ts">
// App header (docs/ui-design.md §2): wordmark, and (mobile only) the Options button that opens
// the settings drawer. The wordmark stays first and the button sticks to the inline-end edge via
// `.header-spacer` so neither crowds the other on narrow screens.
import { t } from '@/i18n/t'
import type { StageMode } from '@/stores/ui'

defineProps<{
  stageMode: StageMode
  isDesktop: boolean
}>()

const emit = defineEmits<{ 'open-panel': [opener: HTMLElement] }>()

function handleOptionsClick(event: MouseEvent): void {
  emit('open-panel', event.currentTarget as HTMLElement)
}
</script>

<template>
  <header class="app-header">
    <div class="wordmark">
      <!-- mic192.png, not mic32.png: displayed at 32px but sourced at 6x that size so it stays
           sharp on 2x/3x-density screens rather than upscaling an already-32px source. -->
      <img class="wordmark-icon" src="/icons/mic192.png" alt="" width="32" height="32" />
      <span class="wordmark-text">Mass Image Compressor</span>
    </div>
    <div class="header-spacer" />
    <button
      v-if="!isDesktop && stageMode !== 'processing'"
      type="button"
      class="options-button"
      data-testid="options-button"
      @click="handleOptionsClick"
    >
      {{ t('shell.optionsButton') }}
      <span aria-hidden="true">☰</span>
    </button>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 1rem;
  block-size: 58px;
  padding-inline: 18px;
  border-block-end: 1px solid var(--color-border-group);
}

.wordmark {
  display: flex;
  align-items: center;
  gap: 10px;
  min-inline-size: 0;
  overflow: hidden;
}

.wordmark-icon {
  display: block;
  flex: none;
  inline-size: 32px;
  block-size: 32px;
  border-radius: var(--radius-sm);
}

.wordmark-text {
  overflow: hidden;
  /* Larger on desktop, where there's room for it; one step down from the previous 14.5px on
     mobile. No uppercase transform either way — matches the outer site header's wordmark style
     (SiteHeader.vue) now that this header also carries the same icon+text pairing. */
  font-size: 16px;
  font-weight: var(--font-weight-wordmark);
  letter-spacing: -0.2px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (max-width: 899.98px) {
  .wordmark-text {
    font-size: 13px;
  }
}

.header-spacer {
  flex: 1;
}

.options-button {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  min-block-size: 44px;
  padding-block: 9px;
  padding-inline: 15px;
  background: var(--color-tint);
  border: 1px solid var(--color-tint);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 13.5px;
  font-weight: var(--font-weight-wordmark);
  cursor: pointer;
}
</style>
