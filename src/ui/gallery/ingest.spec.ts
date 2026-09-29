import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Classification } from '@/domain/classify'
import type { FolderSelection } from '@/platform/folder'
import type { SelectedFile } from '@/platform/picker'
import { useBatchStore } from '@/stores/batch'
import { clearSourceFiles, getSourceFile, hasSourceFile } from '@/platform/source-files'

const classifyMock = vi.fn<(bytes: Uint8Array) => Classification>()
vi.mock('@/domain/classify', () => ({ classify: (bytes: Uint8Array) => classifyMock(bytes) }))

const pickFilesMock = vi.fn<() => Promise<SelectedFile[]>>()
vi.mock('@/platform/picker', () => ({ pickFiles: () => pickFilesMock() }))

const pickFolderMock = vi.fn<() => Promise<FolderSelection>>()
const readDroppedFolderMock = vi.fn<(dataTransfer: DataTransfer) => Promise<FolderSelection>>()
vi.mock('@/platform/folder', () => ({
  pickFolder: () => pickFolderMock(),
  readDroppedFolder: (dataTransfer: DataTransfer) => readDroppedFolderMock(dataTransfer),
}))

// Imported after the mocks above so it picks up the mocked modules.
const {
  addViaFilePicker,
  addViaFolderPicker,
  clearGallery,
  dimensionErrors,
  ingestDrop,
  ingestSelectedFiles,
  removeIngestedImage,
} = await import('./ingest')

function selectedFile(name: string, relativePath: string | null = null): SelectedFile {
  return { file: new File(['x'], name, { type: 'image/jpeg' }), relativePath }
}

beforeEach(() => {
  setActivePinia(createPinia())
  classifyMock.mockReset()
  pickFilesMock.mockReset()
  pickFolderMock.mockReset()
  readDroppedFolderMock.mockReset()
  dimensionErrors.clear()
  clearSourceFiles()
})

describe('ingestSelectedFiles', () => {
  it('adds only classify()-supported files, preserving selection order (R-I3, R-G5)', async () => {
    let call = 0
    classifyMock.mockImplementation(() => {
      call += 1
      return call % 2 === 1
        ? { class: 'supported', format: 'jpeg', isAnimated: false }
        : { class: 'not-image' }
    })

    const files = [selectedFile('a.jpg'), selectedFile('b.bin'), selectedFile('c.jpg')]
    await ingestSelectedFiles(files)

    const batch = useBatchStore()
    expect(batch.images.map((image) => image.name)).toEqual(['a.jpg', 'c.jpg'])
  })

  it('builds each record with width/height pending at 0 and stores the source file', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'png', isAnimated: true })
    const file = selectedFile('animated.png', 'folder/animated.png')

    await ingestSelectedFiles([file])

    const batch = useBatchStore()
    const record = batch.images[0]
    expect(record).toMatchObject({
      name: 'animated.png',
      relativePath: 'folder/animated.png',
      sourceFormat: 'png',
      isAnimated: true,
      width: 0,
      height: 0,
      frameCount: null,
      hasTransparency: null,
      edit: null,
      status: 'ready',
      failure: null,
    })
    expect(record?.id).toBeTruthy()
    expect(hasSourceFile(record!.id)).toBe(true)
    expect(getSourceFile(record!.id)).toBe(file.file)
  })

  it('does nothing for an empty selection', async () => {
    await ingestSelectedFiles([])
    expect(useBatchStore().images).toHaveLength(0)
    expect(classifyMock).not.toHaveBeenCalled()
  })
})

describe('addViaFilePicker / addViaFolderPicker', () => {
  it('ingests whatever the file picker returns', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    pickFilesMock.mockResolvedValue([selectedFile('picked.jpg')])

    await addViaFilePicker()

    expect(useBatchStore().images.map((image) => image.name)).toEqual(['picked.jpg'])
  })

  it('ingests the folder picker files on success', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    pickFolderMock.mockResolvedValue({ ok: true, files: [selectedFile('a.jpg', 'root/a.jpg')] })

    await addViaFolderPicker()

    expect(useBatchStore().images.map((image) => image.name)).toEqual(['a.jpg'])
  })

  it('adds nothing when the folder picker reports a cap breach (R-I30)', async () => {
    pickFolderMock.mockResolvedValue({
      ok: false,
      reason: 'file-count-exceeded',
      actual: 3000,
      cap: 2000,
    })

    await addViaFolderPicker()

    expect(useBatchStore().images).toHaveLength(0)
    expect(classifyMock).not.toHaveBeenCalled()
  })
})

describe('ingestDrop', () => {
  it('routes every drop through readDroppedFolder, which already handles loose files too', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    readDroppedFolderMock.mockResolvedValue({ ok: true, files: [selectedFile('dropped.jpg')] })

    const dataTransfer = {} as DataTransfer
    await ingestDrop(dataTransfer)

    expect(readDroppedFolderMock).toHaveBeenCalledWith(dataTransfer)
    expect(useBatchStore().images.map((image) => image.name)).toEqual(['dropped.jpg'])
  })
})

describe('clearGallery', () => {
  it('empties the batch and releases every source file', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    await ingestSelectedFiles([selectedFile('a.jpg'), selectedFile('b.jpg')])
    const batch = useBatchStore()
    const ids = batch.images.map((image) => image.id)
    expect(ids.every((id) => hasSourceFile(id))).toBe(true)

    clearGallery()

    expect(batch.images).toHaveLength(0)
    expect(ids.some((id) => hasSourceFile(id))).toBe(false)
  })
})

describe('removeIngestedImage', () => {
  it('removes one image from the batch and releases only its source file', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    await ingestSelectedFiles([selectedFile('a.jpg'), selectedFile('b.jpg')])
    const batch = useBatchStore()
    const [first, second] = batch.images.map((image) => image.id)

    removeIngestedImage(first!)

    expect(batch.images.map((image) => image.id)).toEqual([second])
    expect(hasSourceFile(first!)).toBe(false)
    expect(hasSourceFile(second!)).toBe(true)
  })
})
