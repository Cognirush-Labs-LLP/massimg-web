// The thumbnail generation context (Technical Design §10.4). Generation runs here, not on the main
// thread, for one reason: `createImageBitmap` has no abort. R-G12 requires that leaving Gallery stops
// every in-flight thumbnail job, and the only way to stop an un-abortable decode is to terminate the
// context running it. The service owns that termination; this file only does the work.

import { failureFor, render } from './thumbnail-render'
import type { ThumbnailJobRequest, ThumbnailJobResponse } from './thumbnail-render'

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ThumbnailJobRequest>) => void,
  ): void
  postMessage(message: ThumbnailJobResponse): void
}

const scope = self as unknown as WorkerScope

scope.addEventListener('message', (event) => {
  const { token, id } = event.data

  void render(event.data).then(
    ({ blob, width, height }) => {
      scope.postMessage({ token, id, ok: true, blob, width, height })
    },
    (error: unknown) => {
      scope.postMessage({ token, id, ok: false, reason: failureFor(error) })
    },
  )
})
