import { beforeEach, describe, expect, it } from 'vitest'
import type { ImageId } from '@/domain/types'
import {
  clearSourceFiles,
  deleteSourceFile,
  getSourceFile,
  hasSourceFile,
  setSourceFile,
} from './source-files'

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId

beforeEach(() => {
  clearSourceFiles()
})

describe('source-files', () => {
  it('stores and retrieves a file by id', () => {
    const file = new File(['a'], 'a.png', { type: 'image/png' })
    setSourceFile(idA, file)

    expect(getSourceFile(idA)).toBe(file)
    expect(hasSourceFile(idA)).toBe(true)
  })

  it('reports no file for an unknown id', () => {
    expect(getSourceFile(idA)).toBeUndefined()
    expect(hasSourceFile(idA)).toBe(false)
  })

  it('deletes one entry without touching another', () => {
    const fileA = new File(['a'], 'a.png', { type: 'image/png' })
    const fileB = new File(['b'], 'b.png', { type: 'image/png' })
    setSourceFile(idA, fileA)
    setSourceFile(idB, fileB)

    deleteSourceFile(idA)

    expect(hasSourceFile(idA)).toBe(false)
    expect(getSourceFile(idB)).toBe(fileB)
  })

  it('clears every entry', () => {
    setSourceFile(idA, new File(['a'], 'a.png', { type: 'image/png' }))
    setSourceFile(idB, new File(['b'], 'b.png', { type: 'image/png' }))

    clearSourceFiles()

    expect(hasSourceFile(idA)).toBe(false)
    expect(hasSourceFile(idB)).toBe(false)
  })
})
