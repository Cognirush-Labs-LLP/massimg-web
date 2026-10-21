import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// T51: the public routes, and the three files search engines and crawlers read, as the production
// build serves them (see playwright.site.config.ts for why this is not the dev server).
//
// What is compared against what: the set of routes is read from dist/ — the same source
// scripts/generate-seo-files.mjs reads — rather than repeated here, so a page added to the router
// that this file does not list still has to appear in the sitemap and still has to render. The
// per-page expectations below are the part that is written by hand, and the "every built page is
// covered" test fails if a page exists that they do not name.

const DIST = join(process.cwd(), 'dist')

interface PublicRoute {
  path: string
  /** Matches dist/<file>.html: the root route is index.html. */
  file: string
  title: RegExp
  /** The one <h1>; the tool route has none, its wordmark is the page identity. */
  heading: string | null
}

const ROUTES: PublicRoute[] = [
  { path: '/', file: 'index.html', title: /^Mass Image Compressor/, heading: null },
  { path: '/faq', file: 'faq.html', title: /^FAQ/, heading: 'Frequently Asked Questions' },
  { path: '/privacy', file: 'privacy.html', title: /^Privacy/, heading: 'Privacy Policy' },
  { path: '/terms', file: 'terms.html', title: /^Terms of Service/, heading: 'Terms of Service' },
  { path: '/credits', file: 'credits.html', title: /^Credits/, heading: 'Credits and licenses' },
  { path: '/desktop', file: 'desktop.html', title: /^Desktop/, heading: 'Desktop version' },
]

// The production build carries the analytics beacon (T46), which talks to Cloudflare. A test of our
// own pages must not depend on a third party being reachable — or on its CORS answer to an origin
// of localhost — so that host is answered locally. What the beacon itself sends is covered by
// src/app/seo/useAnalyticsBeacon.spec.ts and tests/e2e-pwa/pwa.spec.ts.
test.beforeEach(async ({ context }) => {
  await context.route(/cloudflareinsights\.com/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: '',
    }),
  )
})

// Playwright's WebKit build for Linux refuses the production build's lazy-loaded runtime chunk
// during a client-side navigation ("Cannot load .../rolldown-runtime-*.js due to access control
// checks"), yet the page it leads to renders correctly. macOS WebKit, which stands in for Safari,
// and the other two engines log nothing, and the failure is the same with the service worker
// allowed (tests/e2e/webkit-platform.ts says why Linux WebKit is not evidence about Safari). Only
// that one message is tolerated, and only there; any other error still fails.
function isLinuxWebKitChunkNoise(message: string): boolean {
  return (
    test.info().project.name === 'webkit' &&
    process.platform !== 'darwin' &&
    /rolldown-runtime|Importing a module script failed|sw\.js load failed/.test(message)
  )
}

/** Records page errors and console errors, so a page that renders but throws still fails. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  const record = (message: string): void => {
    if (!isLinuxWebKitChunkNoise(message)) errors.push(message)
  }
  page.on('pageerror', (error) => record(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') record(message.text())
  })
  return errors
}

function routePathFor(file: string): string {
  return file === 'index.html' ? '/' : `/${file.slice(0, -'.html'.length)}`
}

function canonicalOf(html: string): string {
  const match = /<link[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i.exec(html)
  return match?.[1] ?? ''
}

test('every page the build produced is covered by this file', () => {
  const built = readdirSync(DIST)
    .filter((name) => name.endsWith('.html'))
    .map(routePathFor)
    .sort()

  expect(ROUTES.map((route) => route.path).sort()).toEqual(built)
})

for (const route of ROUTES) {
  test.describe(`route ${route.path}`, () => {
    test('loads, renders its content and throws nothing', async ({ page }) => {
      const errors = watchForErrors(page)
      const response = await page.goto(route.path)

      expect(response?.status()).toBe(200)
      await expect(page).toHaveTitle(route.title)

      if (route.heading === null) {
        await expect(page.getByRole('button', { name: 'Select images' })).toBeVisible()
      } else {
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(route.heading)
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
      }

      expect(errors).toEqual([])
    })

    test('is real HTML before any script runs, with its own canonical URL', async ({ request }) => {
      // The file itself, not what the router would draw: this is what a crawler receives.
      const response = await request.get(route.file === 'index.html' ? '/' : `/${route.file}`)
      expect(response.status()).toBe(200)
      const html = await response.text()

      expect(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').toMatch(route.title)
      if (route.heading !== null) {
        expect(html).toContain(route.heading)
      }
      expect(canonicalOf(html)).toMatch(new RegExp(`${route.path === '/' ? '/' : route.path}$`))
    })
  })
}

test('the footer and header reach every public page without a reload', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  // The tool route's compact footer carries every site-level link.
  for (const [name, path] of [
    ['FAQ', '/faq'],
    ['Privacy', '/privacy'],
    ['Terms', '/terms'],
    ['Credits', '/credits'],
  ] as const) {
    await page.goto('/')
    await page.evaluate(() => {
      ;(globalThis as unknown as { __stayed: boolean }).__stayed = true
    })
    await page.getByRole('contentinfo').getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    // The marker survives only if navigation stayed inside the single-page app.
    expect(
      await page.evaluate(() => (globalThis as unknown as { __stayed?: boolean }).__stayed),
    ).toBe(true)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }

  // A content page's own header leads onward and back.
  await page.goto('/faq')
  await page.getByRole('banner').getByRole('link', { name: 'Desktop' }).click()
  await expect(page).toHaveURL(/\/desktop$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Desktop version')

  expect(errors).toEqual([])
})

test.describe('sitemap.xml', () => {
  test('lists every built page exactly once, under the same URL each page declares as canonical', async ({
    request,
  }) => {
    const response = await request.get('/sitemap.xml')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/xml/)

    const xml = await response.text()
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!)

    expect(new Set(locations).size, 'no page is listed twice').toBe(locations.length)
    expect(locations).toHaveLength(ROUTES.length)

    for (const route of ROUTES) {
      const page = await request.get(route.file === 'index.html' ? '/' : `/${route.file}`)
      const canonical = canonicalOf(await page.text())
      expect(canonical, `${route.path} declares a canonical URL`).not.toBe('')
      expect(locations, `the sitemap lists ${route.path} as it declares itself`).toContain(
        canonical,
      )
    }
  })
})

test.describe('robots.txt', () => {
  test('welcomes crawlers to every page and points at the sitemap', async ({ request }) => {
    const response = await request.get('/robots.txt')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/text\/plain/)

    const text = await response.text()
    expect(text).toMatch(/^User-agent: \*\nAllow: \/$/m)
    expect(text, 'nothing is disallowed').not.toMatch(/^Disallow:\s*\S/m)

    const sitemap = await (await request.get('/sitemap.xml')).text()
    const firstLocation = /<loc>([^<]+)<\/loc>/.exec(sitemap)![1]!
    const origin = new URL(firstLocation).origin
    expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`)
  })
})
