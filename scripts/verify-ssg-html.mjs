// F1 verification (Technical Design §12.3, docs/assumptions.md): proves a production build
// emits real, route-specific static HTML for every route — "fetch a route's HTML file from
// disk directly, and assert its content is present without executing any script." A plain
// node:fs read is the literal, unambiguous satisfaction of "no script execution": even a
// headless browser with JS disabled is still a browser engine, not a disk read. Run via
// `pnpm build && pnpm verify:ssg`; see docs/task-notes/T31.md and T43.md.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')

// One entry per route this task is responsible for proving. T43 added the faq/privacy/terms/
// desktop routes; their "resolves to a page rather than a 404" Done-when clause is checked
// here at the same disk level as the original tool-route check.
const routeChecks = [
  {
    file: join(dist, 'index.html'),
    checks: [
      [/<title>[^<]+<\/title>/i, 'non-empty <title>'],
      [/Compressor/, "renders the tool header wordmark ('Compressor')"],
      [/Compress/, "renders the primary action's real label text ('Compress …')"],
    ],
  },
  {
    file: join(dist, 'faq.html'),
    checks: [[/Frequently Asked Questions/, 'renders the FAQ page heading']],
  },
  {
    file: join(dist, 'privacy.html'),
    checks: [[/Privacy Policy/, 'renders the Privacy page heading']],
  },
  {
    file: join(dist, 'terms.html'),
    checks: [[/Terms of Service/, 'renders the Terms page heading']],
  },
  {
    file: join(dist, 'desktop.html'),
    checks: [[/Desktop version/, 'renders the Desktop page heading']],
  },
]

let failed = false

for (const { file, checks } of routeChecks) {
  if (!existsSync(file)) {
    console.error(`F1 check: ${file} not found — run \`pnpm build\` first.`)
    failed = true
    continue
  }

  const html = readFileSync(file, 'utf8')
  const failures = checks.filter(([pattern]) => !pattern.test(html))

  for (const [, label] of failures) {
    console.error(`F1 check: ${file} missing — ${label}`)
    failed = true
  }
}

if (failed) {
  process.exit(1)
}

console.log(
  `F1 check: all ${routeChecks.length} routes contain real, route-specific content on disk without executing any script — pass.`,
)
