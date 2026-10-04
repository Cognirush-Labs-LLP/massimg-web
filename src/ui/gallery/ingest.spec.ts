import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Classification } from '@/domain/classify'
import type { Capabilities } from '@/platform/capability'
import type { FolderSelection } from '@/platform/folder'
import type { SelectedFile } from '@/platform/picker'
import { runtimeLimits } from '@/config/limits'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'
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

const DEFAULT_CAPABILITIES: Capabilities = {
  opfs: true,
  folderPicker: true,
  crossOriginIsolated: false,
  heicDecode: true,
}
const getCapabilitiesMock = vi.fn<() => Promise<Capabilities>>()
vi.mock('@/platform/capability', () => ({ getCapabilities: () => getCapabilitiesMock() }))

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

const originalMaximumFileBytes = runtimeLimits.maximumFileBytes
const originalMaximumBatchFiles = runtimeLimits.maximumBatchFiles

beforeEach(() => {
  setActivePinia(createPinia())
  classifyMock.mockReset()
  pickFilesMock.mockReset()
  pickFolderMock.mockReset()
  readDroppedFolderMock.mockReset()
  getCapabilitiesMock.mockReset()
  getCapabilitiesMock.mockResolvedValue(DEFAULT_CAPABILITIES)
  dimensionErrors.clear()
  clearSourceFiles()
})

afterEach(() => {
  runtimeLimits.maximumFileBytes = originalMaximumFileBytes
  runtimeLimits.maximumBatchFiles = originalMaximumBatchFiles
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
      skipReason: null,
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

  it('auto-switches to list view for a one-shot selection over the threshold, even though it is flushed to the store in chunks (R-G8)', async () => {
    // FLUSH_CHUNK_SIZE (25) is well under maximumThumbnails (100, the default R-G8 threshold) —
    // a batch this size crosses the threshold only once every chunk has landed, not within the
    // first one, which is exactly what this test is guarding.
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    const files = Array.from({ length: 150 }, (_, i) => selectedFile(`img-${i}.jpg`))

    await ingestSelectedFiles(files)

    expect(useBatchStore().images).toHaveLength(150)
    expect(useUiStore().galleryView).toBe('list')
  })

  it('stays on grid view for a one-shot selection under the threshold (sanity check)', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    const files = Array.from({ length: 10 }, (_, i) => selectedFile(`img-${i}.jpg`))

    await ingestSelectedFiles(files)

    expect(useUiStore().galleryView).toBe('grid')
  })

  it('does not override a view the user already picked by hand mid-selection', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    useUiStore().setGalleryView('grid')
    const files = Array.from({ length: 150 }, (_, i) => selectedFile(`img-${i}.jpg`))

    await ingestSelectedFiles(files)

    expect(useUiStore().galleryView).toBe('grid')
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

  it('adds nothing when the folder picker reports a cap breach, and records it as a rejection (R-I30)', async () => {
    pickFolderMock.mockResolvedValue({
      ok: false,
      reason: 'file-count-exceeded',
      actual: 3000,
      cap: 2000,
    })

    await addViaFolderPicker()

    expect(useBatchStore().images).toHaveLength(0)
    expect(classifyMock).not.toHaveBeenCalled()
    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({
        name: null,
        reason: { kind: 'folder-file-count-exceeded', actual: 3000, cap: 2000 },
      }),
    ])
  })

  it('reports a folder depth breach distinctly from a file-count breach (R-I30)', async () => {
    pickFolderMock.mockResolvedValue({ ok: false, reason: 'depth-exceeded', actual: 40, cap: 32 })

    await addViaFolderPicker()

    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({
        name: null,
        reason: { kind: 'folder-depth-exceeded', actual: 40, cap: 32 },
      }),
    ])
  })
})

describe('selection-time rejections (T39)', () => {
  it('names an unhandled file in the rejection list and still adds the rest of the selection (R-I2, R-I3)', async () => {
    classifyMock.mockImplementation((bytes) => {
      const name = new TextDecoder().decode(bytes)
      return name === 'bad.psd'
        ? { class: 'unhandled', reason: 'psd' }
        : { class: 'supported', format: 'jpeg', isAnimated: false }
    })
    // classify() is mocked, so its input doesn't matter for real decoding — stash the filename in
    // the file's own bytes so the mock above can tell the two apart.
    const psd: SelectedFile = { file: new File(['bad.psd'], 'bad.psd'), relativePath: null }
    const jpg = selectedFile('good.jpg')
    pickFilesMock.mockResolvedValue([psd, jpg])

    await addViaFilePicker()

    const batch = useBatchStore()
    expect(batch.images.map((image) => image.name)).toEqual(['good.jpg'])
    expect(batch.rejections).toEqual([
      expect.objectContaining({ name: 'bad.psd', reason: { kind: 'unhandled', reason: 'psd' } }),
    ])
  })

  it('rejects animated AVIF as a named unhandled entry (R-F8)', async () => {
    classifyMock.mockReturnValue({ class: 'unhandled', reason: 'animated-avif' })
    pickFilesMock.mockResolvedValue([selectedFile('clip.avif')])

    await addViaFilePicker()

    expect(useBatchStore().images).toHaveLength(0)
    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({
        name: 'clip.avif',
        reason: { kind: 'unhandled', reason: 'animated-avif' },
      }),
    ])
  })

  it('does not silently list an ordinary non-image file (R-I2 third class)', async () => {
    classifyMock.mockReturnValue({ class: 'not-image' })

    await ingestSelectedFiles([selectedFile('notes.txt')])

    const batch = useBatchStore()
    expect(batch.images).toHaveLength(0)
    expect(batch.rejections).toHaveLength(0)
  })

  it('rejects a HEIC file only when the decoder capability is unavailable, otherwise adds it', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'heic', isAnimated: false })

    getCapabilitiesMock.mockResolvedValue({ ...DEFAULT_CAPABILITIES, heicDecode: false })
    pickFilesMock.mockResolvedValue([selectedFile('photo.heic')])
    await addViaFilePicker()
    expect(useBatchStore().images).toHaveLength(0)
    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({ name: 'photo.heic', reason: { kind: 'heic-decoder-unavailable' } }),
    ])

    useBatchStore().clearAll()
    getCapabilitiesMock.mockResolvedValue({ ...DEFAULT_CAPABILITIES, heicDecode: true })
    pickFilesMock.mockResolvedValue([selectedFile('photo.heic')])
    await addViaFilePicker()
    expect(useBatchStore().images.map((image) => image.name)).toEqual(['photo.heic'])
  })

  it('rejects a file over the byte-size cap, naming the actual size and the cap', async () => {
    runtimeLimits.maximumFileBytes = 5
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    const big: SelectedFile = {
      file: new File(['123456789'], 'big.jpg'), // 9 bytes, over the 5-byte test cap
      relativePath: null,
    }
    pickFilesMock.mockResolvedValue([big])

    await addViaFilePicker()

    expect(useBatchStore().images).toHaveLength(0)
    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({
        name: 'big.jpg',
        reason: { kind: 'file-too-large', actualBytes: 9, capBytes: 5 },
      }),
    ])
  })

  it('accepts images up to the batch-count cap and summarizes the remainder in one entry', async () => {
    runtimeLimits.maximumBatchFiles = 2
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    const files = [selectedFile('a.jpg'), selectedFile('b.jpg'), selectedFile('c.jpg')]
    pickFilesMock.mockResolvedValue(files)

    await addViaFilePicker()

    const batch = useBatchStore()
    expect(batch.images.map((image) => image.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(batch.rejections).toEqual([
      expect.objectContaining({
        name: null,
        reason: { kind: 'batch-count-exceeded', actual: 3, cap: 2 },
      }),
    ])
  })

  it('reports a folder yielding zero supported images plainly (R-I29)', async () => {
    classifyMock.mockReturnValue({ class: 'not-image' })
    pickFolderMock.mockResolvedValue({
      ok: true,
      files: [selectedFile('readme.txt', 'empty/readme.txt')],
    })

    await addViaFolderPicker()

    expect(useBatchStore().images).toHaveLength(0)
    expect(useBatchStore().rejections).toEqual([
      expect.objectContaining({ name: null, reason: { kind: 'folder-empty' } }),
    ])
  })

  it('does not report folder-empty when the folder yielded at least one image', async () => {
    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    pickFolderMock.mockResolvedValue({ ok: true, files: [selectedFile('a.jpg', 'root/a.jpg')] })

    await addViaFolderPicker()

    expect(useBatchStore().rejections).toHaveLength(0)
  })

  it('replaces the rejection list on each new selection action rather than accumulating', async () => {
    classifyMock.mockReturnValue({ class: 'unhandled', reason: 'ico' })
    const first = await ingestSelectedFiles([selectedFile('one.ico')])
    useBatchStore().setRejections(first.rejections)
    expect(useBatchStore().rejections).toHaveLength(1)

    classifyMock.mockReturnValue({ class: 'supported', format: 'jpeg', isAnimated: false })
    const { rejections } = await ingestSelectedFiles([selectedFile('fine.jpg')])
    useBatchStore().setRejections(rejections)

    expect(useBatchStore().rejections).toHaveLength(0)
  })

  it('produces the same classification outcome for the same file via picker, folder picker, and drop', async () => {
    classifyMock.mockReturnValue({ class: 'unhandled', reason: 'svg' })

    pickFilesMock.mockResolvedValue([selectedFile('icon.svg')])
    await addViaFilePicker()
    const viaPicker = useBatchStore().rejections

    useBatchStore().clearAll()
    pickFolderMock.mockResolvedValue({ ok: true, files: [selectedFile('icon.svg', 'd/icon.svg')] })
    await addViaFolderPicker()
    const viaFolder = useBatchStore().rejections

    useBatchStore().clearAll()
    readDroppedFolderMock.mockResolvedValue({ ok: true, files: [selectedFile('icon.svg')] })
    await ingestDrop({} as DataTransfer)
    const viaDrop = useBatchStore().rejections

    for (const list of [viaPicker, viaFolder, viaDrop]) {
      expect(list).toEqual([
        expect.objectContaining({ reason: { kind: 'unhandled', reason: 'svg' } }),
      ])
    }
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
