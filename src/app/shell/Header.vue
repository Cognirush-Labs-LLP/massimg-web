<script setup lang="ts">
// App header (docs/ui-design.md §2): wordmark + tint dot, mode-driven breadcrumb, and (mobile
// only) the Options button that opens the settings drawer.
import { computed } from 'vue'
import { t } from '@/i18n/t'
import type { StageMode } from '@/stores/ui'

const props = withDefaults(
  defineProps<{
    stageMode: StageMode
    isDesktop: boolean
    selectedCount?: number
    /** The current image's own file name, for the Preview and Edit breadcrumbs. Wired in T36. */
    activeFileName?: string
  }>(),
  { selectedCount: 0, activeFileName: '' },
)

const emit = defineEmits<{ 'open-panel': [opener: HTMLElement] }>()

function unreachableStageMode(value: never): never {
  throw new Error(`Unhandled stage mode: ${String(value)}`)
}

const breadcrumb = computed(() => {
  switch (props.stageMode) {
    case 'gallery':
      return t('shell.breadcrumb.selected', { count: props.selectedCount })
    case 'preview':
      return t('shell.breadcrumb.preview', { filename: props.activeFileName })
    case 'edit':
      return t('shell.breadcrumb.edit', { filename: props.activeFileName })
    case 'processing':
      return t('shell.breadcrumb.processing')
    default:
      return unreachableStageMode(props.stageMode)
  }
})

function handleOptionsClick(event: MouseEvent): void {
  emit('open-panel', event.currentTarget as HTMLElement)
}
</script>

<template>
  <header class="app-header">
    <div class="wordmark">
      <span class="wordmark-text">Compressor</span>
      <span class="wordmark-dot" aria-hidden="true" />
    </div>
    <div class="breadcrumb">{{ breadcrumb }}</div>
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
  gap: 8px;
}

.wordmark-text {
  font-size: 16px;
  font-weight: var(--font-weight-wordmark);
  letter-spacing: -0.4px;
  text-transform: uppercase;
}

.wordmark-dot {
  inline-size: 6px;
  block-size: 6px;
  border-radius: 50%;
  background: var(--color-tint);
}

.breadcrumb {
  font-family: var(--font-family-mono);
  font-size: 11px;
  color: var(--color-text-muted-quiet);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}

.header-spacer {
  flex: 1;
}

.options-button {
  display: flex;
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
