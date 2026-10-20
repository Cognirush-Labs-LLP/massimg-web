#!/usr/bin/env node
// Audits that every bundled/statically-linked third-party component listed in
// docs/technical-design.md §7.1/§7.2 is credited in 3rd_party_licenses/components.json
// and has real upstream licence text on disk. Exits non-zero, listing what is wrong.
//
// The credited set is a hand-maintained manifest, not a node_modules walker, deliberately:
// most of these components are statically linked inside the ImageMagick WASM binary and never
// appear in node_modules at all, so nothing could be discovered automatically. T49 moved that
// manifest out of this script into components.json, which the credits page reads too — so the
// page and this gate can never credit different sets.
//
// Checks run in both directions: a manifest entry with no text fails, and text with no manifest
// entry fails too. The second direction is what keeps R-V4's "every bundled component" true as
// dependencies change, rather than only at the moment someone last looked.

import { readManifest, validateManifest, LICENSES_DIR } from './licenses-manifest.mjs'

let components
try {
  components = readManifest()
} catch (error) {
  console.error(`Could not read the licence manifest: ${error.message}`)
  process.exit(1)
}

const problems = validateManifest(components)

if (problems.length > 0) {
  console.error('Third-party licence problems:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(`\n${problems.length} problem(s) found across ${components.length} components.`)
  console.error('See docs/technical-design.md §7.2 for the attribution structure.')
  process.exit(1)
}

const directories = new Set(components.map((entry) => entry.directory))
console.log(
  `All ${components.length} components across ${directories.size} directories in ` +
    `${LICENSES_DIR.replace(/.*\//, '')}/ are credited and have their licence files.`,
)
