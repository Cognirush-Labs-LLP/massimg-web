#!/usr/bin/env node
// Checks that every bundled/statically-linked third-party component listed in
// docs/technical-design.md §7.1/§7.2 has a directory with real upstream licence
// text under 3rd_party_licenses/. Exits non-zero (and lists what's missing) if
// anything is absent, so this can be run standalone or wired into CI.
//
// This is a hardcoded manifest, not a node_modules walker deliberately: most of
// these components are statically linked inside the ImageMagick WASM binary and
// never appear in node_modules at all, so nothing could be discovered
// automatically. See docs/technical-design.md §7.2.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const LICENSES_DIR = join(ROOT, '3rd_party_licenses')

// One entry per row of the docs/technical-design.md §7.2 attribution table.
// `files` are the exact filenames expected in that component's directory.
const COMPONENTS = [
  { name: 'imagemagick', files: ['LICENSE', 'NOTICE'] },
  { name: 'libde265', files: ['COPYING'] },
  { name: 'libheif', files: ['COPYING'] },
  { name: 'libwebp', files: ['COPYING'] },
  { name: 'aom', files: ['LICENSE', 'PATENTS'] },
  { name: 'lcms2', files: ['COPYING'] },
  { name: 'libjpeg-turbo', files: ['LICENSE'] },
  { name: 'libpng', files: ['LICENSE'] },
  // gifsicle's README carries an alternative-licence grant alongside its GPLv2
  // COPYING file (technical-design.md §7.2, "Gifsicle" paragraph) — captured as
  // a second file, an extracted excerpt of the README's licence section.
  { name: 'gifsicle', files: ['COPYING', 'README-LICENSE-SECTION.md'] },
  { name: 'oxipng', files: ['LICENSE'] },
  { name: 'libimagequant', files: ['COPYING'] },
  { name: 'upng-js', files: ['LICENSE'] },
  { name: 'apng-optimizer', files: ['LICENSE'] },
  { name: 'client-zip', files: ['LICENSE'] },
]

const problems = []

for (const { name, files } of COMPONENTS) {
  const dir = join(LICENSES_DIR, name)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    problems.push(`${name}/ — directory missing`)
    continue
  }
  for (const file of files) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      problems.push(`${name}/${file} — file missing`)
    } else if (statSync(path).size === 0) {
      problems.push(`${name}/${file} — file is empty`)
    }
  }
}

// Flag stray component directories that aren't in the manifest — usually a
// sign the manifest above went stale after a §7.1/§7.2 dependency change.
const known = new Set(COMPONENTS.map((c) => c.name))
const onDisk = existsSync(LICENSES_DIR)
  ? readdirSync(LICENSES_DIR).filter((entry) => statSync(join(LICENSES_DIR, entry)).isDirectory())
  : []
const unlisted = onDisk.filter((entry) => !known.has(entry))

if (problems.length > 0) {
  console.error('Missing third-party licence material:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    `\n${problems.length} problem(s) found across ${COMPONENTS.length} required components.`,
  )
  console.error('See docs/technical-design.md §7.2 for the attribution structure.')
  process.exitCode = 1
} else {
  console.log(
    `All ${COMPONENTS.length} components in 3rd_party_licenses/ have their required licence files.`,
  )
}

if (unlisted.length > 0) {
  console.warn(
    `\nNote: ${unlisted.length} director${unlisted.length === 1 ? 'y' : 'ies'} under 3rd_party_licenses/ ` +
      `not in this script's manifest: ${unlisted.join(', ')}. If these are real new dependencies, add them ` +
      'to docs/technical-design.md §7.1/§7.2 and to COMPONENTS in this script.',
  )
}
