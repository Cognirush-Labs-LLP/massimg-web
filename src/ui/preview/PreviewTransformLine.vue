<script setup lang="ts">
// The transform line and its disclosures (Functional Design §3.3, R-C17, R-F6; docs/ui-design.md
// §11). What to say is decided by `transform-line.ts`; this only renders it.
//
// Unlike the comparison pill beside it, this is visible while an encode is in flight: it describes
// the settings rather than the result, so it is never stale and never hidden.
import { computed } from 'vue'
import { t } from '@/i18n/t'
import type { EncodableFormat } from '@/domain/types'
import type { TransformLine } from './transform-line'

const props = defineProps<{ line: TransformLine }>()

const FORMAT_DISPLAY_NAME: Record<EncodableFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
  avif: 'AVIF',
  gif: 'GIF',
}

const described = computed(() => (props.line.kind === 'described' ? props.line : null))

const lineText = computed(() => {
  const line = described.value

  if (line === null) {
    return ''
  }

  if (line.sourceSize === null || line.outputSize === null) {
    return t('preview.transform.lineNoSizes', {
      sourceName: line.sourceName,
      outputName: line.outputName,
    })
  }

  return t('preview.transform.line', {
    sourceName: line.sourceName,
    sourceWidth: line.sourceSize.width,
    sourceHeight: line.sourceSize.height,
    outputName: line.outputName,
    outputWidth: line.outputSize.width,
    outputHeight: line.outputSize.height,
  })
})

const notes = computed(() => {
  const line = described.value

  if (line === null) {
    return []
  }

  return line.notes.map((note) =>
    note === 'animation-substituted'
      ? t('preview.transform.animationSubstituted')
      : t('preview.transform.flatten', { format: FORMAT_DISPLAY_NAME[line.outputFormat] }),
  )
})
</script>

<template>
  <div v-if="described" class="transform" data-testid="preview-transform">
    <p class="line" data-testid="preview-transform-line">{{ lineText }}</p>
    <p v-for="note in notes" :key="note" class="note" data-testid="preview-transform-note">
      {{ note }}
    </p>
  </div>
</template>

<style scoped>
.transform {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.line {
  margin: 0;
  color: var(--color-text-muted-quiet);
  font-family: var(--font-family-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
}

.note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11.5px;
}
</style>
