// Preview's encode lifecycle (T36): R-P1's encode on entry, R-P3's debounce, R-P4's hidden figures,
// R-B1/R-B4/R-B5's release ordering, and §10's inline error with a retry.
//
// Technical Design §4's rule is that one pipeline serves preview and run, so this composable builds
// an ordinary `Job` with `intent: 'preview'` and hands it to a pool. It owns no arithmetic of its own:
// `resolveSettings` decides what the job asks for, the pool decides what supersedes what, and this
// module only decides *when* to ask and *what to release when*.
//
// Three things here are easy to get subtly wrong, so they are stated rather than implied:
//
//   - **One watcher, not two.** An image change encodes immediately (R-P1); a settings change is
//     debounced (R-P3). They are branches of one watcher over one snapshot because two independent
//     watchers both fire when stepping to an image whose stored edit has a different version — the
//     immediate encode, then a redundant debounced one 1000 ms later.
//   - **The previous result is released at the *start* of the debounce window, not at the end.** R-B1
//     discards a preview on any settings change, and R-P4 wants the figures hidden rather than stale
//     while an encode is in flight. Keeping the old image on screen for 1000 ms would show the user a
//     picture of settings they have already changed.
//   - **Supersession is not enough on its own.** The pool's `supersede()` is keyed by `imageId`, so
//     stepping to a different image does not supersede the outgoing one's job. A local generation
//     counter is what makes an outcome from any abandoned request — different image, or a result that
//     lands after the source file has been re-read — unable to reach the screen.

import { onScopeDispose, ref, toRaw, watch, type Ref } from 'vue'
import { mimeForFormat } from '@/domain/format'
import { resolveSettings, type BatchSettings } from '@/domain/job'
import type {
  DimensionRecoveryJob,
  EncodableFormat,
  ImageId,
  ImageRecord,
  JpegRecoveryJob,
  Job,
} from '@/domain/types'
import type {
  DimensionRecoveryResult,
  JobFailure,
  JpegRecoveryResult,
  SizeTargetUnreachableResult,
} from '@/pipeline/protocol'
import { getSourceFile } from '@/platform/source-files'
import { getPreviewPool } from './preview-pool'

/** Technical Design §5.3: "Debounce interval: 1000 ms after the last input event." */
export const PREVIEW_DEBOUNCE_MS = 1000

export type PreviewPhase = 'idle' | 'encoding' | 'ready' | 'unreachable' | 'error'

/**
 * Why there is no compressed image. Each case has its own message, because §10 forbids a generic
 * failure anywhere in the app (R-E1).
 */
export type PreviewEncodeError =
  | { kind: 'decode-failed' }
  | { kind: 'encode-failed' }
  | { kind: 'out-of-memory' }
  /** A format combination this build has no path for yet — a CICP-only frame to JPEG, PNG or GIF. */
  | { kind: 'unsupported'; format: EncodableFormat }
  /** An animated AVIF, which has no encoder at all (R-F7). Retrying cannot help. */
  | { kind: 'animated-avif' }
  /** The image's stored `File` has gone missing. No interaction produces this. */
  | { kind: 'source-missing' }

export interface PreviewEncodeOptions {
  /** The image in the frame, or `null` when Preview has no current image. */
  image: Ref<ImageRecord | null>
  /** The batch-wide settings, as `resolveSettings` takes them. */
  settings: Ref<BatchSettings>
  /** Whether the Original tab is showing, which is what makes the source worth decoding at all. */
  wantsOriginal: Ref<boolean>
  /** Recovery suggestions are strictly single-image behavior. */
  allowRecovery: Ref<boolean>
}

export interface PreviewEncodeState {
  phase: Ref<PreviewPhase>
  /** Object URL of the encoded result. Revoked before a replacement is made. */
  compressedUrl: Ref<string | null>
  /** `bytes.byteLength` of the real encode — measured, never estimated (§14.3). */
  compressedBytes: Ref<number | null>
  /** Object URL of the untouched source file, created only once the Original tab asks for it. */
  originalUrl: Ref<string | null>
  /** The browser could not draw the source itself (a HEIC on Chromium, a TIFF, a JPEG XL). */
  originalUnrenderable: Ref<boolean>
  error: Ref<PreviewEncodeError | null>
  unreachable: Ref<SizeTargetUnreachableResult | null>
  recoveryPhase: Ref<'idle' | 'checking' | 'done'>
  jpegSuggestion: Ref<JpegRecoveryResult['suggestion']>
  dimensionSuggestion: Ref<DimensionRecoveryResult['suggestion']>
  /** §10's retry, beside the inline error. */
  retry: () => void
  /** Called by the frame when the Original tab's `<img>` raises `error`. */
  reportOriginalUnrenderable: () => void
}

interface EncodeSnapshot {
  id: ImageId | null
  settings: BatchSettings
  editVersion: number | null
}

export function usePreviewEncode(options: PreviewEncodeOptions): PreviewEncodeState {
  const pool = getPreviewPool()
  // Leaving Preview cancels its queue without throwing away loaded codecs. Re-entering resumes the
  // same pool before the immediate entry encode is submitted.
  pool.resume()

  const phase = ref<PreviewPhase>('idle')
  const compressedUrl = ref<string | null>(null)
  const compressedBytes = ref<number | null>(null)
  const originalUrl = ref<string | null>(null)
  const originalUnrenderable = ref(false)
  const error = ref<PreviewEncodeError | null>(null)
  const unreachable = ref<SizeTargetUnreachableResult | null>(null)
  const recoveryPhase = ref<'idle' | 'checking' | 'done'>('idle')
  const jpegSuggestion = ref<JpegRecoveryResult['suggestion']>(null)
  const dimensionSuggestion = ref<DimensionRecoveryResult['suggestion']>(null)

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped by every request. An outcome whose generation is stale belongs to an image or a settings
   * state that is no longer on screen, and is dropped — including a `completed` one, whose bytes are
   * then never turned into an object URL and never retained (R-B1).
   */
  let generation = 0

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }

  function releaseCompressed(): void {
    if (compressedUrl.value !== null) {
      URL.revokeObjectURL(compressedUrl.value)
      compressedUrl.value = null
    }

    compressedBytes.value = null
    unreachable.value = null
    recoveryPhase.value = 'idle'
    jpegSuggestion.value = null
    dimensionSuggestion.value = null
  }

  function releaseOriginal(): void {
    if (originalUrl.value !== null) {
      URL.revokeObjectURL(originalUrl.value)
      originalUrl.value = null
    }

    originalUnrenderable.value = false
  }

  /** R-B4: both halves of the working set, released together. */
  function releaseWorkingSet(): void {
    clearDebounce()
    releaseCompressed()
    releaseOriginal()
    error.value = null
  }

  function fail(reason: PreviewEncodeError): void {
    releaseCompressed()
    error.value = reason
    phase.value = 'error'
  }

  async function sourceBytes(image: ImageRecord): Promise<Uint8Array | null | undefined> {
    const file = getSourceFile(image.id)

    if (file === undefined) {
      return undefined
    }

    try {
      return new Uint8Array(await file.arrayBuffer())
    } catch {
      return null
    }
  }

  async function runRecovery(
    expected: number,
    image: ImageRecord,
    settings: BatchSettings,
    resolution: Extract<ReturnType<typeof resolveSettings>, { kind: 'resolved' }>,
    miss: SizeTargetUnreachableResult,
  ): Promise<void> {
    if (!options.allowRecovery.value || image.isAnimated) {
      recoveryPhase.value = 'done'
      return
    }

    recoveryPhase.value = 'checking'

    if (image.sourceFormat === 'png' && resolution.settings.format === 'png') {
      const jpeg = resolveSettings(image, { ...settings, format: 'jpeg' })

      if (jpeg.kind === 'resolved') {
        const source = await sourceBytes(image)

        if (source instanceof Uint8Array && generation === expected) {
          const job: JpegRecoveryJob = {
            kind: 'jpeg-recovery',
            imageId: image.id,
            source,
            edit: image.edit,
            settings: jpeg.settings,
          }
          const outcome = await pool.run(job).done

          if (
            generation === expected &&
            outcome.outcome === 'completed' &&
            outcome.result.kind === 'jpeg-recovery'
          ) {
            jpegSuggestion.value = outcome.result.suggestion
          }
        }
      }
    }

    if (generation !== expected) {
      return
    }

    const source = await sourceBytes(image)

    if (source instanceof Uint8Array && generation === expected) {
      const job: DimensionRecoveryJob = {
        kind: 'dimension-recovery',
        imageId: image.id,
        source,
        edit: image.edit,
        settings: resolution.settings,
        targetBytes: miss.targetBytes,
        achievedBytes: miss.achievedBytes,
        width: miss.width,
        height: miss.height,
      }
      const outcome = await pool.run(job).done

      if (
        generation === expected &&
        outcome.outcome === 'completed' &&
        outcome.result.kind === 'dimension-recovery'
      ) {
        dimensionSuggestion.value = outcome.result.suggestion
      }
    }

    if (generation === expected) {
      recoveryPhase.value = 'done'
    }
  }

  async function runEncode(): Promise<void> {
    clearDebounce()

    const liveImage = options.image.value

    if (liveImage === null) {
      phase.value = 'idle'
      return
    }

    const expected = (generation += 1)
    error.value = null
    phase.value = 'encoding'

    // `image` and `settings.quality`/`settings.dimension` are read off reactive store state (the
    // batch array and the settings store), so the values here can be Vue reactive Proxies wrapping
    // the real data. `resolveSettings`'s pass-through branches (an unresolved dimension rule, a
    // `'size'`-kind quality target, a crop's stored background) hand such a value straight through
    // into `ResolvedSettings`, and a Proxy anywhere inside the eventual `Job` fails structured clone
    // the moment `pool.run` posts it to the worker — not a TypeScript error, a runtime
    // `DataCloneError`. `toRaw` strips the top-level proxy; because Vue's nested reactivity is
    // applied lazily when read *through* a reactive parent rather than stored on the target, a
    // single `toRaw` per entry point is enough to make everything reachable from these raw objects
    // plain data, with no need to walk the structure by hand.
    const image = toRaw(liveImage)
    const settings: BatchSettings = {
      quality: toRaw(options.settings.value.quality),
      dimension: toRaw(options.settings.value.dimension),
      format: options.settings.value.format,
    }

    const resolution = resolveSettings(image, settings)

    if (resolution.kind === 'rejected') {
      // Only `animated-avif-input` exists today, and R-F8 means it should have been refused at
      // selection time. It has not been, so Preview says so rather than showing an empty frame.
      fail({ kind: 'animated-avif' })
      return
    }

    const source = await sourceBytes(image)

    if (source === undefined) {
      fail({ kind: 'source-missing' })
      return
    }

    if (source === null) {
      fail({ kind: 'decode-failed' })
      return
    }

    // The read is asynchronous, so the frame may have moved on while it ran.
    if (generation !== expected) {
      return
    }

    const job: Job = {
      imageId: image.id,
      source,
      edit: image.edit,
      settings: resolution.settings,
      intent: 'preview',
    }
    const outcome = await pool.run(job).done

    if (generation !== expected) {
      return
    }

    if (outcome.outcome === 'completed') {
      if (outcome.result.kind === 'size-target-unreachable') {
        releaseCompressed()
        unreachable.value = outcome.result
        phase.value = 'unreachable'
        void runRecovery(expected, image, settings, resolution, outcome.result)
        return
      }

      if (outcome.result.kind !== 'output') {
        fail({ kind: 'encode-failed' })
        return
      }

      // The cast is for `ArrayBufferLike`, which `Uint8Array`'s buffer parameter defaults to and
      // which admits `SharedArrayBuffer` — the same cast `pipeline/stages/gif.ts` documents. These
      // bytes arrived over `postMessage`, and a `SharedArrayBuffer` cannot be transferred at all
      // (and would need the cross-origin isolation `platform/capability.ts` treats as absent), so
      // the buffer behind them is a plain `ArrayBuffer` by construction.
      const bytes = outcome.result.bytes as Uint8Array<ArrayBuffer>
      const blob = new Blob([bytes], { type: mimeForFormat(outcome.result.format) })

      // Revoked immediately before the replacement exists, so the two are never both retained.
      releaseCompressed()
      compressedUrl.value = URL.createObjectURL(blob)
      compressedBytes.value = outcome.result.bytes.byteLength
      phase.value = 'ready'
      return
    }

    if (outcome.outcome === 'failed') {
      fail(describeFailure(outcome.reason, resolution.settings.format))
      return
    }

    // `superseded` is the one outcome that means "something newer is already on its way", so the
    // frame keeps waiting. `cancelled` and `terminated` mean nothing further is coming for this
    // request, and a frame left reading "Creating preview" for ever would be exactly the silent
    // failure P1 forbids.
    if (outcome.outcome !== 'superseded') {
      fail({ kind: 'encode-failed' })
    }
  }

  function scheduleEncode(): void {
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runEncode()
    }, PREVIEW_DEBOUNCE_MS)
  }

  watch(
    (): EncodeSnapshot => ({
      id: options.image.value?.id ?? null,
      settings: options.settings.value,
      editVersion: options.image.value?.edit?.version ?? null,
    }),
    (next, previous) => {
      if (previous === undefined || next.id !== previous.id) {
        // R-P7/R-B5: the outgoing image's working set is released here, synchronously, before
        // anything is asked of the incoming one. `runEncode` only reaches the pool after an await.
        releaseWorkingSet()
        generation += 1

        if (next.id === null) {
          phase.value = 'idle'
          return
        }

        void runEncode()
        return
      }

      // Same image, changed output settings (R-P3). The in-flight job is left to run and its result
      // is discarded on arrival (R-X28), which is the pool's own behaviour; what happens here is that
      // the now-stale result stops being shown immediately (R-B1, R-P4).
      generation += 1
      releaseCompressed()
      error.value = null
      phase.value = 'encoding'
      scheduleEncode()
    },
    { deep: true, immediate: true },
  )

  // The source is decoded only once the Original tab actually asks for it: the Compressed tab is the
  // default (R-P2), so a user who never flips never pays for a second full-resolution decode (R-B2).
  // Ordered after the watcher above, so an image change has already released the previous URL.
  watch(
    [(): ImageId | null => options.image.value?.id ?? null, options.wantsOriginal],
    ([id, wantsOriginal]) => {
      if (!wantsOriginal || id === null || originalUrl.value !== null) {
        return
      }

      const file = getSourceFile(id)

      if (file === undefined) {
        return
      }

      originalUrl.value = URL.createObjectURL(file)
    },
    { immediate: true },
  )

  // Leaving Preview unmounts this scope, which is where R-M4's "release the outgoing mode's data"
  // actually happens. The pool itself survives, keeping its codecs loaded (see preview-pool.ts).
  onScopeDispose(() => {
    releaseWorkingSet()
    generation += 1
    // R-X26: queued jobs settle as cancelled and no further recovery step can be dispatched. A
    // codec call already inside WASM finishes in its worker and is discarded; terminating it would
    // pay R-X29's codec reload cost on ordinary navigation.
    pool.cancel()
  })

  return {
    phase,
    compressedUrl,
    compressedBytes,
    originalUrl,
    originalUnrenderable,
    error,
    unreachable,
    recoveryPhase,
    jpegSuggestion,
    dimensionSuggestion,
    retry: () => {
      void runEncode()
    },
    reportOriginalUnrenderable: () => {
      originalUnrenderable.value = true
    },
  }
}

/** Maps a pipeline failure onto the message Preview shows for it (§10). */
function describeFailure(reason: JobFailure, format: EncodableFormat): PreviewEncodeError {
  switch (reason.kind) {
    case 'decode-failed':
      return { kind: 'decode-failed' }
    case 'out-of-memory':
      return { kind: 'out-of-memory' }
    case 'unimplemented':
      return { kind: 'unsupported', format }
    default:
      return { kind: 'encode-failed' }
  }
}
