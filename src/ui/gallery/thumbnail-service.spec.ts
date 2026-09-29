import { describe, expect, it, vi } from 'vitest'

const onReadyCallbacks: Array<(id: string) => void> = []
const createThumbnailServiceMock = vi.fn((options: { onReady?: (id: string) => void }) => {
  if (options.onReady) {
    onReadyCallbacks.push(options.onReady)
  }
  return { stats: () => ({ budget: 100 }) }
})
vi.mock('@/platform/thumbnails', () => ({
  createThumbnailService: (options: { onReady?: (id: string) => void }) =>
    createThumbnailServiceMock(options),
}))

// Imported after the mock above so it picks up the mocked module.
const { getThumbnailService, thumbnailTick } = await import('./thumbnail-service')

describe('getThumbnailService', () => {
  it('creates the underlying service only once and reuses it on repeated calls', () => {
    const first = getThumbnailService()
    const second = getThumbnailService()

    expect(second).toBe(first)
    expect(createThumbnailServiceMock).toHaveBeenCalledTimes(1)
  })

  it('bumps thumbnailTick whenever the underlying service reports a ready thumbnail', () => {
    getThumbnailService()
    const before = thumbnailTick.value

    onReadyCallbacks[0]?.('some-id')

    expect(thumbnailTick.value).toBe(before + 1)
  })
})
