// The single runtime configuration module for operational limits (Technical Design §8.3).
//
// Services read their limits from here and accept an override, so changing a limit is one edit and
// needs no change to the service that enforces it. Each value's provenance (measured, derived or
// estimated, and from what) is tabulated in Functional Design §5.7; this file does not repeat it.

/**
 * What one pipeline worker's ImageMagick may hold, and the selection-time caps derived from it.
 * Produced only by `deriveCodecLimits`, so the three numbers cannot drift apart.
 */
export interface CodecLimits {
  /**
   * ImageMagick's pixel-cache budget for one worker. Applied as `ResourceLimits.memory` with the
   * disk spill switched off, which turns an over-budget decode into a catchable error instead of an
   * allocation that runs until the tab dies.
   */
  cacheBytes: number
  /** Largest single image, in pixels (`ResourceLimits.area`, and the selection-time cap). */
  maximumImagePixels: number
  /** Largest animation, in frames x width x height. */
  maximumAnimationFramePixels: number
  /** Most frames an animation may have. */
  maximumAnimationFrames: number
}

/**
 * Worst-case bytes ImageMagick's cache charges per pixel: RGBA at 16-bit quantum. Measured (T50):
 * a 48 MP RGBA image decoded under a 384 MiB limit and not under 256 MiB (5.6 to 8.4 bytes per pixel).
 */
const CACHE_BYTES_PER_PIXEL = 8

/**
 * A still keeps its source cache alive while an edit or resize builds the next one, so the budget
 * has to hold two. A rotation at the cap would otherwise fail on an image the cap admitted.
 */
const STILL_CACHES = 2

/**
 * An animation's frames exist twice in ImageMagick (read, then coalesced) and once more as the
 * owned buffers the worker transfers (C7: 2.3x to 2.8x the RGBA8 frame data in total). Eight bytes
 * for the cache and one RGBA8 copy on top, doubled for the second set, rounds to this.
 */
const ANIMATION_BYTES_PER_PIXEL = 24

export function deriveCodecLimits(cacheBytes: number, maximumAnimationFrames: number): CodecLimits {
  return {
    cacheBytes,
    maximumImagePixels: Math.floor(cacheBytes / (CACHE_BYTES_PER_PIXEL * STILL_CACHES)),
    maximumAnimationFramePixels: Math.floor(cacheBytes / ANIMATION_BYTES_PER_PIXEL),
    maximumAnimationFrames,
  }
}

export interface RuntimeLimits {
  /** Codec budget for a worker on a desktop. Three of these run at once (`maximumWorkers`). */
  desktopCodec: CodecLimits

  /**
   * Codec budget for a worker on a mobile device, where there is one worker. **Estimated**, not
   * measured: no iPhone was available. It must keep admitting a 50 MP phone photo; if a device
   * cannot hold that, the answer is a cheaper pipeline for that photo, not a lower cap.
   */
  mobileCodec: CodecLimits

  /**
   * Ceiling on both source-read attempts and retained thumbnail Blobs, per batch (R-G3, R-G10).
   * An attempt is charged when a read starts and is never refunded or replenished.
   */
  maximumThumbnails: number

  /**
   * Cap on concurrent pipeline workers on a desktop (Technical Design §5.1). The cap exists because
   * concurrency multiplies peak memory and memory, not CPU, is the binding constraint (R-X8, R-B2).
   */
  maximumWorkers: number

  /**
   * Pipeline workers on a mobile device (Technical Design §5.1). **Contingent on C3 and C4**, both
   * low confidence: if iOS proves tighter than expected this stays at one and the batch cap drops.
   */
  mobileWorkers: number

  /**
   * Cores held back from the worker pool for the UI thread — the `- 1` in §5.1's
   * `min(hardwareConcurrency - 1, 3)`.
   */
  reservedCores: number

  /**
   * R-X29's threshold: how long a single job may run before its worker is terminated and recreated,
   * or `null` for no watchdog. **Deliberately unmeasured and therefore null.** Technical Design §5.3
   * says this "is set from measured re-init cost, not guessed", and T21 loads no codec, so it has no
   * re-init cost to measure. Whoever measures one sets the number here — the mechanism it drives is
   * already built and tested in `pipeline/pool.ts`.
   */
  jobTimeoutMs: number | null

  /**
   * Selection-time rejection cap (R-I20, §10 "File exceeds size or pixel cap"). **Provisional** —
   * no measured value exists yet; T50 owns the real figure. Byte-size only: a true pixel-cap check
   * would need decoded dimensions, which T33-A deliberately resolves asynchronously after an image
   * already appears in the grid, not synchronously during selection (see docs/task-notes/T39.md).
   */
  maximumFileBytes: number

  /**
   * Selection-time rejection cap on total images per batch (§5.7 "Files per batch", R-I20, §10
   * "Batch exceeds file count"). **Provisional** — the inherited 200-file figure was never measured
   * (assumptions.md C3); T50 owns the real figure. Distinct from `folder.ts`'s own
   * `maximumTraversalFiles`, which caps one folder's traversal, not the whole batch across every
   * selection made so far.
   */
  maximumBatchFiles: number

  /**
   * Deepest folder nesting a selection may have, and most files one folder selection may contain
   * (Functional Design §5.3, R-I30). **Structural**: generous enough for any real tree, and a
   * bound on the traversal itself rather than on memory.
   */
  maximumTraversalDepth: number
  maximumTraversalFiles: number

  /**
   * Allowance per individual Share copy in the quota preflight (Technical Design §9.2). **Estimated**:
   * a conservative filesystem and metadata figure, not a measurement.
   */
  shareCopyOverheadBytes: number

  /**
   * Fixed product ceiling on accepted images a run may start with and still retain Share output
   * (R-X47). Technical Design §8.3: unlike every other limit here, this one is not provisional —
   * T39-A measured that total bytes, not file count, is the binding constraint (10 real
   * mixed-format files at ~9.8 MB shared fine everywhere tested), so there is no pending
   * re-measurement that would change it.
   */
  maximumShareFiles: number

  /**
   * Total successful-output bytes above which Share is withheld (R-X48, R-X52). Measured in T39-A
   * (`docs/task-notes/T39-A.md`, assumptions.md E4): macOS Chrome's `share()` reliably failed with
   * `NotAllowedError` at 60 MB and reliably succeeded at 50 MB, the tightest boundary of every
   * engine/device tested (including real Android) — `canShare` does not catch this on its own.
   * 40 MB is a safety margin under that measured 50 MB-safe boundary, not the boundary itself.
   * **Provisional** — T50 re-measures on a real, older, low-memory iPhone and may lower it.
   */
  maximumShareBytes: number
}

const MiB = 1024 * 1024

export const runtimeLimits: RuntimeLimits = {
  desktopCodec: deriveCodecLimits(1024 * MiB, 500),
  mobileCodec: deriveCodecLimits(800 * MiB, 500),
  maximumThumbnails: 100,
  maximumWorkers: 3,
  mobileWorkers: 1,
  reservedCores: 1,
  jobTimeoutMs: null,
  maximumFileBytes: 100 * 1024 * 1024,
  maximumBatchFiles: 500,
  maximumTraversalDepth: 32,
  maximumTraversalFiles: 2000,
  shareCopyOverheadBytes: 4096,
  maximumShareFiles: 10,
  maximumShareBytes: 40 * 1024 * 1024,
}

export interface WorkerPoolEnvironment {
  /** `navigator.hardwareConcurrency`, which is allowed to be absent. */
  hardwareConcurrency?: number
  /**
   * Whether this is a mobile device. The environment decides what "mobile" means — this module only
   * holds the two sizes. See `pipeline/pool.ts` for the detection and why it is not UA sniffing.
   */
  mobile: boolean
}

/**
 * Technical Design §5.1's pool size: `min(hardwareConcurrency - 1, 3)` on desktop, `1` on mobile.
 *
 * Pure, so the formula is unit-testable and the three numbers it reads stay in this one module —
 * changing a limit is one edit here and needs no change to the pool (§8.3). An unknown or
 * nonsensical `hardwareConcurrency` resolves to one worker rather than to the cap: memory is the
 * binding constraint, so guessing high on an unknown device is the failure this is avoiding.
 */
export function resolveWorkerPoolSize(
  environment: WorkerPoolEnvironment,
  limits: RuntimeLimits = runtimeLimits,
): number {
  if (environment.mobile) {
    return Math.max(1, limits.mobileWorkers)
  }

  const cores = environment.hardwareConcurrency

  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores < 1) {
    return 1
  }

  return Math.max(1, Math.min(Math.floor(cores) - limits.reservedCores, limits.maximumWorkers))
}

/**
 * The codec budget for this device class. The strict mobile budget is the answer when the class is
 * unknown, because a budget that is too small fails one image and one that is too large loses the tab.
 */
export function resolveCodecLimits(
  mobile: boolean | undefined,
  limits: RuntimeLimits = runtimeLimits,
): CodecLimits {
  return mobile === false ? limits.desktopCodec : limits.mobileCodec
}

/**
 * R-G8's automatic Gallery view-mode rule: list always for folder-sourced input, otherwise list
 * once the batch reaches the same budget the thumbnail cache uses. T20 measured this threshold
 * and recommended reusing `maximumThumbnails` rather than tuning a second constant (docs/task-
 * notes/T20.md) — above that budget, grid mode can't give every tile a thumbnail anyway, which is
 * exactly the case list mode serves better. Pure and limits-injectable for the same reason
 * `resolveWorkerPoolSize` is: a test can inject a small threshold without mutating the shared
 * `runtimeLimits` singleton.
 */
export function resolveAutomaticGalleryView(
  count: number,
  folderSourced: boolean,
  limits: RuntimeLimits = runtimeLimits,
): 'grid' | 'list' {
  if (folderSourced) {
    return 'list'
  }

  return count >= limits.maximumThumbnails ? 'list' : 'grid'
}
