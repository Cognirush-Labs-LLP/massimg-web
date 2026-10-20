#!/usr/bin/env node
// Copies the third-party licence texts credited in 3rd_party_licenses/components.json into
// dist/3rd_party_licenses/, so the credits page (/credits, R-V4) links each component's real
// licence text on our own origin rather than an upstream URL that can rot or move.
//
// Only manifest-listed files are copied, which makes the served set and the credited set the
// same set by construction. Filenames are kept verbatim (LICENSE, COPYING, PATENTS — most have
// no extension) so what the page shows matches what the repository holds; serving them as
// text/plain is handled by the serve-third-party-licenses plugin in vite.config.ts for dev and
// preview, and by .htaccess in production (T52).
//
// A post-build script rather than a Vite plugin: `vite-ssg build` runs two Rollup passes, and
// anything emitted during the client pass exists in dist/ while Workbox computes its precache
// manifest. Running after the build means these files cannot be precached even if
// workbox.globPatterns is widened later.

import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadValidatedManifest, LICENSES_DIR, ROOT } from './licenses-manifest.mjs'

const DEST_DIR = join(ROOT, 'dist', '3rd_party_licenses')

let components
try {
  components = loadValidatedManifest()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

let copied = 0
for (const component of components) {
  const destDir = join(DEST_DIR, component.directory)
  mkdirSync(destDir, { recursive: true })
  for (const file of component.files) {
    copyFileSync(join(LICENSES_DIR, component.directory, file), join(destDir, file))
    copied += 1
  }
}

console.log(`Copied ${copied} licence file(s) into dist/3rd_party_licenses/.`)
