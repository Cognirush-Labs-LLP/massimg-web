// The dimension probe's worker context (Technical Design §1.1, docs/task-notes/T33-A.md). Nothing
// here but the message loop — see dimension-probe-render.ts for the decode itself and
// dimension-probe.ts for the service that owns this worker's lifecycle.

import { probe } from './dimension-probe-render'
import type { DimensionProbeRequest, DimensionProbeResponse } from './dimension-probe-render'

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<DimensionProbeRequest>) => void,
  ): void
  postMessage(message: DimensionProbeResponse): void
}

const scope = self as unknown as WorkerScope

scope.addEventListener('message', (event) => {
  void probe(event.data).then((response) => scope.postMessage(response))
})
