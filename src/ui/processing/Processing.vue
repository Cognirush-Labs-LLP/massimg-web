<script setup lang="ts">
// Processing stage mode (Functional Design §6.1-§6.4, R-X1-R-X20, R-X26/R-X27; Technical Design
// §5.3; docs/ui-design.md §13). Replaces T31's placeholder.
//
// This component is the orchestrator and holds no run-execution logic of its own: `useProcessingRun`
// owns the job submission/outcome lifecycle, `ProcessingDonut` is pure presentation, and
// `processingText.ts` owns translated failure/skip reason text. Unmounting it is what tears down
// the run (Technical Design §1.1, R-M4) via `useProcessingRun`'s own `onScopeDispose`.
//
// Single column at every width (ui-design.md §13, R-R5) — unlike Gallery/Preview, Processing never
// attempts a two-column layout, so there is no breakpoint split here at all.
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { describeSizeComparison, formatUiSize } from '@/domain/sizes'
import type { ImageId } from '@/domain/types'
import { t } from '@/i18n/t'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useUiStore } from '@/stores/ui'
import ProcessingDonut from './ProcessingDonut.vue'
import { describeFailureReason, describeSkipReason } from './processingText'
import { useProcessingRun } from './useProcessingRun'

const batchStore = useBatchStore()
const runStore = useRunStore()
const { progress, failures, skipped, finished, haltReason } = storeToRefs(runStore)
const uiStore = useUiStore()

const processingRun = useProcessingRun()
const { quotaRejection } = processingRun

const announcement = ref('')
const lastAnnouncedQuartile = ref(-1)

function nameFor(imageId: ImageId): string {
  return batchStore.images.find((image) => image.id === imageId)?.name ?? imageId
}

const totalText = computed(() => {
  if (progress.value.succeeded === 0) {
    // §10 "Every image in a run failed or was skipped": distinct from a genuinely empty/no-op run,
    // whose total stays "No size change yet" — this one states plainly that there is nothing to
    // download, rather than leaving that to be inferred from the Download button's mere absence.
    if (finished.value && (progress.value.failed > 0 || progress.value.skipped > 0)) {
      return t('processing.total.allFailedOrSkipped')
    }
    return t('processing.total.unchanged')
  }

  const comparison = describeSizeComparison(runStore.inputBytes, runStore.outputBytes)
  const saved = formatUiSize(Math.abs(runStore.inputBytes - runStore.outputBytes))

  if (comparison.direction === 'increase') {
    return comparison.belowOnePercent
      ? t('processing.total.increaseUnderOne', { saved })
      : t('processing.total.increase', { saved, percent: comparison.percent })
  }

  if (comparison.direction === 'reduction') {
    return comparison.belowOnePercent
      ? t('processing.total.reductionUnderOne', { saved })
      : t('processing.total.reduction', { saved, percent: comparison.percent })
  }

  return t('processing.total.unchanged')
})

// R-K5: run progress is announced at intervals, not per image. No interval value is specified
// anywhere in the design documents; a quarter of the batch is a judgment call (recorded in this
// task's handover note) that keeps a long batch from flooding a screen reader while still giving a
// mid-run signal, and guarantees exactly one extra announcement for a batch too small to have
// distinct quartiles.
watch(processingRun.processed, (processedCount) => {
  if (finished.value) {
    return
  }

  const total = processingRun.total.value
  if (total === 0) {
    return
  }

  const quartile = Math.floor((processedCount / total) * 4)
  if (quartile !== lastAnnouncedQuartile.value) {
    lastAnnouncedQuartile.value = quartile
    announcement.value = t('processing.announce.progress', { processed: processedCount, total })
  }
})

watch(finished, (isFinished) => {
  if (isFinished) {
    announcement.value = t('processing.announce.complete', {
      succeeded: progress.value.succeeded,
      failed: progress.value.failed,
      skipped: progress.value.skipped,
    })
  }
})

async function onCancel(): Promise<void> {
  announcement.value = t('processing.announce.stopping')
  await processingRun.cancel()
}

onMounted(() => {
  announcement.value = t('processing.announce.started')
  processingRun.start()
})
</script>

<template>
  <div class="processing" data-testid="processing-root">
    <!-- R-X40: the pre-run storage preflight rejected this batch before any job was dispatched —
         no counter, donut or Cancel makes sense since nothing ever started. -->
    <template v-if="quotaRejection">
      <p class="halted" data-testid="processing-quota-rejected">
        {{
          t('processing.quota.rejected', {
            required: formatUiSize(quotaRejection.requiredBytes),
            available: formatUiSize(quotaRejection.availableBytes),
          })
        }}
      </p>
      <div class="actions">
        <button
          type="button"
          class="action"
          data-testid="processing-back"
          @click="uiStore.finishProcessing()"
        >
          {{ t('processing.complete.back') }}
        </button>
      </div>
    </template>
    <template v-else>
      <p class="counter" data-testid="processing-counter">
        {{
          t('processing.counter', {
            processed: processingRun.processed.value,
            total: processingRun.total.value,
          })
        }}
      </p>

      <div class="donut-row">
        <ProcessingDonut
          :succeeded="progress.succeeded"
          :failed="progress.failed"
          :skipped="progress.skipped"
          :pending="progress.pending"
        />
        <ul class="figures">
          <li data-testid="processing-figure-succeeded">
            {{ t('processing.figure.succeeded', { count: progress.succeeded }) }}
          </li>
          <li data-testid="processing-figure-failed">
            {{ t('processing.figure.failed', { count: progress.failed }) }}
          </li>
          <li data-testid="processing-figure-skipped">
            {{ t('processing.figure.skipped', { count: progress.skipped }) }}
          </li>
          <li data-testid="processing-figure-pending">
            {{ t('processing.figure.pending', { count: progress.pending }) }}
          </li>
        </ul>
      </div>

      <p class="total" data-testid="processing-total">{{ totalText }}</p>

      <p v-if="haltReason === 'out-of-memory'" class="halted" data-testid="processing-halted">
        {{ t('processing.halted.memory') }}
      </p>
      <p v-if="haltReason === 'storage-failure'" class="halted" data-testid="processing-halted">
        {{ t('processing.halted.storage') }}
      </p>

      <p
        class="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="processing-announcement"
      >
        {{ announcement }}
      </p>

      <section v-if="failures.length > 0" class="issue-list" data-testid="processing-failures">
        <h2>{{ t('processing.failure.heading') }}</h2>
        <ul>
          <li v-for="entry in failures" :key="entry.imageId">
            <span class="file-name">{{ nameFor(entry.imageId) }}</span>
            <span class="reason">{{ describeFailureReason(entry.reason) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="skipped.length > 0" class="issue-list" data-testid="processing-skipped">
        <h2>{{ t('processing.skip.heading') }}</h2>
        <ul>
          <li v-for="entry in skipped" :key="entry.imageId">
            <span class="file-name">{{ nameFor(entry.imageId) }}</span>
            <span class="reason">{{ describeSkipReason(entry.reason) }}</span>
          </li>
        </ul>
      </section>

      <div class="actions">
        <button
          v-if="!finished"
          type="button"
          class="action"
          data-testid="processing-cancel"
          @click="onCancel"
        >
          {{
            t(
              processingRun.stopping.value
                ? 'processing.cancel.stopping'
                : 'processing.cancel.label',
            )
          }}
        </button>
        <template v-else>
          <button
            type="button"
            class="action"
            data-testid="processing-back"
            @click="uiStore.finishProcessing()"
          >
            {{ t('processing.complete.back') }}
          </button>
          <!-- Download's click handler is T42's: it wires the explicit Download button to
             downloadFinishedRun() once T40 (archive assembly) and T41 (report) exist. This button
             only satisfies R-X14's visibility rule for now. Never shown once the run halted
             (haltReason) — "partial results discarded" (§10 "Out of memory") means there is
             nothing to offer regardless of how many images succeeded before the halt. -->
          <button
            v-if="haltReason === null && progress.succeeded > 0"
            type="button"
            class="action action--primary"
            data-testid="processing-download"
          >
            {{ t('processing.complete.download') }}
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.processing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  inline-size: min(100%, 520px);
  margin-inline: auto;
  padding-block: 24px;
  text-align: center;
}

.counter {
  margin: 0;
  color: var(--color-primary);
  font-family: var(--font-family-mono);
  font-size: 1.1rem;
  font-variant-numeric: tabular-nums;
}

.donut-row {
  display: flex;
  align-items: center;
  gap: 20px;
}

.figures {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  text-align: start;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.total {
  margin: 0;
  color: var(--color-tint);
  font-family: var(--font-family-mono);
  font-size: 0.95rem;
  font-variant-numeric: tabular-nums;
}

.halted {
  margin: 0;
  color: var(--color-tint);
  font-weight: var(--font-weight-control);
  font-size: 0.9rem;
  text-align: center;
}

.issue-list {
  inline-size: 100%;
  text-align: start;
}

.issue-list h2 {
  margin-block: 0 6px;
  margin-inline: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: var(--font-weight-control);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.issue-list ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.issue-list li {
  display: flex;
  flex-direction: column;
  padding-block: 8px;
  padding-inline: 12px;
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-md);
  background: var(--color-surface-tile);
  font-size: 0.85rem;
}

.file-name {
  color: var(--color-primary);
  font-weight: var(--font-weight-control);
  overflow-wrap: anywhere;
}

.reason {
  color: var(--color-text-muted);
}

.actions {
  display: flex;
  gap: 10px;
}

.action {
  min-block-size: 44px;
  padding-inline: 20px;
  border: 1px solid var(--color-border-control);
  border-radius: var(--radius-lg);
  background: var(--color-surface-control);
  color: var(--color-primary);
  font-size: 0.95rem;
  font-weight: var(--font-weight-control);
  cursor: pointer;
}

.action--primary {
  background: var(--color-tint);
  border-color: var(--color-tint);
  font-weight: var(--font-weight-wordmark);
}
</style>
