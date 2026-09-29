// The dimension probe's actual decode, kept separate from dimension-probe-worker.ts so the
// service and any future test can import the primitive without importing a module whose top
// level installs a worker message listener (same split as thumbnail-render.ts/thumbnail-worker.ts,
// T20).
//
// Deliberately simple: `createImageBitmap` on the whole file, read its natural size, close it
// immediately. No resize, no retained pixels, no crop/rotation replay — T33-A only needs the
// source's true `width`/`height`, not a rendered thumbnail. Runs in a worker because
// `createImageBitmap` cannot be aborted mid-decode, and this must be killable the instant
// compression starts (Processing owns the CPU from then on) — see docs/task-notes/T33-A.md.

import type { PixelSize } from '@/domain/edit'
import type { ImageId } from '@/domain/types'

export interface DimensionProbeRequest {
  /** Echoed back so a response from a terminated/superseded generation is never applied. */
  token: number
  id: ImageId
  file: File
}

export type DimensionProbeResponse =
  | { token: number; id: ImageId; ok: true; size: PixelSize }
  | { token: number; id: ImageId; ok: false }

export async function probe(request: DimensionProbeRequest): Promise<DimensionProbeResponse> {
  try {
    const bitmap = await createImageBitmap(request.file)
    const size: PixelSize = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return { token: request.token, id: request.id, ok: true, size }
  } catch {
    return { token: request.token, id: request.id, ok: false }
  }
}
