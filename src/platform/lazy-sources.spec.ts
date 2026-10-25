import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { ImageId } from '@/domain/types'
import { createDimensionProbeService } from './dimension-probe'
import { createThumbnailService, type ThumbnailSource } from './thumbnails'
import type { ThumbnailJobRequest } from './thumbnail-render'

const workers: StubWorker[] = []

class StubWorker {
  postMessage = vi.fn()
  terminate = vi.fn()
  listeners = new Map<string, (event: { data: unknown }) => void>()

  constructor() {
    workers.push(this)
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, listener)
  }

  respond(data: unknown): void {
    this.listeners.get('message')?.({ data })
  }
}

beforeEach(() => {
  workers.length = 0
  vi.stubGlobal('Worker', StubWorker)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function thumbnail(id: string, blob: ThumbnailSource['blob']): ThumbnailSource {
  return { id: id as ImageId, blob, source: { width: 1, height: 1 }, edit: null }
}

describe('lazy source reads', () => {
  it('does not load queued thumbnails or dispatch a read that finishes after stop', async () => {
    let finish!: (blob: Blob) => void
    const first = vi.fn(() => new Promise<Blob>((resolve) => (finish = resolve)))
    const second = vi.fn(async () => new Blob(['b']))
    const service = createThumbnailService()
    service.setVisible([thumbnail('a', first), thumbnail('b', second)])
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()

    service.stop()
    finish(new Blob(['a']))
    await flushPromises()

    expect(workers[0]?.postMessage).not.toHaveBeenCalled()
    expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    expect(service.stats()).toMatchObject({ running: false, retained: 0 })
    expect(second).not.toHaveBeenCalled()
  })

  it('discards an old thumbnail read without disturbing a newly started generation', async () => {
    let finish!: (blob: Blob) => void
    const service = createThumbnailService()
    service.setVisible([thumbnail('a', () => new Promise<Blob>((resolve) => (finish = resolve)))])
    service.stop()
    service.setVisible([thumbnail('b', new Blob(['b']))])
    const worker = workers[1]!
    const request = worker.postMessage.mock.calls[0]?.[0] as ThumbnailJobRequest

    finish(new Blob(['a']))
    await flushPromises()
    expect(workers[0]?.postMessage).not.toHaveBeenCalled()
    expect(service.stats().running).toBe(true)

    worker.respond({ token: request.token, id: 'b', ok: true, blob: new Blob(['thumb']) })
    await service.whenIdle()
    expect(service.urlFor('b' as ImageId)).toBe('blob:thumbnail')
    expect(service.urlFor('a' as ImageId)).toBeNull()
    service.clear()
  })

  it('cancels a pending dimension-source read without starving the next probe', async () => {
    let finish!: (file: File) => void
    const service = createDimensionProbeService()
    service.enqueue('a' as ImageId, () => new Promise<File>((resolve) => (finish = resolve)))
    service.enqueue('b' as ImageId, new File(['b'], 'b.png'))

    service.cancel('a' as ImageId)
    expect(workers[0]?.postMessage).toHaveBeenCalledOnce()
    expect(workers[0]?.postMessage.mock.calls[0]?.[0]).toMatchObject({ id: 'b' })
    finish(new File(['a'], 'a.png'))
    await flushPromises()
    expect(workers[0]?.postMessage).toHaveBeenCalledOnce()
    service.clear()
  })

  it('retries a dimension source after pause and ignores the previous read completion', async () => {
    let finish!: (file: File) => void
    const source = vi.fn(() => new Promise<File>((resolve) => (finish = resolve)))
    const service = createDimensionProbeService()
    service.enqueue('a' as ImageId, source)
    const firstRead = finish
    service.stop()
    service.resume()
    expect(source).toHaveBeenCalledTimes(2)

    firstRead(new File(['a'], 'a.png'))
    await flushPromises()
    expect(workers[0]?.postMessage).not.toHaveBeenCalled()
    expect(workers[1]?.postMessage).not.toHaveBeenCalled()

    finish(new File(['a'], 'a.png'))
    await flushPromises()
    expect(workers[1]?.postMessage).toHaveBeenCalledOnce()
    service.clear()
  })
})
