import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// T18 — platform/folder.ts. Same DOM/dynamic-import constraint as capability.spec.ts and
// picker.spec.ts (see their header comments), and the same JSON-serialization caveat as
// picker.spec.ts: every browser-side result is mapped down to a plain, serializable shape before it
// crosses back to Node.
const FOLDER_MODULE_PATH = '/src/platform/folder.ts'

interface SerializedFile {
  name: string
  relativePath: string | null
}

type SerializedSelection =
  | { ok: true; files: SerializedFile[] }
  | { ok: false; reason: 'depth-exceeded' | 'file-count-exceeded'; actual: number; cap: number }

// One logical tree, used two ways below: materialised to real files on disk for the pickFolder()
// path, and built as mock FileSystemEntry objects in-page for the readDroppedFolder() path. Includes
// one of each thing R-I27/R-I30 care about: nested real files, a hidden dotfile, both named system
// files, and a hidden directory whose contents must never appear at all.
const TREE_ROOT = 'album'
const TREE_FILES = [
  'photo1.jpg',
  'sub/photo2.jpg',
  'sub/deeper/photo3.jpg',
  '.hidden-file.jpg',
  'Thumbs.db',
  'desktop.ini',
  '.git/config', // inside a hidden directory — the whole subtree must be skipped, not just this file
]
const EXPECTED_RELATIVE_PATHS = [
  `${TREE_ROOT}/photo1.jpg`,
  `${TREE_ROOT}/sub/photo2.jpg`,
  `${TREE_ROOT}/sub/deeper/photo3.jpg`,
].sort()

test.describe('pickFolder()', () => {
  test('traverses a real nested folder, skipping hidden and system entries', async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), 'icompress-e2e-folder-'))
    const treeDir = join(root, TREE_ROOT)
    try {
      await writeTree(treeDir, TREE_FILES)

      await page.goto('/')
      page.once('filechooser', (chooser) => {
        void chooser.setFiles(treeDir)
      })

      const selection = await callFolderFn(page, FOLDER_MODULE_PATH, 'pickFolder')

      expect(selection.ok).toBe(true)
      if (selection.ok) {
        expect(selection.files.map((f) => f.relativePath).sort()).toEqual(EXPECTED_RELATIVE_PATHS)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a tree deeper than the cap, adding no files', async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), 'icompress-e2e-folder-depth-'))
    const treeDir = join(root, TREE_ROOT)
    try {
      const deepFiles = [deepPath(40) + '/photo.jpg']
      await writeTree(treeDir, deepFiles)

      await page.goto('/')
      page.once('filechooser', (chooser) => {
        void chooser.setFiles(treeDir)
      })

      const selection = await callFolderFn(page, FOLDER_MODULE_PATH, 'pickFolder')

      expect(selection.ok).toBe(false)
      if (!selection.ok) {
        expect(selection.reason).toBe('depth-exceeded')
        expect(selection.actual).toBeGreaterThan(selection.cap)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a tree with more files than the cap, adding no files', async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), 'icompress-e2e-folder-count-'))
    const treeDir = join(root, TREE_ROOT)
    try {
      const manyFiles = Array.from({ length: 2001 }, (_, i) => `flat/file-${i}.jpg`)
      await writeTree(treeDir, manyFiles)

      await page.goto('/')
      page.once('filechooser', (chooser) => {
        void chooser.setFiles(treeDir)
      })

      const selection = await callFolderFn(page, FOLDER_MODULE_PATH, 'pickFolder')

      expect(selection.ok).toBe(false)
      if (!selection.ok) {
        expect(selection.reason).toBe('file-count-exceeded')
        expect(selection.actual).toBeGreaterThan(selection.cap)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test.describe('readDroppedFolder()', () => {
  test('captures every top-level item before the drop payload becomes inaccessible', async ({
    page,
  }) => {
    await page.goto('/')

    const selection = await page.evaluate(async (path) => {
      const mod = await import(/* @vite-ignore */ path)
      const dataTransfer = buildExpiringLooseFileDrop(['one.jpg', 'two.jpg', 'three.jpg'])
      const result = await mod.readDroppedFolder(dataTransfer)
      return serializeSelection(result)
    }, FOLDER_MODULE_PATH)

    expect(selection).toEqual({
      ok: true,
      files: [
        { name: 'one.jpg', relativePath: 'one.jpg' },
        { name: 'two.jpg', relativePath: 'two.jpg' },
        { name: 'three.jpg', relativePath: 'three.jpg' },
      ],
    })
  })

  test('traverses a mock nested folder, skipping hidden and system entries', async ({ page }) => {
    await page.goto('/')

    const selection = await page.evaluate(
      async ({ path, root, files }) => {
        const mod = await import(/* @vite-ignore */ path)
        const dataTransfer = buildMockDrop(root, files)
        const result = await mod.readDroppedFolder(dataTransfer)
        return serializeSelection(result)
      },
      { path: FOLDER_MODULE_PATH, root: TREE_ROOT, files: TREE_FILES },
    )

    expect(selection.ok).toBe(true)
    if (selection.ok) {
      expect(selection.files.map((f) => f.relativePath).sort()).toEqual(EXPECTED_RELATIVE_PATHS)
    }
  })

  test('produces the same list as pickFolder() for the same tree', async ({ page }) => {
    const root = await mkdtemp(join(tmpdir(), 'icompress-e2e-folder-parity-'))
    const treeDir = join(root, TREE_ROOT)
    try {
      await writeTree(treeDir, TREE_FILES)

      await page.goto('/')
      page.once('filechooser', (chooser) => {
        void chooser.setFiles(treeDir)
      })
      const picked = await callFolderFn(page, FOLDER_MODULE_PATH, 'pickFolder')

      const dropped = await page.evaluate(
        async ({ path, root: rootName, files }) => {
          const mod = await import(/* @vite-ignore */ path)
          const dataTransfer = buildMockDrop(rootName, files)
          const result = await mod.readDroppedFolder(dataTransfer)
          return serializeSelection(result)
        },
        { path: FOLDER_MODULE_PATH, root: TREE_ROOT, files: TREE_FILES },
      )

      expect(picked.ok).toBe(true)
      expect(dropped.ok).toBe(true)
      if (picked.ok && dropped.ok) {
        expect(dropped.files.map((f) => f.relativePath).sort()).toEqual(
          picked.files.map((f) => f.relativePath).sort(),
        )
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a tree deeper than the cap, adding no files', async ({ page }) => {
    await page.goto('/')

    const files = [deepPath(40) + '/photo.jpg']
    const selection = await page.evaluate(
      async ({ path, root, files: treeFiles }) => {
        const mod = await import(/* @vite-ignore */ path)
        const dataTransfer = buildMockDrop(root, treeFiles)
        const result = await mod.readDroppedFolder(dataTransfer)
        return serializeSelection(result)
      },
      { path: FOLDER_MODULE_PATH, root: TREE_ROOT, files },
    )

    expect(selection.ok).toBe(false)
    if (!selection.ok) {
      expect(selection.reason).toBe('depth-exceeded')
      expect(selection.actual).toBeGreaterThan(selection.cap)
    }
  })

  test('rejects a tree with more files than the cap, adding no files', async ({ page }) => {
    await page.goto('/')

    const files = Array.from({ length: 2001 }, (_, i) => `flat/file-${i}.jpg`)
    const selection = await page.evaluate(
      async ({ path, root, files: treeFiles }) => {
        const mod = await import(/* @vite-ignore */ path)
        const dataTransfer = buildMockDrop(root, treeFiles)
        const result = await mod.readDroppedFolder(dataTransfer)
        return serializeSelection(result)
      },
      { path: FOLDER_MODULE_PATH, root: TREE_ROOT, files },
    )

    expect(selection.ok).toBe(false)
    if (!selection.ok) {
      expect(selection.reason).toBe('file-count-exceeded')
      expect(selection.actual).toBeGreaterThan(selection.cap)
    }
  })
})

function deepPath(levels: number): string {
  return Array.from({ length: levels }, (_, i) => `d${i}`).join('/')
}

async function writeTree(treeDir: string, relativeFiles: string[]): Promise<void> {
  for (const relativeFile of relativeFiles) {
    const target = join(treeDir, relativeFile)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'x')
  }
}

async function callFolderFn(
  page: Page,
  path: string,
  fnName: 'pickFolder',
): Promise<SerializedSelection> {
  return page.evaluate(
    async ({ path: modPath, fnName: fn }) => {
      const mod = await import(/* @vite-ignore */ modPath)
      const result = await mod[fn]()
      return serializeSelection(result)
    },
    { path, fnName },
  )
}

// Injected into the page's evaluation context by reference below (Playwright serializes function
// bodies referenced from `page.evaluate`'s own function only — these two helpers are called from
// within evaluate callbacks above and must therefore be redeclared inside each; declared once here
// and spliced textually is more error-prone than just inlining, so both are duplicated verbatim
// inside every evaluate callback that needs them via the shared `serializeSelection`/`buildMockDrop`
// globals installed by `page.addInitScript` before each test — see beforeEach below.
declare function serializeSelection(result: unknown): SerializedSelection
declare function buildMockDrop(root: string, files: string[]): unknown
declare function buildExpiringLooseFileDrop(files: string[]): unknown

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    function buildMockDrop(root: string, files: string[]) {
      interface Node {
        kind: 'file' | 'directory'
        name: string
        children: Map<string, Node>
      }

      const rootNode: Node = { kind: 'directory', name: root, children: new Map() }
      for (const relativeFile of files) {
        const segments = relativeFile.split('/')
        let current = rootNode
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i] as string
          const isLast = i === segments.length - 1
          let child = current.children.get(segment)
          if (!child) {
            child = { kind: isLast ? 'file' : 'directory', name: segment, children: new Map() }
            current.children.set(segment, child)
          }
          current = child
        }
      }

      function toEntry(node: Node): unknown {
        if (node.kind === 'file') {
          return {
            name: node.name,
            isFile: true,
            isDirectory: false,
            file: (resolve: (f: unknown) => void) => resolve(new File(['x'], node.name)),
          }
        }
        const children = Array.from(node.children.values()).map(toEntry)
        let delivered = false
        return {
          name: node.name,
          isFile: false,
          isDirectory: true,
          createReader: () => ({
            readEntries: (resolve: (entries: unknown[]) => void) => {
              // Real readers return everything then an empty array on the next call — mirrored here.
              if (delivered) {
                resolve([])
              } else {
                delivered = true
                resolve(children)
              }
            },
          }),
        }
      }

      return {
        items: [{ kind: 'file', webkitGetAsEntry: () => toEntry(rootNode) }],
      }
    }

    function buildExpiringLooseFileDrop(files: string[]) {
      let readable = true
      const entries = files.map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
        file: (resolve: (file: File) => void, reject: (error: Error) => void) => {
          if (readable) {
            resolve(new File(['x'], name))
          } else {
            reject(new Error('drop payload is no longer readable'))
          }
        },
      }))

      // Models the HTML drag-data lifecycle: access is available during the synchronous drop
      // handler, then protected as soon as that handler yields back to the browser.
      queueMicrotask(() => {
        readable = false
      })

      return {
        items: entries.map((entry) => ({
          kind: 'file',
          webkitGetAsEntry: () => (readable ? entry : null),
        })),
      }
    }

    function serializeSelection(result: {
      ok: boolean
      files?: { file: { name: string }; relativePath: string | null }[]
      reason?: string
      actual?: number
      cap?: number
    }) {
      if (!result.ok) {
        return { ok: false, reason: result.reason, actual: result.actual, cap: result.cap }
      }
      return {
        ok: true,
        files: (result.files ?? []).map((f) => ({
          name: f.file.name,
          relativePath: f.relativePath,
        })),
      }
    }
    ;(globalThis as unknown as Record<string, unknown>).buildMockDrop = buildMockDrop
    ;(globalThis as unknown as Record<string, unknown>).buildExpiringLooseFileDrop =
      buildExpiringLooseFileDrop
    ;(globalThis as unknown as Record<string, unknown>).serializeSelection = serializeSelection
  })
})
