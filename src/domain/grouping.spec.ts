import { describe, expect, it } from 'vitest'
import type { ImageId, ImageRecord } from './types'
import { imageRecordFixture } from './types.fixtures'
import { groupImagesByDirectory } from './grouping'

function image(id: string, relativePath: string | null): ImageRecord {
  return { ...imageRecordFixture, id: id as ImageId, relativePath }
}

describe('groupImagesByDirectory', () => {
  it('returns an empty array for an empty batch', () => {
    expect(groupImagesByDirectory([])).toEqual([])
  })

  it('puts a fully flat (non-folder) batch in one ungrouped bucket, in insertion order', () => {
    const images = [image('a', null), image('b', null)]

    const groups = groupImagesByDirectory(images)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.directory).toBeNull()
    expect(groups[0]?.images).toEqual(images)
  })

  it('groups a folder tree by directory, preserving first-seen directory order and traversal order within each', () => {
    const images = [
      image('a', 'root-a.jpg'),
      image('b', 'sub/b.jpg'),
      image('c', 'root-c.jpg'),
      image('d', 'sub/d.jpg'),
    ]

    const groups = groupImagesByDirectory(images)

    expect(groups).toHaveLength(2)
    expect(groups[0]?.directory).toBeNull()
    expect(groups[0]?.images.map((i) => i.id)).toEqual(['a', 'c'])
    expect(groups[1]?.directory).toBe('sub')
    expect(groups[1]?.images.map((i) => i.id)).toEqual(['b', 'd'])
  })

  it('merges a loose file and a folder-root file into the same ungrouped bucket', () => {
    const images = [image('a', null), image('b', 'root-b.jpg')]

    const groups = groupImagesByDirectory(images)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.directory).toBeNull()
    expect(groups[0]?.images.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('merges two images from separate folder picks sharing the same relative directory', () => {
    const images = [image('a', 'sub/a.jpg'), image('b', 'sub/b.jpg')]

    const groups = groupImagesByDirectory(images)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.directory).toBe('sub')
  })
})
