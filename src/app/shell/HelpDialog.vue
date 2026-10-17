<script setup lang="ts">
// A small, centred, focus-trapped informational dialog (T47-B, R-D5) — the same visual shape as
// ConfirmDialog.vue, but reversible rather than guarding an irreversible choice: it closes via its
// own Close button, Escape, or a scrim click, and returns focus to whatever opened it. One shape
// for both mobile and desktop, so no separate anchored-tooltip-on-desktop/bottom-sheet-on-mobile
// code is needed. Built as its own component rather than a ConfirmDialog.vue variant because that
// component is deliberately permanently-active with a no-op returnFocusTo and no scrim dismiss —
// opposite of what this needs on all three counts.
import { ref, toRef } from 'vue'
import { t } from '@/i18n/t'
import { useFocusTrap } from './useFocusTrap'

const props = defineProps<{
  modelValue: boolean
  returnFocusTo: HTMLElement | null
  title: string
  body: string
  /** A short, de-emphasised caveat — a fragment, not necessarily a full sentence. Optional. */
  note?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const dialogRef = ref<HTMLElement | null>(null)
const isOpen = toRef(props, 'modelValue')
const returnFocusToRef = toRef(props, 'returnFocusTo')

function close(): void {
  emit('update:modelValue', false)
}

useFocusTrap({
  container: dialogRef,
  active: isOpen,
  returnFocusTo: returnFocusToRef,
  onEscape: close,
})
</script>

<template>
  <div v-if="modelValue" class="help-scrim" data-testid="help-dialog-scrim" @click="close" />
  <div
    v-if="modelValue"
    ref="dialogRef"
    class="help-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    data-testid="help-dialog"
  >
    <p class="help-title">{{ title }}</p>
    <p class="help-body">{{ body }}</p>
    <div v-if="$slots.diagram" class="help-diagram">
      <slot name="diagram" />
    </div>
    <p v-if="note" class="help-note">{{ note }}</p>
    <div class="help-actions">
      <button type="button" class="help-close" data-testid="help-dialog-close" @click="close">
        {{ t('shell.helpDialog.closeLabel') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Same z-index tier as ConfirmDialog.vue (not Drawer.vue's 8/10): this dialog can be opened from
   inside the mobile settings drawer, so it must sit above it, not behind it. */
.help-scrim {
  position: fixed;
  inset: 0;
  z-index: 28;
  background: rgb(0 0 0 / 60%);
}

.help-dialog {
  position: fixed;
  z-index: 30;
  inset-block-start: 50%;
  inset-inline-start: 50%;
  transform: translate(-50%, -50%);
  inline-size: min(360px, calc(100vw - 32px));
  padding: 1.1rem;
  background: var(--color-surface-panel);
  border: 1px solid var(--color-border-group);
  border-radius: var(--radius-lg);
  box-shadow: 0 18px 40px rgb(0 0 0 / 60%);
}

.help-title {
  margin-block: 0 0.4rem;
  margin-inline: 0;
  color: var(--color-primary);
  font-weight: var(--font-weight-heading);
}

.help-body {
  margin-block: 0 0.5rem;
  margin-inline: 0;
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

.help-diagram {
  margin-block: 0.4rem 0.6rem;
}

/* A short caveat fragment, not a full sentence — deliberately quieter than .help-body, so it
   reads as a secondary note rather than part of the main explanation. */
.help-note {
  margin-block: 0.3rem 1rem;
  margin-inline: 0;
  color: var(--color-text-muted-quiet);
  font-size: 0.78rem;
  line-height: 1.3;
}

.help-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.help-close {
  min-block-size: 44px;
  padding-block: 0.5rem;
  padding-inline: 0.8rem;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: 0.9rem;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}
</style>
