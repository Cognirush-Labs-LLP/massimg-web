import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId, ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useUiStore } from './ui'

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

function recordWithId(id: ImageId): ImageRecord {
  return { ...imageRecordFixture, id }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useUiStore initial state', () => {
  it('starts in Gallery with no current image, grid view, closed drawer, Compressed tab', () => {
    const ui = useUiStore()

    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
    expect(ui.galleryView).toBe('grid')
    expect(ui.drawerOpen).toBe(false)
    expect(ui.comparisonTab).toBe('compressed')
  })
})

describe('useUiStore explicit actions', () => {
  it('openPreview sets the current image and switches to Preview', () => {
    const ui = useUiStore()

    ui.openPreview(idA)

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe(idA)
  })

  it('openEdit sets the current image and switches to Edit', () => {
    const ui = useUiStore()

    ui.openEdit(idA)

    expect(ui.stageMode).toBe('edit')
    expect(ui.currentImageId).toBe(idA)
  })

  it('closeEdit returns to Preview without changing the current image', () => {
    const ui = useUiStore()
    ui.openEdit(idA)

    ui.closeEdit()

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe(idA)
  })

  it('backToGallery clears the current image', () => {
    const ui = useUiStore()
    ui.openPreview(idA)

    ui.backToGallery()

    expect(ui.stageMode).toBe('gallery')
    expect(ui.currentImageId).toBeNull()
  })

  it('enterProcessing switches mode and force-closes the drawer', () => {
    const ui = useUiStore()
    ui.openDrawer()

    ui.enterProcessing()

    expect(ui.stageMode).toBe('processing')
    expect(ui.drawerOpen).toBe(false)
  })

  it('cancelProcessing and finishProcessing both return to Gallery', () => {
    const ui = useUiStore()

    ui.enterProcessing()
    ui.cancelProcessing()
    expect(ui.stageMode).toBe('gallery')

    ui.enterProcessing()
    ui.finishProcessing()
    expect(ui.stageMode).toBe('gallery')
  })

  it('openDrawer and closeDrawer toggle drawerOpen only', () => {
    const ui = useUiStore()

    ui.openDrawer()
    expect(ui.drawerOpen).toBe(true)

    ui.closeDrawer()
    expect(ui.drawerOpen).toBe(false)
  })

  it('setGalleryView and setComparisonTab set exactly their own field', () => {
    const ui = useUiStore()

    ui.setGalleryView('list')
    expect(ui.galleryView).toBe('list')
    expect(ui.stageMode).toBe('gallery')

    ui.setComparisonTab('original')
    expect(ui.comparisonTab).toBe('original')
    expect(ui.galleryView).toBe('list')
  })

  it('setGalleryView also records a manual override (R-G8)', () => {
    const ui = useUiStore()
    expect(ui.galleryViewOverridden).toBe(false)

    ui.setGalleryView('list')

    expect(ui.galleryViewOverridden).toBe(true)
  })
})

describe('useUiStore.applyAutomaticGalleryView', () => {
  function flatImages(count: number): ImageRecord[] {
    return Array.from({ length: count }, (_, index) => ({
      ...recordWithId(`f${index}` as ImageId),
      relativePath: null,
    }))
  }

  it('selects grid for a small, loose-file batch', () => {
    const ui = useUiStore()

    ui.applyAutomaticGalleryView(true, flatImages(5))

    expect(ui.galleryView).toBe('grid')
  })

  it('selects list once the batch reaches the configured threshold', () => {
    const ui = useUiStore()

    ui.applyAutomaticGalleryView(true, flatImages(100))

    expect(ui.galleryView).toBe('list')
  })

  it('selects list for folder-sourced input regardless of count', () => {
    const ui = useUiStore()
    const folderImage: ImageRecord = { ...recordWithId(idA), relativePath: 'sub/a.jpg' }

    ui.applyAutomaticGalleryView(true, [folderImage])

    expect(ui.galleryView).toBe('list')
  })

  it('does nothing when the batch was not previously empty', () => {
    const ui = useUiStore()
    ui.setGalleryView('list')
    ui.galleryViewOverridden = false // isolate this test from the override rule below

    ui.applyAutomaticGalleryView(false, flatImages(1))

    expect(ui.galleryView).toBe('list')
  })

  it('does nothing once the user has manually overridden the view this session', () => {
    const ui = useUiStore()
    ui.setGalleryView('grid')

    ui.applyAutomaticGalleryView(true, flatImages(100))

    expect(ui.galleryView).toBe('grid')
  })
})

describe('useUiStore.onBatchCountChanged', () => {
  it('does nothing while Edit or Processing is active', () => {
    const ui = useUiStore()
    ui.openEdit(idA)

    ui.onBatchCountChanged(2, [])

    expect(ui.stageMode).toBe('edit')
  })
})

describe('useUiStore.retargetAfterRemoval', () => {
  it('ignores removal of an image that is not the current one', () => {
    const ui = useUiStore()
    ui.openPreview(idA)

    ui.retargetAfterRemoval(idB, [recordWithId(idA)])

    expect(ui.stageMode).toBe('preview')
    expect(ui.currentImageId).toBe(idA)
  })
})
