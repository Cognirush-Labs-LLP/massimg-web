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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { describeSizeComparison, formatUiSize } from '@/domain/sizes'
import type { ImageId } from '@/domain/types'
import { t } from '@/i18n/t'
import { downloadFinishedRun } from '@/pipeline/run-download'
import { shareFinishedRun } from '@/pipeline/run-share'
import { useBatchStore } from '@/stores/batch'
import { useRunStore } from '@/stores/run'
import { useUiStore } from '@/stores/ui'
import HelpDialog from '@/app/shell/HelpDialog.vue'
import { prepareGalleryCleanup } from '@/ui/gallery/ingest'
import ProcessingDonut from './ProcessingDonut.vue'
import { describeFailureReason, describeSkipReason } from './processingText'
import { useProcessingRun } from './useProcessingRun'

const batchStore = useBatchStore()
const runStore = useRunStore()
const { progress, failures, skipped, finished, haltReason, delivery, deliveryError } =
  storeToRefs(runStore)
const uiStore = useUiStore()

const processingRun = useProcessingRun()
const { quotaRejection, shareAvailable } = processingRun

const announcement = ref('')
const lastAnnouncedQuartile = ref(-1)
const clearing = ref(false)
const cleanupAttempted = ref(false)
const cleanupFailed = ref(false)
const helpOpen = ref(false)
const helpTrigger = ref<HTMLElement | null>(null)
let active = true
onBeforeUnmount(() => {
  active = false
})

function openCleanupHelp(event: Event): void {
  helpTrigger.value = event.currentTarget as HTMLElement
  helpOpen.value = true
}

async function onClearTemporaryData(): Promise<void> {
  if (clearing.value || delivery.value === 'pending') return
  clearing.value = true
  cleanupAttempted.value = true
  cleanupFailed.value = false
  const startedAt = runStore.runStartedAt
  const clearGallery = prepareGalleryCleanup()
  try {
    await processingRun.cleanup()
    await clearGallery()
    if (runStore.runStartedAt === startedAt) runStore.resetRun()
    if (active) uiStore.finishProcessing()
  } catch {
    if (active) {
      cleanupFailed.value = true
      announcement.value = t('processing.cleanup.failed')
    }
  } finally {
    clearing.value = false
  }
}

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

// R-X14/R-X15: delivery is explicit and only ever reachable from a finished run with at least one
// success. Both handlers own no logic of their own — the single-vs-ZIP branching lives in
// run-download.ts and the platform call in platform/share.ts (§9.1: "the component never invokes
// the browser API directly"). The result is read back off `runStore.deliveryError` rather than
// from the return value, so a failure raised by the back guard's "Download and leave" surfaces
// through the same inline message as one raised here.
async function onDownload(): Promise<void> {
  if (clearing.value || cleanupAttempted.value) return
  await downloadFinishedRun()
}

// Deliberately the first statement, with nothing awaited ahead of it: Web Share is gesture-gated
// and T39-A measured a real harness losing its transient activation to one slow await.
// R-X50: a cancelled share is silent — no message, no state change, both actions still offered.
async function onShare(): Promise<void> {
  if (clearing.value) return
  await shareFinishedRun()
}

/** R-X54's checked, non-interactive completion state, naming which delivery actually happened. */
const deliveredLabel = computed(() =>
  delivery.value === 'shared'
    ? t('processing.complete.shared')
    : t('processing.complete.downloadStarted'),
)

/** §10 "ZIP assembly failure" and "Download blocked by browser" — two rows, two messages. */
const downloadErrorText = computed(() => {
  if (deliveryError.value === 'download-assembly') {
    return t('processing.download.assemblyFailed')
  }
  return deliveryError.value === 'download-blocked' ? t('processing.download.blocked') : ''
})

// R-K5/T42: the delivered state and the three inline delivery errors were otherwise visual-only.
// Both watchers reuse the same strings already shown on screen (R-K10's reuse convention), rather
// than inventing screen-reader-specific copy.
watch(delivery, (state) => {
  if (state !== 'pending') {
    announcement.value = deliveredLabel.value
  }
})

watch(deliveryError, (error) => {
  if (error === null) {
    return
  }
  announcement.value = error === 'share' ? t('processing.share.failed') : downloadErrorText.value
})

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

      <!-- §10 "ZIP assembly failure" / "Download blocked by browser" / "Share handoff fails":
           stated inline beside the actions, which remain available so the user can retry
           (R-X50). A cancelled share sets nothing and so renders nothing. -->
      <p
        v-if="downloadErrorText !== ''"
        class="delivery-error"
        data-testid="processing-download-error"
      >
        {{ downloadErrorText }}
      </p>
      <p
        v-else-if="deliveryError === 'share'"
        class="delivery-error"
        data-testid="processing-share-error"
      >
        {{ t('processing.share.failed') }}
      </p>

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
          <!-- R-X54: once delivery has succeeded, this becomes the remaining primary action. -->
          <button
            type="button"
            class="action"
            :class="{ 'action--primary': delivery !== 'pending' }"
            data-testid="processing-back"
            :disabled="clearing"
            @click="uiStore.finishProcessing()"
          >
            {{ t('processing.complete.back') }}
          </button>
          <!-- Never shown once the run halted (haltReason) — "partial results discarded" (§10
               "Out of memory") means there is nothing to offer regardless of how many images
               succeeded before the halt — nor with zero successes (R-X14, §10 "Every image in a
               run failed or was skipped"). -->
          <!-- Grouped so the outer row wraps Back onto its own line before it separates the
               checked state from Download again. -->
          <div v-if="haltReason === null && progress.succeeded > 0" class="delivery-group">
            <!-- R-X54: the two delivery actions are replaced by one checked, non-interactive
                 state once either of them has succeeded. The check glyph is decoration; the
                 label is what identifies the outcome. -->
            <p v-if="delivery !== 'pending'" class="delivered" data-testid="processing-delivered">
              <span aria-hidden="true">✓</span> {{ deliveredLabel }}
            </p>
            <!-- Download, unlike Share, gets no confirmation back from the platform: the file is
                 handed over and that is the end of it (see pipeline/run-download.ts). So the
                 checked state above says "Download started" rather than "Downloaded", and the
                 action stays available beneath it — if nothing arrived, pressing it again is the
                 user's only recourse, and the run's outputs are deliberately still on disk for
                 exactly that. Share resolves only on real acceptance, so it collapses to the
                 checked state alone. -->
            <template v-if="delivery === 'pending' || delivery === 'downloaded'">
              <button
                type="button"
                class="action"
                :class="{ 'action--primary': delivery === 'pending' }"
                data-testid="processing-download"
                :disabled="clearing || cleanupAttempted"
                @click="onDownload"
              >
                {{
                  delivery === 'pending'
                    ? t('processing.complete.download')
                    : t('processing.complete.downloadAgain')
                }}
              </button>
              <!-- R-X14/R-X48: beside Download, and only once the exact completed payload has
                   been accepted by this platform. -->
              <button
                v-if="shareAvailable && delivery === 'pending'"
                type="button"
                class="action action--primary"
                data-testid="processing-share"
                @click="onShare"
              >
                {{ t('processing.complete.share') }}
              </button>
            </template>
          </div>
        </template>
      </div>
      <div
        v-if="delivery !== 'pending' && haltReason === null && progress.succeeded > 0"
        class="cleanup"
        :aria-busy="clearing"
        data-testid="processing-cleanup"
      >
        <p class="cleanup-description">{{ t('processing.cleanup.description') }}</p>
        <div class="cleanup-row">
          <button
            type="button"
            class="action"
            data-testid="processing-clear-temporary"
            :disabled="clearing"
            @click="onClearTemporaryData"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.1a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9L12.2 4M6.7 6.6v4.8M9.3 6.6v4.8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {{ t(clearing ? 'processing.cleanup.clearing' : 'processing.cleanup.label') }}
          </button>
          <button
            type="button"
            class="cleanup-help-button"
            :aria-label="t('processing.cleanup.helpLabel')"
            data-testid="processing-cleanup-help"
            @click="openCleanupHelp"
          >
            ?
          </button>
        </div>
        <p v-if="cleanupFailed" class="cleanup-description" data-testid="processing-cleanup-error">
          {{ t('processing.cleanup.failed') }}
        </p>
      </div>
    </template>
    <HelpDialog
      v-model="helpOpen"
      :return-focus-to="helpTrigger"
      :title="t('processing.cleanup.helpTitle')"
      :body="t('processing.cleanup.helpBody')"
      :note="t('processing.cleanup.helpNote')"
    />
  </div>
</template>

<style scoped>
.processing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  inline-size: min(100%, 520px);
  /* Fills the stage body so .cleanup's auto top margin can push it to the bottom. */
  min-block-size: 100%;
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

.delivery-error {
  margin: 0;
  color: var(--color-tint);
  font-weight: var(--font-weight-control);
  font-size: 0.9rem;
  text-align: center;
}

/* R-X54: deliberately not a button and not styled as one — it reports an outcome and must not
   look pressable, while still sitting in the slot the two delivery actions occupied. */
.delivered {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  min-block-size: 44px;
  margin: 0;
  /* No button-style side padding: this shares the row with the Download-again action, and the
     stage column is capped at 520px, so 40px of cosmetic padding was the difference between the
     row fitting on one line and wrapping. */
  padding-inline: 0;
  color: var(--color-tint);
  font-weight: var(--font-weight-control);
  font-size: 0.95rem;
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
  /* Wrap the row rather than squeeze its items: with the checked delivery line and two buttons
     sharing it, a narrow viewport otherwise shrank each button until its label broke onto a
     second line ("Back to images" measured 154px wide and 44px tall at desktop, 96x58 at 390px).
     Items keep their natural width and move to the next line instead. */
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

.delivery-group {
  display: flex;
  /* Still wraps below ~330px, where the pair cannot fit side by side without page overflow. */
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.action {
  flex: none;
  min-block-size: 44px;
  padding-inline: 20px;
  white-space: nowrap;
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

.cleanup {
  display: flex;
  flex-direction: column;
  gap: 6px;
  inline-size: 100%;
  margin-block-start: auto;
}

.cleanup-description {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.cleanup-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

/* Matches .cleanup-help-button's height so the pair reads as one row; deliberately below the 44px
   touch target used by the other actions, since this is a quiet, optional control. */
.cleanup-row > .action {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-block-size: 32px;
  padding-block: 4px;
  padding-inline: 10px;
  white-space: normal;
  font-size: 0.8rem;
}

.cleanup-help-button {
  flex: none;
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  background: none;
  border: 1px solid var(--color-border-control);
  border-radius: 50%;
  color: var(--color-text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
</style>
