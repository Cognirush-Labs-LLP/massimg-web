// Build-time SEO file generator (T45, Technical Design §12.5, R-S8/R-S9/R-S10): writes
// dist/sitemap.xml, dist/robots.txt and dist/llms.txt once `vite-ssg build` has already written
// real per-route HTML to dist/ — this script must run after that step (see package.json's
// `build` script).
//
// Reads the actual build output (dist/*.html) rather than re-importing the TypeScript route
// config (src/app/router.ts, src/config/site.ts): this project has no tsx/ts-node/vite-node to
// run a TS/ESM module with path aliases from a plain Node script, and reading what was really
// built guarantees the sitemap can never list a route that didn't actually get produced — the
// strongest possible version of "can never drift from the real routes" (R-S8). Each dist/*.html
// already carries its own real <title>/<meta name="description"> (baked in by
// src/app/seo/useRouteSeo.ts during the prerender pass), so this script also reuses those
// instead of a second, separately-authored copy.
//
// Assumes every dist/*.html is a real page route — true today because vite-ssg only emits one
// file per route in src/app/router.ts. If a non-route HTML file (e.g. a custom 404 page) is ever
// added to dist/, this assumption needs revisiting.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')

// Mirrors src/config/site.ts's siteName/resolveSiteBaseUrl. Duplicated deliberately rather than
// importing that TS module here — see the file header.
const SITE_NAME = 'Mass Image Compressor'

function resolveSiteBaseUrl(raw) {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return 'https://site-base-url-not-set.invalid'
  }
  return trimmed.replace(/\/+$/, '')
}

const siteBaseUrl = resolveSiteBaseUrl(process.env.VITE_SITE_BASE_URL)

// Named per Technical Design §12.5, in addition to the default allow-all.
const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'Google-Extended']

function routeHtmlFiles() {
  return readdirSync(dist)
    .filter((name) => name.endsWith('.html'))
    .sort()
}

function routePathFor(file) {
  return file === 'index.html' ? '/' : `/${file.slice(0, -'.html'.length)}`
}

function extractTitle(html) {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
}

function extractMetaDescription(html) {
  const nameFirst =
    /<meta[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i.exec(html)
  if (nameFirst) {
    return nameFirst[1].trim()
  }
  const contentFirst =
    /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["'][^>]*>/i.exec(html)
  return contentFirst?.[1]?.trim() ?? ''
}

function readRouteEntries() {
  return routeHtmlFiles().map((file) => {
    const html = readFileSync(join(dist, file), 'utf8')
    return {
      path: routePathFor(file),
      title: extractTitle(html),
      description: extractMetaDescription(html),
    }
  })
}

function buildSitemapXml(routeEntries) {
  const urls = routeEntries
    .map((entry) => `  <url><loc>${siteBaseUrl}${entry.path}</loc></url>`)
    .join('\n')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  )
}

function buildRobotsTxt() {
  const crawlerBlocks = AI_CRAWLERS.map((agent) => `User-agent: ${agent}\nAllow: /\n`).join('\n')
  return `User-agent: *\nAllow: /\n\n${crawlerBlocks}\nSitemap: ${siteBaseUrl}/sitemap.xml\n`
}

function buildLlmsTxt(routeEntries) {
  const tool = routeEntries.find((entry) => entry.path === '/')
  const header = `# ${SITE_NAME}\n\n> ${tool?.description ?? ''}\n`
  const pageLines = routeEntries
    .map((entry) => `- [${entry.title}](${siteBaseUrl}${entry.path}): ${entry.description}`)
    .join('\n')
  return `${header}\n## Pages\n\n${pageLines}\n`
}

const routeEntries = readRouteEntries()

if (routeEntries.length === 0) {
  console.error(
    'generate-seo-files: no dist/*.html found — run `pnpm build` (vite-ssg build runs first).',
  )
  process.exit(1)
}

writeFileSync(join(dist, 'sitemap.xml'), buildSitemapXml(routeEntries))
writeFileSync(join(dist, 'robots.txt'), buildRobotsTxt())
writeFileSync(join(dist, 'llms.txt'), buildLlmsTxt(routeEntries))

console.log(
  `generate-seo-files: wrote sitemap.xml, robots.txt and llms.txt for ${routeEntries.length} routes.`,
)
