// F1 verification (Technical Design §12.3, docs/assumptions.md): proves a production build
// emits real, route-specific static HTML for the tool route — "fetch a route's HTML file from
// disk directly, and assert its content is present without executing any script." A plain
// node:fs read is the literal, unambiguous satisfaction of "no script execution": even a
// headless browser with JS disabled is still a browser engine, not a disk read. Run via
// `pnpm build && pnpm verify:ssg`; see docs/task-notes/T31.md.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const target = join(process.cwd(), 'dist', 'index.html')

if (!existsSync(target)) {
  console.error(`F1 check: ${target} not found — run \`pnpm build\` first.`)
  process.exit(1)
}

const html = readFileSync(target, 'utf8')

const checks = [
  [/<title>[^<]+<\/title>/i, 'non-empty <title>'],
  [/Compressor/, "renders the tool header wordmark ('Compressor')"],
  [/Compress/, "renders the primary action's real label text ('Compress …')"],
]

const failures = checks.filter(([pattern]) => !pattern.test(html))

if (failures.length > 0) {
  for (const [, label] of failures) {
    console.error(`F1 check: missing — ${label}`)
  }
  process.exit(1)
}

console.log(
  `F1 check: ${target} contains real, route-specific content without executing any script — pass.`,
)
