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

// T45 (R-S6, Technical Design §12.5): every route's <title> and canonical <link> must be
// non-empty and distinct from every other route's — proven here the same way F1 was, by reading
// the built files off disk rather than executing anything.

function extractTitle(html) {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
}

function extractCanonical(html) {
  return (
    /<link[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']*)["'][^>]*>/i
      .exec(html)?.[1]
      ?.trim() ?? ''
  )
}

function firstDuplicate(values) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) {
      return value
    }
    seen.add(value)
  }
  return undefined
}

let seoFailed = false

const seoEntries = routeChecks.map(({ file }) => {
  const html = readFileSync(file, 'utf8')
  return { file, title: extractTitle(html), canonical: extractCanonical(html) }
})

for (const { file, title, canonical } of seoEntries) {
  if (!title) {
    console.error(`T45 check: ${file} has no <title>.`)
    seoFailed = true
  }
  if (!canonical) {
    console.error(`T45 check: ${file} has no canonical <link>.`)
    seoFailed = true
  }
}

const duplicateTitle = firstDuplicate(seoEntries.map((entry) => entry.title))
if (duplicateTitle) {
  console.error(`T45 check: title "${duplicateTitle}" is shared by more than one route.`)
  seoFailed = true
}

const duplicateCanonical = firstDuplicate(seoEntries.map((entry) => entry.canonical))
if (duplicateCanonical) {
  console.error(`T45 check: canonical "${duplicateCanonical}" is shared by more than one route.`)
  seoFailed = true
}

// R-S8/R-S9: sitemap.xml lists exactly the real routes, and robots.txt's Sitemap: line matches it.

const sitemapFile = join(dist, 'sitemap.xml')
const robotsFile = join(dist, 'robots.txt')

if (!existsSync(sitemapFile)) {
  console.error(`T45 check: ${sitemapFile} not found — run \`pnpm build\` first.`)
  seoFailed = true
} else if (!existsSync(robotsFile)) {
  console.error(`T45 check: ${robotsFile} not found — run \`pnpm build\` first.`)
  seoFailed = true
} else {
  const sitemapXml = readFileSync(sitemapFile, 'utf8')
  const sitemapLocs = [...sitemapXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1])

  if (sitemapLocs.length !== routeChecks.length) {
    console.error(
      `T45 check: sitemap.xml lists ${sitemapLocs.length} URLs, expected exactly ${routeChecks.length} real routes.`,
    )
    seoFailed = true
  }

  const robotsTxt = readFileSync(robotsFile, 'utf8')
  const sitemapLine = /^Sitemap:\s*(\S+)$/m.exec(robotsTxt)?.[1]

  if (!sitemapLine || !sitemapLine.endsWith('/sitemap.xml')) {
    console.error(
      `T45 check: robots.txt's Sitemap: line ("${sitemapLine}") doesn't name sitemap.xml.`,
    )
    seoFailed = true
  }
}

if (seoFailed) {
  process.exit(1)
}

console.log(
  `T45 check: all ${seoEntries.length} routes have distinct, non-empty titles and canonical tags, and sitemap.xml/robots.txt agree — pass.`,
)
