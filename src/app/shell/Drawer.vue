<script setup lang="ts">
// The mobile off-canvas settings drawer (docs/ui-design.md §2, R-K3). Scrim + sliding panel +
// sticky Hide button, focus-trapped while open, closing (Hide, scrim click, or Escape) returns
// focus to whichever element opened it. Only ever rendered by ToolPage.vue when `!isDesktop`, so
// this component's own client-only behaviour (focus trap touching `document`) never runs during
// vite-ssg's Node prerender pass — see useBreakpoint's doc comment.
import { ref, toRef } from 'vue'
import { t } from '@/i18n/t'
import { useFocusTrap } from './useFocusTrap'

const props = defineProps<{
  modelValue: boolean
  returnFocusTo: HTMLElement | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const panelRef = ref<HTMLElement | null>(null)
const isOpen = toRef(props, 'modelValue')
const returnFocusToRef = toRef(props, 'returnFocusTo')

function close(): void {
  emit('update:modelValue', false)
}

useFocusTrap({
  container: panelRef,
  active: isOpen,
  returnFocusTo: returnFocusToRef,
  onEscape: close,
})
</script>

<template>
  <div v-if="modelValue" class="drawer-scrim" data-testid="drawer-scrim" @click="close" />
  <div
    v-if="modelValue"
    ref="panelRef"
    class="drawer-panel"
    role="dialog"
    aria-modal="true"
    :aria-label="t('shell.panelLabel')"
    data-testid="drawer-panel"
  >
    <div class="drawer-scroll">
      <div class="drawer-hide-row">
        <button type="button" class="drawer-hide-button" @click="close">
          {{ t('shell.hideButton') }}
          <span aria-hidden="true">→</span>
        </button>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.drawer-scrim {
  position: fixed;
  inset: 0;
  z-index: 8;
  background: rgb(0 0 0 / 60%);
}

.drawer-panel {
  position: fixed;
  inset-block: 0;
  inset-inline-end: 0;
  z-index: 10;
  inline-size: min(340px, 88vw);
  background: var(--color-surface-panel);
  border-inline-start: 1px solid var(--color-border-group);
  box-shadow: -18px 0 40px rgb(0 0 0 / 60%);
}

.drawer-scroll {
  block-size: 100%;
  overflow-y: auto;
}

.drawer-hide-row {
  position: sticky;
  inset-block-start: 0;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  padding-block: 0.6rem;
  padding-inline: 0.9rem;
  background: var(--color-surface-panel);
  border-block-end: 1px solid var(--color-border-group);
}

.drawer-hide-button {
  min-block-size: 44px;
  padding-block: 0.5rem;
  padding-inline: 0.8rem;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 0.85rem;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}
</style>
