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

export function splitPath(path: string): PathParts {
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
  const keepsInputFormat = input.sourceFormat === input.resolvedFormat

  return keepsInputFormat ? originalExtension : CANONICAL_EXTENSIONS[input.resolvedFormat]
}

function joinPath(directory: string, fileName: string): string {
  return directory === '' ? fileName : `${directory}/${fileName}`
}

interface OutputCandidate {
  /** Source-relative directory, `''` for a flat (non-folder) selection. */
  directory: string
  baseName: string
  /** Already resolved through R-X43/R-X44, including the leading dot. */
  extension: string
}

function splitCandidate(input: NamingInput): OutputCandidate {
  const inputPath = input.relativePath ?? input.name
  const { directory, fileName } = splitPath(inputPath)
  const { baseName, extension: originalExtension } = splitName(fileName)

  return { directory, baseName, extension: outputExtension(input, originalExtension) }
}

/** First available `name`, `name-1`, `name-2`, ... within one collision scope (R-X22, R-X53). */
function dedupeInScope(taken: Set<string>, candidate: OutputCandidate): string {
  const { baseName, extension } = candidate

  let outputName = `${baseName}${extension}`
  let suffix = 1

  while (taken.has(outputName)) {
    outputName = `${baseName}-${suffix}${extension}`
    suffix += 1
  }

  taken.add(outputName)
  return outputName
}

/**
 * The one place output names are resolved. `scopeKey` is what makes the two exported wrappers
 * differ: a per-directory key keeps `a/photo.jpg` and `b/photo.jpg` from colliding (R-X22), a
 * constant key makes them collide (R-X53). `format` decides whether the resolved basename is
 * re-joined to its directory or stays flat.
 */
function resolveNames(
  inputs: readonly NamingInput[],
  scopeKey: (candidate: OutputCandidate) => string,
  format: (candidate: OutputCandidate, outputName: string) => string,
): string[] {
  const namesByScope = new Map<string, Set<string>>()

  return inputs.map((input) => {
    const candidate = splitCandidate(input)
    const key = scopeKey(candidate)
    const taken = namesByScope.get(key) ?? new Set<string>()

    namesByScope.set(key, taken)

    return format(candidate, dedupeInScope(taken, candidate))
  })
}

/**
 * Resolves ZIP-relative output paths in input order. Later collisions receive the
 * first available numeric suffix within their own directory (R-X22).
 */
export function resolveOutputNames(inputs: readonly NamingInput[]): string[] {
  return resolveNames(
    inputs,
    (candidate) => candidate.directory,
    (candidate, outputName) => joinPath(candidate.directory, outputName),
  )
}

// One namespace for every shared file, whatever directory it came from (R-X53).
const SHARE_SCOPE = ''

/**
 * Resolves flattened Share file names in input order — grid order, when the caller passes the
 * batch in grid order, which is what R-X49/R-X53 require. A share payload has no directory tree,
 * so the source directory is discarded entirely and collisions are keyed globally: `a/photo.jpg`
 * and `b/photo.jpg` become `photo.jpg` and `photo-1.jpg`, where `resolveOutputNames` leaves both
 * alone. Deliberately a separate function rather than a flag on the ZIP one — the two scopes
 * coexist within a single run, and the ZIP's names must not shift because Share is also eligible.
 */
export function resolveShareNames(inputs: readonly NamingInput[]): string[] {
  return resolveNames(
    inputs,
    () => SHARE_SCOPE,
    (_candidate, outputName) => outputName,
  )
}
