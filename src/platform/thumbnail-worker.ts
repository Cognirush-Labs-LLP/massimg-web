// The thumbnail generation context (Technical Design §10.4). Generation runs here, not on the main
// thread, for one reason: `createImageBitmap` has no abort. R-G12 requires that leaving Gallery stops
// every in-flight thumbnail job, and the only way to stop an un-abortable decode is to terminate the
// context running it. The service owns that termination; this file only does the work.
//
// That reason covers the ImageMagick fallback too, which is why it lives here rather than in the
// service. §10.4's fallback decodes a whole image inside a synchronous WASM call — even less
// interruptible than `createImageBitmap` — and on Chromium and Firefox a batch of HEICs routes
// *every* tile through it. Running it on the main thread would satisfy R-G12's "the result is
// discarded" while breaking its "generation stops", and would block the thread it ran on.

import { failureFor, fitWithin, render } from './thumbnail-render'
import type { ThumbnailJobRequest, ThumbnailJobResponse } from './thumbnail-render'
import type { FallbackDecoder } from './thumbnails'

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ThumbnailJobRequest>) => void,
  ): void
  postMessage(message: ThumbnailJobResponse): void
}

const scope = self as unknown as WorkerScope

// Imported on first use, not at module evaluation: `thumbnail-fallback.ts` reaches
// `pipeline/codecs/loader.ts`, and ImageMagick is 14.8 MB (A1, §5.2). A batch the engine can decode
// natively — the overwhelmingly common case — never fetches it.
let fallbackDecoder: Promise<FallbackDecoder> | null = null

function ensureFallbackDecoder(): Promise<FallbackDecoder> {
  if (!fallbackDecoder) {
    fallbackDecoder = import('./thumbnail-fallback').then((module) =>
      module.createImageMagickFallbackDecoder(),
    )
  }
  return fallbackDecoder
}

async function fallback(request: ThumbnailJobRequest): Promise<ThumbnailJobResponse> {
  const { token, id } = request

  try {
    const decode = await ensureFallbackDecoder()
    const blob = await decode({
      blob: request.blob,
      source: request.source,
      // The fallback does not apply the stored edit — `thumbnail-render.ts` owns the op walk and
      // duplicating it here is what §6 warns against — so the ops are deliberately not forwarded
      // rather than passed and ignored.
      edit: null,
      maxEdge: request.maxEdge,
      format: request.format,
      quality: request.quality,
    })
    // The same function the fallback resizes with, called again rather than reimplemented, so the
    // reported dimensions cannot drift from the produced ones.
    const bound = fitWithin(request.source, request.maxEdge)
    return { token, id, ok: true, blob, width: bound.width, height: bound.height }
  } catch {
    // ImageMagick could not read it either. A placeholder is the honest outcome (R-G10).
    return { token, id, ok: false, reason: 'failed' }
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data
  const { token, id } = request

  void render(request).then(
    ({ blob, width, height }) => {
      scope.postMessage({ token, id, ok: true, blob, width, height })
    },
    async (error: unknown) => {
      const reason = failureFor(error)

      // `unsupported` means the engine cannot decode this input, not that the input is bad — the
      // one condition §10.4's fallback exists for.
      if (reason === 'unsupported' && request.allowFallback) {
        scope.postMessage(await fallback(request))
        return
      }

      scope.postMessage({ token, id, ok: false, reason })
    },
  )
})
