// File selection only — folder selection and its own traversal live in platform/folder.ts
// (Technical Design §10.1).

export interface SelectedFile {
  file: File
  /** Relative to a selected folder root. Always null here — a flat selection has no root. */
  relativePath: string | null
}

export function pickFiles(): Promise<SelectedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // A native-picker hint only (T39, R-I23): classification still inspects every byte and never
    // trusts the browser's filtered selection or a file's extension/MIME type. No `capture`
    // attribute — this is the ordinary picker, not a camera shortcut.
    input.accept = 'image/*'
    input.style.display = 'none'
    document.body.appendChild(input)

    input.addEventListener(
      'change',
      () => {
        const files = Array.from(input.files ?? [])
        input.remove()
        resolve(files.map((file) => ({ file, relativePath: null })))
      },
      { once: true },
    )

    input.click()
  })
}

export function readDroppedFiles(dataTransfer: DataTransfer): SelectedFile[] {
  const files: SelectedFile[] = []

  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') {
      continue
    }
    const file = item.getAsFile()
    if (file) {
      files.push({ file, relativePath: null })
    }
  }

  return files
}
