import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageId } from '@/domain/types'
import {
  clearSourceFiles,
  deleteSourceFile,
  getSourceFile,
  hasSourceFile,
  preserveSourceFile,
  setSourceFile,
  prepareSourceFileCleanup,
} from './source-files'

const { writeCopy, readCopy, deleteCopies } = vi.hoisted(() => ({
  writeCopy: vi.fn(),
  readCopy: vi.fn(),
  deleteCopies: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./source-copies', () => ({
  writeSourceCopy: writeCopy,
  readSourceCopy: readCopy,
  deleteSourceCopies: deleteCopies,
}))

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

beforeEach(() => {
  clearSourceFiles()
  writeCopy.mockReset()
  readCopy.mockReset()
  deleteCopies.mockClear()
})

describe('source-files', () => {
  it('stores and retrieves a file by id', async () => {
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    setSourceFile(idA, file)

    expect(await getSourceFile(idA)).toBe(file)
    expect(hasSourceFile(idA)).toBe(true)
  })

  it('reports no file for an unknown id', async () => {
    expect(await getSourceFile(idA)).toBeUndefined()
    expect(hasSourceFile(idA)).toBe(false)
  })

  it('deletes one entry without touching another', async () => {
    const fileA = new File(['a'], 'a.png', { type: 'image/png' })
    const fileB = new File(['b'], 'b.png', { type: 'image/png' })
    setSourceFile(idA, fileA)
    setSourceFile(idB, fileB)

    deleteSourceFile(idA)

    expect(hasSourceFile(idA)).toBe(false)
    expect(await getSourceFile(idB)).toBe(fileB)
  })

  it('clears every entry', () => {
    setSourceFile(idA, new File(['a'], 'a.png', { type: 'image/png' }))
    setSourceFile(idB, new File(['b'], 'b.png', { type: 'image/png' }))

    clearSourceFiles()

    expect(hasSourceFile(idA)).toBe(false)
    expect(hasSourceFile(idB)).toBe(false)
  })

  it('publishes an independent copy only after storage succeeds', async () => {
    const original = new File(['a'], 'a.png', { type: 'image/png' })
    const copy = new File(['a'], 'a.png', { type: 'image/png' })
    let finish!: (file: File) => void
    writeCopy.mockReturnValue(new Promise<File>((resolve) => (finish = resolve)))

    const storing = preserveSourceFile(idA, original, new Uint8Array([97]))
    expect(hasSourceFile(idA)).toBe(false)
    finish(copy)

    await expect(storing).resolves.toBe(copy)
    readCopy.mockResolvedValue(copy)
    expect(await getSourceFile(idA)).toBe(copy)
    expect(await getSourceFile(idA)).not.toBe(original)
  })

  it.each(['clear', 'remove'] as const)(
    'discards a copy that finishes after %s',
    async (action) => {
      const source = new File(['a'], 'a.png')
      let finish!: (file: File) => void
      writeCopy.mockReturnValue(new Promise<File>((resolve) => (finish = resolve)))
      const storing = preserveSourceFile(idA, source, new Uint8Array([97]))
      const copyId = writeCopy.mock.calls[0]?.[0] as string

      if (action === 'clear') clearSourceFiles()
      else deleteSourceFile(idA)
      finish(new File(['a'], 'a.png'))

      await expect(storing).resolves.toBeUndefined()
      expect(hasSourceFile(idA)).toBe(false)
      expect(deleteCopies).toHaveBeenCalledWith([copyId])
    },
  )

  it('cleans partial storage after a failed copy without publishing the source', async () => {
    const error = new DOMException('Full', 'QuotaExceededError')
    writeCopy.mockRejectedValue(error)

    await expect(
      preserveSourceFile(idA, new File(['a'], 'a.png'), new Uint8Array([97])),
    ).rejects.toBe(error)
    expect(hasSourceFile(idA)).toBe(false)
    expect(deleteCopies).toHaveBeenCalledWith([writeCopy.mock.calls[0]?.[0]])
  })

  it('removes only the deleted image copy from storage', async () => {
    writeCopy.mockResolvedValue(new File(['a'], 'a.png'))
    await preserveSourceFile(idA, new File(['a'], 'a.png'), new Uint8Array([97]))
    await preserveSourceFile(idB, new File(['b'], 'b.png'), new Uint8Array([98]))
    const firstCopyId = writeCopy.mock.calls[0]?.[0] as string

    deleteSourceFile(idA)

    expect(deleteCopies).toHaveBeenCalledExactlyOnceWith([firstCopyId])
    expect(hasSourceFile(idB)).toBe(true)
  })

  it('does not return a source whose image was removed during its database read', async () => {
    const copy = new File(['a'], 'a.png')
    writeCopy.mockResolvedValue(copy)
    await preserveSourceFile(idA, copy, new Uint8Array([97]))
    let finish!: (file: File) => void
    readCopy.mockReturnValue(new Promise<File>((resolve) => (finish = resolve)))
    const reading = getSourceFile(idA)

    deleteSourceFile(idA)
    finish(copy)

    await expect(reading).resolves.toBeUndefined()
  })
})

describe('awaited source cleanup', () => {
  it('keeps locators when atomic deletion fails, then allows retry', async () => {
    const file = new File(['a'], 'a.png')
    writeCopy.mockResolvedValue(file)
    await preserveSourceFile(idA, file, new Uint8Array([97]))
    await preserveSourceFile(idB, file, new Uint8Array([97]))
    const cleanup = prepareSourceFileCleanup([idA, idB])
    deleteCopies.mockRejectedValueOnce(new Error('denied'))
    await expect(cleanup()).rejects.toThrow('denied')
    expect(hasSourceFile(idA)).toBe(true)
    expect(hasSourceFile(idB)).toBe(true)
    await cleanup()
    expect(hasSourceFile(idA)).toBe(false)
    expect(hasSourceFile(idB)).toBe(false)
  })

  it('waits for unpublished selection copies and leaves later selections intact', async () => {
    const source = new File(['a'], 'a.png')
    let finish!: (file: File) => void
    writeCopy.mockReturnValueOnce(
      new Promise<File>((resolve) => {
        finish = resolve
      }),
    )
    const importing = preserveSourceFile(idA, source, new Uint8Array([97]))
    const copyId = writeCopy.mock.calls[0]?.[0] as string
    const cleanup = prepareSourceFileCleanup()
    setSourceFile(idB, source)
    let cleared = false
    const clearing = cleanup().then(() => {
      cleared = true
    })
    await Promise.resolve()
    expect(cleared).toBe(false)
    finish(source)
    await importing
    await clearing
    expect(deleteCopies).toHaveBeenCalledWith([copyId])
    expect(hasSourceFile(idA)).toBe(false)
    expect(await getSourceFile(idB)).toBe(source)
  })

  it('deletes only captured copies and preserves newly selected or replaced sources', async () => {
    const original = new File(['a'], 'a.png')
    writeCopy.mockResolvedValue(original)
    await preserveSourceFile(idA, original, new Uint8Array([97]))
    const copyId = writeCopy.mock.calls[0]?.[0] as string
    const cleanup = prepareSourceFileCleanup([idA])
    const replacement = new File(['b'], 'b.png')
    setSourceFile(idA, replacement)
    setSourceFile(idB, original)
    deleteCopies.mockClear()
    await cleanup()
    expect(deleteCopies).toHaveBeenCalledExactlyOnceWith([copyId])
    expect(await getSourceFile(idA)).toBe(replacement)
    expect(await getSourceFile(idB)).toBe(original)
  })
})
