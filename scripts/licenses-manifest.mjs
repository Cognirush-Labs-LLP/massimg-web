// Reads and validates 3rd_party_licenses/components.json, the single source of truth for
// which third-party components this build bundles and credits.
//
// Shared by scripts/check-licenses.mjs (the audit gate) and scripts/copy-licenses.mjs (which
// copies the listed texts into dist/) so the credited set and the served set cannot drift apart.
// The credits page reads the same file through Vite — see src/app/credits/componentsManifest.ts.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ROOT = join(__dirname, '..')
export const LICENSES_DIR = join(ROOT, '3rd_party_licenses')
export const MANIFEST_PATH = join(LICENSES_DIR, 'components.json')

/** Files at the root of 3rd_party_licenses/ that are ours rather than a component's text. */
const NON_COMPONENT_FILES = new Set(['components.json'])

export function readManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  if (!Array.isArray(raw?.components)) {
    throw new Error(`${MANIFEST_PATH}: expected a { "components": [...] } object`)
  }
  return raw.components
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Returns a list of human-readable problems; empty means the manifest and the directory agree.
 *
 * Five checks, in order: the manifest's own shape; manifest → disk; disk → manifest for
 * directories; disk → manifest for files; and no file claimed twice. The two disk → manifest
 * directions are what make "the credits page covers every directory" (T49) true by construction
 * rather than by inspection — a new dependency's text cannot be committed without being credited.
 */
export function validateManifest(components) {
  const problems = []

  for (const [index, entry] of components.entries()) {
    const label = isNonEmptyString(entry?.name) ? entry.name : `components[${index}]`
    for (const field of ['directory', 'name', 'license', 'sourceUrl']) {
      if (!isNonEmptyString(entry?.[field])) {
        problems.push(`${label} — \`${field}\` must be a non-empty string`)
      }
    }
    if (!(entry?.licenseId === null || isNonEmptyString(entry?.licenseId))) {
      problems.push(
        `${label} — \`licenseId\` must be an SPDX identifier or null (null where no single ` +
          'identifier is honest, e.g. a dual-licensed component)',
      )
    }
    if (isNonEmptyString(entry?.sourceUrl) && !entry.sourceUrl.startsWith('https://')) {
      problems.push(`${label} — \`sourceUrl\` must be an https:// URL`)
    }
    if (
      !Array.isArray(entry?.files) ||
      entry.files.length === 0 ||
      !entry.files.every(isNonEmptyString)
    ) {
      problems.push(`${label} — \`files\` must be a non-empty array of filenames`)
    }
  }

  const names = components.map((entry) => entry?.name)
  for (const name of new Set(names)) {
    if (names.filter((other) => other === name).length > 1) {
      problems.push(`${name} — appears more than once; each credited component needs one entry`)
    }
  }

  if (problems.length > 0) return problems

  // Manifest -> disk.
  const claimedFiles = new Map()
  for (const entry of components) {
    const dir = join(LICENSES_DIR, entry.directory)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      problems.push(`${entry.name} — 3rd_party_licenses/${entry.directory}/ is missing`)
      continue
    }
    for (const file of entry.files) {
      const key = `${entry.directory}/${file}`
      const path = join(dir, file)
      if (!existsSync(path)) {
        problems.push(`${entry.name} — ${key} is missing`)
      } else if (statSync(path).size === 0) {
        problems.push(`${entry.name} — ${key} is empty`)
      }
      const alreadyClaimedBy = claimedFiles.get(key)
      if (alreadyClaimedBy !== undefined) {
        problems.push(`${key} — claimed by both ${alreadyClaimedBy} and ${entry.name}`)
      } else {
        claimedFiles.set(key, entry.name)
      }
    }
  }

  // Disk -> manifest.
  const claimedDirectories = new Set(components.map((entry) => entry.directory))
  const onDisk = existsSync(LICENSES_DIR) ? readdirSync(LICENSES_DIR, { withFileTypes: true }) : []
  for (const dirent of onDisk) {
    if (dirent.isDirectory()) {
      if (!claimedDirectories.has(dirent.name)) {
        problems.push(
          `3rd_party_licenses/${dirent.name}/ — on disk but credited by no manifest entry. If ` +
            'this is a real new dependency, add it to docs/technical-design.md §7.1/§7.2 and to ' +
            'components.json.',
        )
      }
      continue
    }
    if (!NON_COMPONENT_FILES.has(dirent.name)) {
      problems.push(
        `3rd_party_licenses/${dirent.name} — unexpected file at the root of the licence tree; ` +
          'licence text belongs in a component directory.',
      )
    }
  }

  for (const directory of claimedDirectories) {
    const dir = join(LICENSES_DIR, directory)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!claimedFiles.has(`${directory}/${file}`)) {
        problems.push(
          `3rd_party_licenses/${directory}/${file} — on disk but listed by no manifest entry, so ` +
            'the credits page would not link it.',
        )
      }
    }
  }

  return problems
}

/** Reads, validates and returns the manifest; throws with every problem listed. */
export function loadValidatedManifest() {
  const components = readManifest()
  const problems = validateManifest(components)
  if (problems.length > 0) {
    throw new Error(
      `3rd_party_licenses/components.json does not agree with the licence tree:\n\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    )
  }
  return components
}
