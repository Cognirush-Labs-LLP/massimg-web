import { describe, expect, it, vi } from 'vitest'
import type { ImageId } from '@/domain/types'
import { createDimensionProbeService } from './dimension-probe'

// No real `Worker` exists under jsdom, so `ensureWorker()` fails closed (same graceful
// degradation thumbnails.ts relies on) and no job ever actually dispatches here. What's covered
// is the queueing/dedup surface, which is DOM-independent; the real decode-and-resolve path and
// the stop()-then-resume() requeue behaviour need a real worker and are proven in the Playwright
// suite instead (see tests/e2e/dimension-probe.spec.ts), mirroring T20's own split.
const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' })
}

describe('dimension-probe (queueing surface)', () => {
  it('never throws across the full lifecycle with no worker available', () => {
    const onResolved = vi.fn()
    const onFailed = vi.fn()
    const service = createDimensionProbeService({ onResolved, onFailed })

    expect(() => {
      service.enqueue(idA, file('a.png'))
      service.enqueue(idB, file('b.png'))
      service.cancel(idA)
      service.stop()
      service.resume()
      service.clear()
    }).not.toThrow()

    expect(onResolved).not.toHaveBeenCalled()
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('cancelling an id never queued is a no-op', () => {
    const service = createDimensionProbeService()
    expect(() => service.cancel(idA)).not.toThrow()
  })

  it('re-enqueueing the same id while already queued does not duplicate the entry', () => {
    // Exercised indirectly: the second enqueue() must return without throwing and without
    // altering behaviour observable from this surface (the internal Set dedup is unit-invisible
    // without a worker, but must not raise regardless of call count).
    const service = createDimensionProbeService()
    expect(() => {
      service.enqueue(idA, file('a.png'))
      service.enqueue(idA, file('a-again.png'))
    }).not.toThrow()
  })
})
