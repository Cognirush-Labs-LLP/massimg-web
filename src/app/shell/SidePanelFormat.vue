<script setup lang="ts">
// The side panel's Format section (Functional Design §4.3, docs/ui-design.md §10, T35): a
// six-option dropdown writing to `useSettingsStore().format` (Technical Design §3.2), plus the
// GIF inline warning note. Format acronyms (JPEG/PNG/WebP/AVIF/GIF) are deliberately not routed
// through t() — same convention `domain/sizes.ts` already uses for KB/MB, since these are
// standardised acronyms rather than natural-language sentences (docs/task-notes/T35.md, Decisions
// made). "Don't change" is the one option that is an actual sentence and is translated.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '@/i18n/t'
import { supportsAnimation, type FormatSetting } from '@/domain/format'
import { useBatchStore } from '@/stores/batch'
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
const { format, animatedAsWebp } = storeToRefs(settings)
const { images } = storeToRefs(useBatchStore())

// Offered whenever the chosen format cannot animate, whatever the batch holds: a user who picks the
// format first and adds images afterwards must still find the choice already on screen.
const showAnimatedChoice = computed(
  () => format.value !== 'dont-change' && !supportsAnimation(format.value),
)

const animatedCount = computed(() => images.value.filter((image) => image.isAnimated).length)

function onAnimatedChange(event: Event): void {
  settings.animatedAsWebp = (event.target as HTMLInputElement).checked
}

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
    <label v-if="showAnimatedChoice" class="animated-choice">
      <input
        type="checkbox"
        :checked="animatedAsWebp"
        data-testid="format-animated-webp"
        @change="onAnimatedChange"
      />
      <span>{{ t('panel.format.animatedWebpLabel') }}</span>
    </label>
    <p
      v-if="showAnimatedChoice && animatedCount > 0"
      class="format-note"
      :class="{ 'format-note-warning': !animatedAsWebp }"
      data-testid="format-animated-hint"
    >
      <span v-if="!animatedAsWebp" aria-hidden="true">⚠ </span>
      {{
        t(animatedAsWebp ? 'panel.format.animatedWebpHintOn' : 'panel.format.animatedWebpHintOff', {
          count: animatedCount,
        })
      }}
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

.format-note-warning {
  border-color: var(--color-border-warning);
  color: var(--color-text-warning);
}

.animated-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-primary);
  font-size: 13px;
  cursor: pointer;
}

.animated-choice input {
  inline-size: 16px;
  block-size: 16px;
  margin: 0;
  accent-color: var(--color-tint);
}
</style>
