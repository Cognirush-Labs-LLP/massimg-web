// The pipeline worker's message protocol (Technical Design §5.1, §5.3): job in, result or error out,
// with a monotonic token per job.
//
// Kept separate from worker.ts so the pool can import the types without importing a module whose top
// level installs a message listener, and separate from pool.ts so the worker does not pull main-thread
// code into its bundle. Same split as thumbnail-render.ts / thumbnail-worker.ts / thumbnails.ts.

import type { Caveat, EncodableFormat, FailureReason, ImageId, Job } from '@/domain/types'

declare const jobTokenBrand: unique symbol

/**
 * Identifies one dispatched job. Monotonic (§5.3) so that "newer" is a comparison rather than a
 * lookup, and branded so a token cannot be confused with a count or an index.
 */
export type JobToken = number & { readonly [jobTokenBrand]: true }

let lastToken = 0

/**
 * The next token. Module scope rather than per-pool: tokens are then unique across every pool and
 * every worker in the session, which is what makes a stale response identifiable on arrival no
 * matter which worker delivered it.
 */
export function nextToken(): JobToken {
  lastToken += 1
  return lastToken as JobToken
}

/**
 * The pipeline-level reasons a job did not produce bytes. `FailureReason` (the domain's
 * decode/encode/out-of-memory set) is reused rather than restated.
 *
 * `unimplemented` is what the worker returns while no stage exists to run: T21 builds the protocol
 * and the pool, and T23-T29 build the stages the worker will execute (§4.2). It is deliberately a
 * distinct reason rather than a fabricated `encode-failed`, and it disappears when those tasks land.
 */
export type JobFailure = FailureReason | { kind: 'unimplemented'; detail: string }

export interface JobResult {
  /**
   * The encoded output. `bytes.byteLength` is §4's "measured size" — it is not restated as a second
   * field, because two sources of truth for one number is how they come to disagree.
   */
  bytes: Uint8Array
  /** What was actually produced: R-F6's animated substitution can differ from what was requested. */
  format: EncodableFormat
  /** The report's caveat list (§4). Empty for `intent: 'preview'`, which returns bytes and size only. */
  caveats: Caveat[]
}

export type WorkerRequest =
  | { kind: 'run'; token: JobToken; job: Job }
  /**
   * The worker's half of the between-jobs flag (§5.3): the worker refuses to start any job whose
   * token is at or below `through`. It cannot interrupt a WASM call already entered — that is the
   * constraint the whole cancellation design is built around — so it only catches a `run` still
   * sitting unread in the worker's own message queue.
   *
   * `through` is a token rather than a boolean so that cancelling does not poison the worker: a
   * resumed pool issues higher tokens, which this worker will still accept, and R-X17's "run again"
   * therefore costs no codec re-initialisation.
   */
  | { kind: 'cancel'; through: JobToken }

export type WorkerResponse =
  | { kind: 'result'; token: JobToken; imageId: ImageId; result: JobResult }
  | { kind: 'error'; token: JobToken; imageId: ImageId; reason: JobFailure }
  /**
   * The between-jobs flag refused this job: it never started. Answering rather than staying silent
   * is what keeps the pool's slot from leaking — a dispatched job that never replies would hold its
   * worker for the rest of the session.
   */
  | { kind: 'skipped'; token: JobToken; imageId: ImageId }
