<script setup lang="ts">
// Purely decorative progress donut (R-X4): "every number it encodes is also present as text... no
// information exists only inside the donut." This component therefore renders no text of any kind
// — Processing.vue renders the paired text figures itself, as ordinary sibling markup that does not
// read from or depend on this component's DOM at all, so "readable with the chart hidden" holds
// trivially rather than by a visibility toggle.
//
// Four stacked <circle>s with `pathLength="100"` (SVG2) so stroke-dasharray/dashoffset are plain
// percentages, no circumference arithmetic. Colours reuse the four tokens tokens.css already
// defines — §14.1 asks that no colour be added without updating the design docs first, and this is
// the one place in the interface colour distinguishes categories (ui-design.md §1), so it spends
// the app's single accent on the category most worth noticing at a glance: success.
import { computed } from 'vue'

const props = defineProps<{
  succeeded: number
  failed: number
  skipped: number
  pending: number
}>()

interface Segment {
  key: string
  percent: number
  offset: number
  color: string
}

const segments = computed<Segment[]>(() => {
  const total = props.succeeded + props.failed + props.skipped + props.pending

  if (total === 0) {
    return []
  }

  const order: { key: string; count: number; color: string }[] = [
    { key: 'succeeded', count: props.succeeded, color: 'var(--color-tint)' },
    { key: 'failed', count: props.failed, color: 'var(--color-primary)' },
    { key: 'skipped', count: props.skipped, color: 'var(--color-text-muted)' },
    { key: 'pending', count: props.pending, color: 'var(--color-border-control)' },
  ]

  let cumulative = 0

  return order
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const percent = (entry.count / total) * 100
      const segment: Segment = { key: entry.key, percent, offset: -cumulative, color: entry.color }
      cumulative += percent
      return segment
    })
})
</script>

<template>
  <svg
    class="donut"
    viewBox="0 0 100 100"
    aria-hidden="true"
    data-testid="processing-donut"
    focusable="false"
  >
    <circle class="track" cx="50" cy="50" r="40" />
    <g transform="rotate(-90 50 50)">
      <circle
        v-for="segment in segments"
        :key="segment.key"
        class="segment"
        cx="50"
        cy="50"
        r="40"
        pathLength="100"
        :stroke="segment.color"
        :stroke-dasharray="`${segment.percent} ${100 - segment.percent}`"
        :stroke-dashoffset="segment.offset"
      />
    </g>
  </svg>
</template>

<style scoped>
.donut {
  inline-size: 120px;
  block-size: 120px;
}

.track,
.segment {
  fill: none;
  stroke-width: 10;
}

.track {
  stroke: var(--color-surface-control);
}

.segment {
  stroke-linecap: butt;
  transition:
    stroke-dasharray 200ms ease-out,
    stroke-dashoffset 200ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .segment {
    transition: none;
  }
}
</style>
