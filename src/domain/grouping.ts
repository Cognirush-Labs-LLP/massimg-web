import { splitPath } from './naming'
import type { ImageRecord } from './types'

export interface GalleryGroup {
  /** `null` means no header should render: a flat batch, or a folder-root file with no subdirectory. */
  directory: string | null
  images: ImageRecord[]
}

function directoryKey(relativePath: string | null): string | null {
  if (relativePath === null) {
    return null
  }

  const { directory } = splitPath(relativePath)
  return directory === '' ? null : directory
}

/**
 * R-G11: groups a batch by directory for the Gallery list view, preserving the order each
 * directory is first seen in and each image's insertion order within it. Loose files and
 * folder-root files (no subdirectory) share a single `directory: null` group, which the list
 * view renders with no header — "grid mode does not group" extends to the ungrouped case here
 * too. A batch mixing loose and folder-sourced images (nothing stops "Add images" then "Add
 * folder" into the same batch) is handled the same way: only images with a real subdirectory
 * get a header.
 */
export function groupImagesByDirectory(images: readonly ImageRecord[]): GalleryGroup[] {
  const groups: GalleryGroup[] = []
  const groupIndexByKey = new Map<string | null, number>()

  for (const image of images) {
    const key = directoryKey(image.relativePath)
    const existingIndex = groupIndexByKey.get(key)
    const existingGroup = existingIndex === undefined ? undefined : groups[existingIndex]

    if (existingGroup) {
      existingGroup.images.push(image)
      continue
    }

    groupIndexByKey.set(key, groups.length)
    groups.push({ directory: key, images: [image] })
  }

  return groups
}
