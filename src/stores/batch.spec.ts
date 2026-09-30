import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId, ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from './batch'
import { useUiStore } from './ui'

function recordWithId(id: string): ImageRecord {
  return { ...imageRecordFixture, id: id as ImageId, edit: null }
}

function flatRecordWithId(id: string): ImageRecord {
  return { ...recordWithId(id), relativePath: null }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useBatchStore.addImages', () => {
  it('appends in call order and never re-sorts', () => {
    const batch = useBatchStore()

    batch.addImages([recordWithId('b'), recordWithId('a')])
    batch.addImages([recordWithId('c')])

    expect(batch.images.map((image) => image.id)).toEqual(['b', 'a', 'c'])
  })

  it('going from empty straight to one image shows Preview for it (R-M1)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()

    batch.addImages([recordWithId('a')])

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe('a')
  })

  it('going from empty straight to several images stays on Gallery', () => {
    const batch = useBatchStore()
    const ui = useUiStore()

    batch.addImages([recordWithId('a'), recordWithId('b')])

    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('growing past one image while Preview is open returns to Gallery (R-M2)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a')])
    expect(ui.stageMode).toBe('preview')

    batch.addImages([recordWithId('b')])

    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('auto-selects list once a flat batch reaches the maximumThumbnails threshold (R-G8)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()

    batch.addImages(Array.from({ length: 100 }, (_, i) => flatRecordWithId(`f${i}`)))

    expect(ui.galleryView).toBe('list')
  })

  it('auto-selects list for a folder-sourced batch even at count 1 (R-G8, R-G11)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()

    batch.addImages([{ ...recordWithId('a'), relativePath: 'sub/a.jpg' }])

    expect(ui.galleryView).toBe('list')
  })

  it('leaves a small flat batch on grid', () => {
    const batch = useBatchStore()
    const ui = useUiStore()

    batch.addImages([flatRecordWithId('a'), flatRecordWithId('b')])

    expect(ui.galleryView).toBe('grid')
  })

  it('a manual override survives a further add', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([{ ...recordWithId('a'), relativePath: 'sub/a.jpg' }])
    ui.setGalleryView('grid')

    batch.addImages([flatRecordWithId('b')])

    expect(ui.galleryView).toBe('grid')
  })

  it('a manual override survives an intervening clearAll', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([{ ...recordWithId('a'), relativePath: 'sub/a.jpg' }])
    ui.setGalleryView('grid')

    batch.clearAll()
    batch.addImages([{ ...recordWithId('b'), relativePath: 'sub/b.jpg' }])

    expect(ui.galleryView).toBe('grid')
  })
})

describe('useBatchStore.removeImage', () => {
  it('removes only the targeted record, leaving others as the same object reference (R-G2)', () => {
    const batch = useBatchStore()
    batch.addImages([recordWithId('a'), recordWithId('b'), recordWithId('c')])
    const untouched = batch.images[1]

    batch.removeImage('a' as ImageId)

    expect(batch.images.map((image) => image.id)).toEqual(['b', 'c'])
    expect(batch.images[0]).toBe(untouched)
  })

  it('removing the current image with two remaining goes to Gallery', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a'), recordWithId('b'), recordWithId('c')])
    ui.openPreview('a' as ImageId)

    batch.removeImage('a' as ImageId)

    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('removing the current image down to exactly one remaining shows Preview of it', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a'), recordWithId('b')])
    ui.openPreview('a' as ImageId)

    batch.removeImage('a' as ImageId)

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe('b')
  })

  it('removing the last image goes to Gallery (empty state)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a')])

    batch.removeImage('a' as ImageId)

    expect(batch.images).toHaveLength(0)
    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('removing a non-current image never changes stage mode or current image', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a'), recordWithId('b'), recordWithId('c')])
    ui.openPreview('a' as ImageId)

    batch.removeImage('c' as ImageId)

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe('a' as ImageId)
  })

  it('removing an id not in the batch is a no-op', () => {
    const batch = useBatchStore()
    batch.addImages([recordWithId('a')])

    batch.removeImage('missing' as ImageId)

    expect(batch.images).toHaveLength(1)
  })
})

describe('useBatchStore.updateImage', () => {
  it('patches only the targeted record', () => {
    const batch = useBatchStore()
    batch.addImages([recordWithId('a'), recordWithId('b')])

    batch.updateImage('a' as ImageId, { status: 'failed' })

    expect(batch.images[0]?.status).toBe('failed')
    expect(batch.images[1]?.status).toBe('ready')
  })
})

describe('useBatchStore.clearAll', () => {
  it('empties the batch and returns to Gallery with no current image (R-G6)', () => {
    const batch = useBatchStore()
    const ui = useUiStore()
    batch.addImages([recordWithId('a'), recordWithId('b')])
    ui.openPreview('a' as ImageId)

    batch.clearAll()

    expect(batch.images).toHaveLength(0)
    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('clearing an already-empty batch is a no-op', () => {
    const batch = useBatchStore()

    expect(() => batch.clearAll()).not.toThrow()
    expect(batch.images).toHaveLength(0)
  })
})
