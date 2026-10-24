import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ImageId } from '@/domain/types'
import { editRecordFixture, imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'

const dimensionErrors = new Set<ImageId>()
const removeIngestedImage = vi.fn()
vi.mock('./ingest', () => ({ dimensionErrors, removeIngestedImage }))

const sourceFiles = new Map<ImageId, File>()
vi.mock('@/platform/source-files', () => ({
  getSourceFile: (id: ImageId) => sourceFiles.get(id),
}))

const thumbnailTick = ref(0)
const serviceMock = {
  setVisible: vi.fn(),
  urlFor: vi.fn(() => null as string | null),
  stop: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
  stats: vi.fn(),
  whenIdle: vi.fn(),
}
vi.mock('./thumbnail-service', () => ({
  getThumbnailService: () => serviceMock,
  thumbnailTick,
}))

const GalleryGrid = (await import('./GalleryGrid.vue')).default

function image(id: string) {
  return { ...imageRecordFixture, id: id as ImageId, edit: null }
}

beforeEach(() => {
  setActivePinia(createPinia())
  dimensionErrors.clear()
  removeIngestedImage.mockReset()
  sourceFiles.clear()
  serviceMock.setVisible.mockReset()
  serviceMock.urlFor.mockReset().mockReturnValue(null)
  serviceMock.stop.mockReset()
  thumbnailTick.value = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GalleryGrid', () => {
  it('requests thumbnails for images that have a source file, after the scroll-settle delay', async () => {
    useBatchStore().addImages([image('a'), image('b')])
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))
    sourceFiles.set('b' as ImageId, new File(['x'], 'b.jpg'))

    mount(GalleryGrid)
    await vi.runAllTimersAsync()

    expect(serviceMock.setVisible).toHaveBeenCalled()
    const requested = serviceMock.setVisible.mock.calls.at(-1)?.[0] as { id: ImageId }[]
    expect(requested.map((source) => source.id).sort()).toEqual(['a', 'b'])
  })

  it('omits an image whose dimensions have not been probed yet (R-G3)', async () => {
    // width/height at 0 is dimension-probe's own "not yet known" placeholder (ingest.ts). Sending
    // that straight through would hand the thumbnail service a 0x0 source, which caches a
    // permanent 1x1 degenerate thumbnail with no retry once the real dimensions arrive.
    useBatchStore().addImages([image('a'), { ...image('b'), width: 0, height: 0 }])
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))
    sourceFiles.set('b' as ImageId, new File(['x'], 'b.jpg'))

    mount(GalleryGrid)
    await vi.runAllTimersAsync()

    const requested = serviceMock.setVisible.mock.calls.at(-1)?.[0] as { id: ImageId }[]
    expect(requested.map((source) => source.id)).toEqual(['a'])
  })

  it("requests a thumbnail once a skipped image's dimensions resolve, with no further scrolling", async () => {
    useBatchStore().addImages([{ ...image('a'), width: 0, height: 0 }])
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))

    mount(GalleryGrid)
    await vi.runAllTimersAsync()
    expect(serviceMock.setVisible.mock.calls.at(-1)?.[0]).toEqual([])

    // The dimension probe resolving is exactly `updateImage` patching width/height in place.
    useBatchStore().updateImage('a' as ImageId, { width: 1600, height: 1200 })
    await vi.runAllTimersAsync()

    const requested = serviceMock.setVisible.mock.calls.at(-1)?.[0] as { id: ImageId }[]
    expect(requested.map((source) => source.id)).toEqual(['a'])
  })

  it('hands the service an edit it can post to its worker (structured-clonable)', async () => {
    // The real service posts `edit.ops` to a worker; a reactive Proxy there throws DataCloneError.
    useBatchStore().addImages([image('a')])
    useBatchStore().updateImage('a' as ImageId, { edit: editRecordFixture })
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))

    mount(GalleryGrid)
    await vi.runAllTimersAsync()

    const requested = serviceMock.setVisible.mock.calls.at(-1)?.[0] as { edit: unknown }[]
    expect(requested[0]?.edit).toEqual(editRecordFixture)
    expect(() => structuredClone(requested[0]?.edit)).not.toThrow()
  })

  it('omits images with no source file from the thumbnail request', async () => {
    useBatchStore().addImages([image('a'), image('b')])
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))
    // 'b' deliberately has no source file registered.

    mount(GalleryGrid)
    await vi.runAllTimersAsync()

    const requested = serviceMock.setVisible.mock.calls.at(-1)?.[0] as { id: ImageId }[]
    expect(requested.map((source) => source.id)).toEqual(['a'])
  })

  it('renders a tile per rendered image using the service-provided thumbnail URL', async () => {
    useBatchStore().addImages([image('a')])
    sourceFiles.set('a' as ImageId, new File(['x'], 'a.jpg'))
    serviceMock.urlFor.mockReturnValue('blob:thumb-a')

    const wrapper = mount(GalleryGrid)
    await vi.runAllTimersAsync()
    await wrapper.vm.$nextTick()

    const tile = wrapper.find('[data-testid="gallery-tile"]')
    expect(tile.exists()).toBe(true)
    expect(tile.find('img').attributes('src')).toBe('blob:thumb-a')
  })

  it('stops thumbnail generation on unmount, leaving the cache in place (R-G12)', async () => {
    useBatchStore().addImages([image('a')])
    const wrapper = mount(GalleryGrid)
    await vi.runAllTimersAsync()

    wrapper.unmount()

    expect(serviceMock.stop).toHaveBeenCalledTimes(1)
    expect(serviceMock.clear).not.toHaveBeenCalled()
  })
})
