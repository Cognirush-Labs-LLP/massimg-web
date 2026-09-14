<script setup lang="ts">
// Demonstrates the i18n scaffold added in T08 (src/i18n/t.ts,
// src/i18n/en/{messages,context}.json) rendering real messages, including a
// parameterised one (R-L5), through a real Vue component. See
// docs/task-notes/T08.md.
import { t } from '@/i18n/t'

// A real, non-hardcoded value — proves the interpolation isn't just echoing
// a literal baked into messages.json.
const exampleBatchCount = 4
const compressLabel = t('action.compressLabel', { count: exampleBatchCount })
</script>

<template>
  <section class="i18n-demo" aria-label="i18n scaffold demo">
    <h2 data-testid="i18n-demo-heading">{{ t('panel.section.quality') }}</h2>
    <p data-testid="i18n-demo-plain">{{ t('gallery.title') }}</p>
    <p data-testid="i18n-demo-parameterised">{{ compressLabel }}</p>
  </section>
</template>
