import { test, expect } from '@playwright/test'

// T18 — platform/picker.ts. Same constraint and workaround as tests/e2e/capability.spec.ts (see its
// header comment): tests/e2e/** is type-checked by tsconfig.node.json (no DOM lib, not
// project-referenced to tsconfig.app.json), so this file calls the module inside the page via a
// dynamic import of its served path rather than a static import, with the path passed as a function
// parameter so `tsc --strict` doesn't attempt to statically resolve the literal.
//
// `page.evaluate`'s return value is JSON-serialized across the Node/browser boundary, and a `File`
// does not survive that (it serializes to `{}` — its properties are prototype getters, not own
// properties). So every callback below maps `SelectedFile[]` down to a plain `{ name, relativePath }`
// shape *inside* the page before returning it, rather than returning `File` objects themselves.
const PICKER_MODULE_PATH = '/src/platform/picker.ts'

interface SerializedSelection {
  name: string
  relativePath: string | null
}

test('pickFiles() returns every chosen file with a null relativePath', async ({ page }) => {
  await page.goto('/')

  page.once('filechooser', (chooser) => {
    void chooser.setFiles([
      { name: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('a') },
      { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('b') },
    ])
  })

  const selected: SerializedSelection[] = await page.evaluate(async (path) => {
    const mod = await import(/* @vite-ignore */ path)
    const result = await mod.pickFiles()
    return result.map((f: { file: { name: string }; relativePath: string | null }) => ({
      name: f.file.name,
      relativePath: f.relativePath,
    }))
  }, PICKER_MODULE_PATH)

  expect(selected.map((f) => f.name).sort()).toEqual(['a.jpg', 'b.png'])
  expect(selected.every((f) => f.relativePath === null)).toBe(true)
})

test('readDroppedFiles() extracts plain files from a drop payload', async ({ page }) => {
  await page.goto('/')

  const selected: SerializedSelection[] = await page.evaluate(async (path) => {
    const mod = await import(/* @vite-ignore */ path)
    // `File` isn't a type this file can name (no DOM lib under tsconfig.node.json) — looked up
    // dynamically so the construction itself stays untyped rather than using a DOM global directly.
    const FileCtor = (
      globalThis as { File: new (parts: string[], name: string) => { name: string } }
    ).File
    const dataTransfer = {
      items: [
        { kind: 'file', getAsFile: () => new FileCtor(['x'], 'one.jpg') },
        { kind: 'file', getAsFile: () => new FileCtor(['y'], 'two.jpg') },
        { kind: 'string', getAsFile: () => null },
      ],
    }
    const result = mod.readDroppedFiles(dataTransfer)
    return result.map((f: { file: { name: string }; relativePath: string | null }) => ({
      name: f.file.name,
      relativePath: f.relativePath,
    }))
  }, PICKER_MODULE_PATH)

  expect(selected.map((f) => f.name).sort()).toEqual(['one.jpg', 'two.jpg'])
  expect(selected.every((f) => f.relativePath === null)).toBe(true)
})
