<script setup lang="ts">
// The side panel's Format section (Functional Design §4.3, docs/ui-design.md §10, T35): a
// six-option dropdown writing to `useSettingsStore().format` (Technical Design §3.2), plus the
// GIF inline warning note. Format acronyms (JPEG/PNG/WebP/AVIF/GIF) are deliberately not routed
// through t() — same convention `domain/sizes.ts` already uses for KB/MB, since these are
// standardised acronyms rather than natural-language sentences (docs/task-notes/T35.md, Decisions
// made). "Don't change" is the one option that is an actual sentence and is translated.
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import type { FormatSetting } from '@/domain/format'
import { useSettingsStore } from '@/stores/settings'

interface FormatOption {
  value: FormatSetting
  label: string | null
  messageKey: 'panel.format.optionDontChange' | null
}

// Order per Functional Design §4.3 / docs/ui-design.md §10 — Don't change, JPEG, PNG, WebP, AVIF,
// GIF. The sample mockup ships only four of these; GIF and Don't change are this task's additions.
const OPTIONS: FormatOption[] = [
  { value: 'dont-change', label: null, messageKey: 'panel.format.optionDontChange' },
  { value: 'jpeg', label: 'JPEG', messageKey: null },
  { value: 'png', label: 'PNG', messageKey: null },
  { value: 'webp', label: 'WebP', messageKey: null },
  { value: 'avif', label: 'AVIF', messageKey: null },
  { value: 'gif', label: 'GIF', messageKey: null },
]

const settings = useSettingsStore()
const { format } = storeToRefs(settings)

function onChange(event: Event): void {
  settings.format = (event.target as HTMLSelectElement).value as FormatSetting
}
</script>

<template>
  <div class="format-section">
    <select
      :value="format"
      :aria-label="t('panel.format.selectLabel')"
      class="format-select"
      data-testid="format-select"
      @change="onChange"
    >
      <option v-for="option in OPTIONS" :key="option.value" :value="option.value">
        {{ option.messageKey ? t(option.messageKey) : option.label }}
      </option>
    </select>
    <p v-if="format === 'gif'" class="format-note" data-testid="format-gif-warning">
      {{ t('panel.format.gifWarning') }}
    </p>
  </div>
</template>

<style scoped>
.format-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.format-select {
  min-block-size: 40px;
  padding-inline: 10px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  font-size: 13.5px;
  font-weight: var(--font-weight-control);
}

.format-note {
  margin: 0;
  padding-block: 8px;
  padding-inline: 10px;
  background: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.4;
}
</style>
