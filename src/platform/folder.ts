import type { SelectedFile } from './picker'

// Folder selection and recursive traversal (Technical Design §10.1, Functional Design §5.3).

export type FolderSelection =
  | { ok: true; files: SelectedFile[] }
  | { ok: false; reason: 'depth-exceeded'; actual: number; cap: number }
  | { ok: false; reason: 'file-count-exceeded'; actual: number; cap: number }

// Provisional. No measured value exists yet (Technical Design §8.3 assigns real limits to T46, from
// one shared configuration module). Chosen generous enough for any real folder tree; T46 may retune
// or relocate these.
const MAX_TRAVERSAL_DEPTH = 32
const MAX_TRAVERSAL_FILES = 2000

const SYSTEM_FILE_NAMES = new Set(['thumbs.db', 'desktop.ini'])

// R-I27. Windows filenames are case-insensitive, so the system-name match is too.
function isHiddenOrSystem(name: string): boolean {
  if (name.startsWith('.')) {
    return true
  }
  return SYSTEM_FILE_NAMES.has(name.toLowerCase())
}

// The selected/dropped root itself is never filtered — only entries found while descending into it.
function isPathHiddenOrSystem(relativePath: string): boolean {
  return relativePath.split('/').slice(1).some(isHiddenOrSystem)
}

class TraversalBreach extends Error {
  constructor(
    readonly reason: 'depth-exceeded' | 'file-count-exceeded',
    readonly actual: number,
    readonly cap: number,
  ) {
    super(`folder traversal breach: ${reason}`)
  }
}

export function pickFolder(): Promise<FolderSelection> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)

    input.addEventListener(
      'change',
      () => {
        const files = Array.from(input.files ?? [])
        input.remove()
        resolve(resolvePickedFolder(files))
      },
      { once: true },
    )

    input.click()
  })
}

function resolvePickedFolder(files: File[]): FolderSelection {
  const survivors = files.filter((file) => !isPathHiddenOrSystem(file.webkitRelativePath))

  let maxDepth = 0
  for (const file of survivors) {
    const depth = file.webkitRelativePath.split('/').length - 1
    if (depth > maxDepth) {
      maxDepth = depth
    }
  }

  if (maxDepth > MAX_TRAVERSAL_DEPTH) {
    return { ok: false, reason: 'depth-exceeded', actual: maxDepth, cap: MAX_TRAVERSAL_DEPTH }
  }
  if (survivors.length > MAX_TRAVERSAL_FILES) {
    return {
      ok: false,
      reason: 'file-count-exceeded',
      actual: survivors.length,
      cap: MAX_TRAVERSAL_FILES,
    }
  }

  return {
    ok: true,
    files: survivors.map((file) => ({ file, relativePath: file.webkitRelativePath })),
  }
}

export async function readDroppedFolder(dataTransfer: DataTransfer): Promise<FolderSelection> {
  const traversals: Promise<SelectedFile[]>[] = []

  try {
    // A browser-created DataTransfer is readable only while the drop event is being dispatched.
    // Start every top-level traversal before the first await; walking one entry to completion
    // before asking the DataTransfer for the next makes every item after the first inaccessible
    // on a real OS drop. Promise.all preserves top-level insertion order even when roots finish in
    // a different order.
    for (const item of dataTransfer.items) {
      if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') {
        continue
      }
      const entry = item.webkitGetAsEntry()
      if (entry) {
        const rootFiles: SelectedFile[] = []
        traversals.push(walk(entry, entry.name, 0, rootFiles).then(() => rootFiles))
      }
    }

    const files = (await Promise.all(traversals)).flat()
    if (files.length > MAX_TRAVERSAL_FILES) {
      return {
        ok: false,
        reason: 'file-count-exceeded',
        actual: files.length,
        cap: MAX_TRAVERSAL_FILES,
      }
    }

    return { ok: true, files }
  } catch (error) {
    if (error instanceof TraversalBreach) {
      return { ok: false, reason: error.reason, actual: error.actual, cap: error.cap }
    }
    throw error
  }
}

// Depth 0 is the root entry itself (never filtered); its descendants start at depth 1.
async function walk(
  entry: FileSystemEntry,
  path: string,
  depth: number,
  acc: SelectedFile[],
): Promise<void> {
  if (depth > 0 && isHiddenOrSystem(entry.name)) {
    return
  }
  if (depth > MAX_TRAVERSAL_DEPTH) {
    throw new TraversalBreach('depth-exceeded', depth, MAX_TRAVERSAL_DEPTH)
  }

  if (entry.isFile) {
    if (acc.length + 1 > MAX_TRAVERSAL_FILES) {
      throw new TraversalBreach('file-count-exceeded', acc.length + 1, MAX_TRAVERSAL_FILES)
    }
    const file = await fileFromEntry(entry as FileSystemFileEntry)
    acc.push({ file, relativePath: path })
    return
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const children = await readAllDirectoryEntries(reader)
    for (const child of children) {
      await walk(child, `${path}/${child.name}`, depth + 1, acc)
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// `readEntries` is not guaranteed to return the full listing in one call — the spec requires calling
// it repeatedly until it resolves with an empty array.
function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all)
        } else {
          all.push(...entries)
          readBatch()
        }
      }, reject)
    }
    readBatch()
  })
}
