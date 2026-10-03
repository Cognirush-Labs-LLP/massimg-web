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
  align-items: baseline;
  min-inline-size: 0;
  overflow: hidden;
}

.wordmark-text {
  overflow: hidden;
  font-size: 14.5px;
  font-weight: var(--font-weight-wordmark);
  letter-spacing: -0.4px;
  text-transform: uppercase;
  white-space: nowrap;
  text-overflow: ellipsis;
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
