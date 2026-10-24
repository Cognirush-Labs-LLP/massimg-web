#!/usr/bin/env node
// Fetches a deployed copy of the site and checks that public/.htaccess took effect. Shared hosts
// can ignore a directive without saying so, so "the file is uploaded" proves nothing; this reads
// the response headers back.
//
//   node scripts/verify-deploy.mjs https://massimg.com
//
// File names to probe are taken from the local dist/, so run it from the checkout that produced
// the uploaded build.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const base = (process.argv[2] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/verify-deploy.mjs <base URL, e.g. https://massimg.com>')
  process.exit(2)
}

const ASSETS = join(process.cwd(), 'dist', 'assets')
const wasm = readdirSync(ASSETS).find((name) => /^magick-.*\.wasm$/.test(name))
const script = readdirSync(ASSETS).find((name) => /^app-.*\.js$/.test(name))
if (!wasm || !script) {
  console.error('dist/assets has no magick-*.wasm or app-*.js; run `pnpm build` first.')
  process.exit(2)
}

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// The one-year immutable rule matches file names alone. Anything it matches outside assets/ (apart
// from Workbox's own hashed runtime) is a file nobody hashed, which visitors would never refetch.
const hashedPattern = new RegExp(
  /<FilesMatch "([^"]+)">/.exec(
    readFileSync(join(process.cwd(), 'public', '.htaccess'), 'utf8'),
  )?.[1] ?? '(?!)',
)
const unhashed = readdirSync(join(process.cwd(), 'dist'), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && hashedPattern.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((path) => !/[\\/]assets[\\/]/.test(path) && !/[\\/]workbox-[^\\/]+$/.test(path))
check(
  'no unhashed file matches the immutable-cache pattern',
  unhashed.length === 0,
  unhashed.join(', '),
)

const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init })

// Every page and asset the checks below cover, fetched with the Accept-Encoding a browser sends.
const page = await get('/')
const pageEtag = page.headers.get('etag')
const pageModified = page.headers.get('last-modified')
check(
  '/ answers 200 as HTML',
  page.status === 200 && /^text\/html/.test(page.headers.get('content-type') ?? ''),
  `${page.status} ${page.headers.get('content-type')}`,
)
check(
  '/ revalidates (Cache-Control: no-cache)',
  page.headers.get('cache-control') === 'no-cache',
  page.headers.get('cache-control') ?? 'no header',
)
// Hostinger's server or its CDN leaves the ETag off HTML (the other files keep theirs), so the
// page revalidates by Last-Modified. Either validator makes a repeat visit a 304.
check(
  '/ carries a validator (ETag or Last-Modified)',
  Boolean(pageEtag || pageModified),
  'neither header',
)
check('/ is compressed', Boolean(page.headers.get('content-encoding')), 'no Content-Encoding')

const revalidated = await get('/', {
  headers: pageEtag ? { 'if-none-match': pageEtag } : { 'if-modified-since': pageModified ?? '' },
})
check('/ answers 304 to its own validator', revalidated.status === 304, `got ${revalidated.status}`)

const faq = await get('/faq')
check('/faq (extensionless) answers 200', faq.status === 200, `got ${faq.status}`)
const faqHtml = await get('/faq.html')
check(
  '/faq.html redirects to /faq',
  faqHtml.status === 301 &&
    new URL(faqHtml.headers.get('location') ?? '', base).pathname === '/faq',
  `${faqHtml.status} ${faqHtml.headers.get('location')}`,
)

const slash = await get('/faq/')
check(
  '/faq/ redirects to /faq',
  slash.status === 301 && new URL(slash.headers.get('location') ?? '', base).pathname === '/faq',
  `${slash.status} ${slash.headers.get('location')}`,
)

const wasmResponse = await get(`/assets/${wasm}`, { method: 'HEAD' })
check(
  'wasm is application/wasm',
  wasmResponse.headers.get('content-type') === 'application/wasm',
  wasmResponse.headers.get('content-type') ?? 'no header',
)
check(
  'wasm is cached for a year, immutable',
  wasmResponse.headers.get('cache-control') === 'public, max-age=31536000, immutable',
  wasmResponse.headers.get('cache-control') ?? 'no header',
)
check(
  'wasm is compressed',
  Boolean(wasmResponse.headers.get('content-encoding')),
  'no Content-Encoding (14 MB uncompressed)',
)
const scriptResponse = await get(`/assets/${script}`, { method: 'HEAD' })
check(
  'hashed JS is immutable',
  /immutable/.test(scriptResponse.headers.get('cache-control') ?? ''),
  scriptResponse.headers.get('cache-control') ?? 'no header',
)

const sw = await get('/sw.js', { method: 'HEAD' })
// Cloudflare's "Browser Cache TTL" can replace no-cache with a few hours on .js files. That is
// harmless for the worker: browsers fetch the worker script past the HTTP cache when checking for
// an update, and cap its cache time at a day. A year would not be.
const swMaxAge = Number(/max-age=(\d+)/.exec(sw.headers.get('cache-control') ?? '')?.[1] ?? 0)
check(
  'sw.js is not cached longer than a day',
  swMaxAge <= 86400 && !/immutable/.test(sw.headers.get('cache-control') ?? ''),
  sw.headers.get('cache-control') ?? 'no header',
)

const licence = await get('/3rd_party_licenses/aom/LICENSE')
check(
  'licence text is text/plain',
  /^text\/plain/.test(licence.headers.get('content-type') ?? ''),
  licence.headers.get('content-type') ?? 'no header',
)

const missing = await get('/no-such-page')
const missingBody = await missing.text()
check('an unknown address answers 404', missing.status === 404, `got ${missing.status}`)
check(
  'the 404 response is the not-found page, linking to the home page',
  /Page not found/.test(missingBody) && /<a [^>]*href="\/"/.test(missingBody),
  'body is not dist/404.html',
)
check(
  'error responses carry nosniff too',
  missing.headers.get('x-content-type-options') === 'nosniff',
  missing.headers.get('x-content-type-options') ?? 'no header',
)

const php = await get('/probe.php')
check('.php is refused', php.status === 403, `got ${php.status}`)
const htaccess = await get('/.htaccess')
check('.htaccess is not served', htaccess.status === 403, `got ${htaccess.status}`)

check(
  'nosniff is set',
  page.headers.get('x-content-type-options') === 'nosniff',
  page.headers.get('x-content-type-options') ?? 'no header',
)
const allCacheControl = [page, wasmResponse, scriptResponse, sw].map(
  (r) => r.headers.get('cache-control') ?? '',
)
check(
  'no no-transform (Cloudflare would skip its analytics injection)',
  !allCacheControl.some((v) => /no-transform/.test(v)),
  allCacheControl.join(' | '),
)

if (base.startsWith('https://')) {
  check('HSTS is set', Boolean(page.headers.get('strict-transport-security')), 'no header')
  const plain = await fetch(base.replace('https://', 'http://') + '/', { redirect: 'manual' })
  check(
    'http:// redirects to https://',
    [301, 302, 307, 308].includes(plain.status) &&
      (plain.headers.get('location') ?? '').startsWith('https://'),
    `${plain.status} ${plain.headers.get('location')}`,
  )
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
