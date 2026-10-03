<script setup lang="ts">
// The transform line and its disclosures (Functional Design §3.3, R-C17, R-F6; docs/ui-design.md
// §11). What to say is decided by `transform-line.ts`; this only renders it.
//
// Unlike the comparison pill beside it, this is visible while an encode is in flight: it describes
// the settings rather than the result, so it is never stale and never hidden.
import { computed } from 'vue'
import { t } from '@/i18n/t'
import { useBreakpoint } from '@/app/shell/useBreakpoint'
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

// Below the side-panel breakpoint the full names (`camera_raw_file.jpg 1200×1799 → ...`) are
// replaced by just their extensions (`jpg 1200×1799 → ...`) so a long filename doesn't push the
// line onto a second row. The extension is read straight off `sourceName`/`outputName` — the same
// strings the full desktop line already uses — exactly as they're cased there, with no attempt to
// normalise `.JPG` vs `.jpg`: that's a naming.ts question, deliberately left open (see the handover
// note for this change) rather than decided here.
const { isDesktop } = useBreakpoint()

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')

  return index <= 0 ? '' : name.slice(index + 1)
}

const described = computed(() => (props.line.kind === 'described' ? props.line : null))

const lineText = computed(() => {
  const line = described.value

  if (line === null) {
    return ''
  }

  if (isDesktop.value) {
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
  }

  const sourceExt = extensionOf(line.sourceName)
  const outputExt = extensionOf(line.outputName)

  if (line.sourceSize === null || line.outputSize === null) {
    return t('preview.transform.lineCompactNoSizes', { sourceExt, outputExt })
  }

  return t('preview.transform.lineCompact', {
    sourceExt,
    sourceWidth: line.sourceSize.width,
    sourceHeight: line.sourceSize.height,
    outputExt,
    outputWidth: line.outputSize.width,
    outputHeight: line.outputSize.height,
  })
})

/**
 * The compact line split around its own arrow, so the mobile template can give "→" its own
 * styling (R-K8-adjacent: direction is already conveyed by position, this is purely emphasis).
 * Reads the arrow out of `lineText`'s own resolved output rather than assembling the sentence from
 * translated fragments (R-L5) — the whole sentence is still authored as one template in
 * messages.json; this only isolates a substring of its *result* for presentation.
 */
const compactArrowParts = computed(() => {
  const [before, after] = lineText.value.split('→')

  return { before: (before ?? '').trim(), after: (after ?? '').trim() }
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
    <p v-if="isDesktop" class="line" data-testid="preview-transform-line">{{ lineText }}</p>
    <p v-else class="line line-compact" data-testid="preview-transform-line">
      <span v-if="compactArrowParts.before">{{ compactArrowParts.before }}</span>
      <span class="arrow"> → </span>
      <span v-if="compactArrowParts.after">{{ compactArrowParts.after }}</span>
    </p>
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

/* The compact line's arrow carries more weight than the rest of the (already muted) line, so the
   before/after extensions it separates stay easy to tell apart at a glance. */
.line-compact .arrow {
  color: var(--color-primary);
  font-weight: var(--font-weight-wordmark);
}
</style>
