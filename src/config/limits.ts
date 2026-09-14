// The single runtime configuration module for operational limits (Technical Design §8.3).
//
// T46 owns the measured values and will grow this module to cover every limit in Functional Design
// §5.7. Everything here is a shipped default named by a design document, not a measured figure:
// services read them from here and accept an override, so changing a limit is one edit and needs no
// change to the service that enforces it.

export interface RuntimeLimits {
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
}

export const runtimeLimits: RuntimeLimits = {
  maximumThumbnails: 100,
  maximumWorkers: 3,
  mobileWorkers: 1,
  reservedCores: 1,
  jobTimeoutMs: null,
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
