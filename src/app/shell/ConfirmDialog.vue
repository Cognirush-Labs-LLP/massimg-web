<script setup lang="ts">
// Generic Stay/Leave(-ish) confirmation, focus-trapped like Drawer.vue (R-K9/R-K12). Used for both
// useBackNavigationGuard dialogs (the generic leave-intent one and R-X18's three-way one) — title,
// body and actions are pure data, so one component covers both rather than two near-duplicates.
import { ref } from 'vue'
import { useFocusTrap } from './useFocusTrap'

const props = defineProps<{
  title: string
  body: string
  actions: { id: string; label: string }[]
  escapeActionId?: string
}>()
const emit = defineEmits<{ action: [id: string] }>()

const dialogRef = ref<HTMLElement | null>(null)

useFocusTrap({
  container: dialogRef,
  active: ref(true),
  // Nothing meaningful to return focus to — the trigger was a back press, not a click.
  returnFocusTo: ref(null),
  onEscape: () => emit('action', props.escapeActionId ?? props.actions[0]?.id ?? ''),
})
</script>

<template>
  <!-- No click-to-dismiss on the scrim: an irreversible discard-or-keep decision shouldn't have a
       silent-dismiss affordance the way Drawer's settings panel does. -->
  <div class="confirm-scrim" data-testid="confirm-dialog-scrim" />
  <div
    ref="dialogRef"
    class="confirm-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    data-testid="confirm-dialog"
  >
    <p class="confirm-title">{{ title }}</p>
    <p class="confirm-body">{{ body }}</p>
    <div class="confirm-actions">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="confirm-action"
        :data-testid="`confirm-action-${action.id}`"
        @click="emit('action', action.id)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.confirm-scrim {
  position: fixed;
  inset: 0;
  z-index: 28;
  background: rgb(0 0 0 / 60%);
}

.confirm-dialog {
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

.confirm-title {
  margin-block: 0 0.4rem;
  margin-inline: 0;
  color: var(--color-primary);
  font-weight: var(--font-weight-heading);
}

.confirm-body {
  margin-block: 0 1rem;
  margin-inline: 0;
  color: var(--color-text-muted);
  font-size: 0.9rem;
}

.confirm-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.confirm-action {
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

.confirm-action:first-child {
  border-color: var(--color-tint);
}
</style>
