import type { FormatSetting } from './format'
import type { EncodableFormat, ImageRecord } from './types'

export interface NamingInput extends Pick<ImageRecord, 'name' | 'relativePath' | 'sourceFormat'> {
  formatSetting: FormatSetting
  resolvedFormat: EncodableFormat
}

const CANONICAL_EXTENSIONS = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  gif: '.gif',
} as const satisfies Record<EncodableFormat, string>

interface PathParts {
  directory: string
  fileName: string
}

interface NameParts {
  baseName: string
  extension: string
}

function splitPath(path: string): PathParts {
  const separatorIndex = path.lastIndexOf('/')

  if (separatorIndex === -1) {
    return { directory: '', fileName: path }
  }

  return {
    directory: path.slice(0, separatorIndex),
    fileName: path.slice(separatorIndex + 1),
  }
}

function splitName(fileName: string): NameParts {
  const extensionIndex = fileName.lastIndexOf('.')

  if (extensionIndex <= 0) {
    return { baseName: fileName, extension: '' }
  }

  return {
    baseName: fileName.slice(0, extensionIndex),
    extension: fileName.slice(extensionIndex),
  }
}

function outputExtension(input: NamingInput, originalExtension: string): string {
  const keepsInputFormat =
    input.formatSetting === 'dont-change' && input.sourceFormat === input.resolvedFormat

  return keepsInputFormat ? originalExtension : CANONICAL_EXTENSIONS[input.resolvedFormat]
}

function joinPath(directory: string, fileName: string): string {
  return directory === '' ? fileName : `${directory}/${fileName}`
}

/**
 * Resolves ZIP-relative output paths in input order. Later collisions receive the
 * first available numeric suffix within their own directory.
 */
export function resolveOutputNames(inputs: readonly NamingInput[]): string[] {
  const namesByDirectory = new Map<string, Set<string>>()

  return inputs.map((input) => {
    const inputPath = input.relativePath ?? input.name
    const { directory, fileName } = splitPath(inputPath)
    const { baseName, extension: originalExtension } = splitName(fileName)
    const extension = outputExtension(input, originalExtension)
    const namesInDirectory = namesByDirectory.get(directory) ?? new Set<string>()

    namesByDirectory.set(directory, namesInDirectory)

    let outputName = `${baseName}${extension}`
    let suffix = 1

    while (namesInDirectory.has(outputName)) {
      outputName = `${baseName}-${suffix}${extension}`
      suffix += 1
    }

    namesInDirectory.add(outputName)
    return joinPath(directory, outputName)
  })
}
