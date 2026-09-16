// The pipeline worker (Technical Design §5.1, §5.3). One job at a time, by construction: this loop
// awaits `executeJob` before it looks at the next message, which is §8.1's "one full-resolution
// decode in flight per worker, released before the next".
//
// Nothing but the message loop lives here. The work is `execute.ts` (the §4.2 stage chain) and the
// protocol is `protocol.ts`, so the pool can speak the protocol without importing this module and
// the stages can be unit-tested without a worker.

import { JobExecutionError, executeJob } from './execute'
import type { JobFailure, WorkerRequest, WorkerResponse } from './protocol'
import { DecodeError } from './stages/decode'
import { UnsupportedColourError } from './stages/encode'

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

// The worker's half of the between-jobs flag (§5.3): the highest token cancellation has reached.
// Because tokens are monotonic, comparing against it refuses exactly the jobs queued before the
// cancel and accepts everything a resumed pool sends afterwards.
let cancelledThrough = 0

function reasonFor(error: unknown): JobFailure {
  if (error instanceof JobExecutionError || error instanceof UnsupportedColourError) {
    return { kind: 'unimplemented', detail: error.detail }
  }

  if (error instanceof DecodeError) {
    return { kind: 'decode-failed' }
  }

  // A `RangeError` from an allocation the WASM heap could not satisfy is the out-of-memory shape
  // browsers actually produce; anything else that escapes a stage is an encode failure.
  return error instanceof RangeError ? { kind: 'out-of-memory' } : { kind: 'encode-failed' }
}

scope.addEventListener('message', (event) => {
  const message = event.data

  if (message.kind === 'cancel') {
    cancelledThrough = Math.max(cancelledThrough, message.through)
    return
  }

  const { token, job } = message

  // Checked before starting each job, which is the whole of the worker's cancellation duty (§5.3).
  if (token <= cancelledThrough) {
    scope.postMessage({ kind: 'skipped', token, imageId: job.imageId })
    return
  }

  void executeJob(job).then(
    (result) => {
      // The result bytes are transferred, not copied: the worker has no further use for them, and a
      // copy here would double the encoded output's cost at exactly the moment the next decode is
      // about to allocate.
      scope.postMessage({ kind: 'result', token, imageId: job.imageId, result }, [
        result.bytes.buffer as ArrayBuffer,
      ])
    },
    (error: unknown) => {
      scope.postMessage({ kind: 'error', token, imageId: job.imageId, reason: reasonFor(error) })
    },
  )
})
