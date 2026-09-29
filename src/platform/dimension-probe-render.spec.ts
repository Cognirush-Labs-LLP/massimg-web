import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageId } from '@/domain/types'
import { probe } from './dimension-probe-render'

const idA = 'image-a' as ImageId

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dimension-probe-render', () => {
  it('resolves the natural size and closes the bitmap', async () => {
    const close = vi.fn()
    const createImageBitmap = vi.fn().mockResolvedValue({ width: 640, height: 480, close })
    vi.stubGlobal('createImageBitmap', createImageBitmap)

    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const result = await probe({ token: 1, id: idA, file })

    expect(result).toEqual({ token: 1, id: idA, ok: true, size: { width: 640, height: 480 } })
    expect(createImageBitmap).toHaveBeenCalledWith(file)
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports failure rather than throwing when the engine cannot decode the file', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockRejectedValue(new DOMException('nope', 'NotSupportedError')),
    )

    const file = new File(['x'], 'a.bin', { type: 'application/octet-stream' })
    const result = await probe({ token: 7, id: idA, file })

    expect(result).toEqual({ token: 7, id: idA, ok: false })
  })
})
