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

/** Records page errors and console errors, so a page that renders but throws still fails. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
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
    // 404.html is the page the host serves for an unknown address, not a page of the site: it
    // has its own tests below and is not in the sitemap.
    .filter((name) => name.endsWith('.html') && name !== '404.html')
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

test.describe('not-found page', () => {
  test('is real HTML that search engines are told to skip, with no canonical URL', async ({
    request,
  }) => {
    // The file the host serves for an unknown address, fetched as a file: the preview server
    // answers unknown addresses with the tool page, so it cannot stand in for the host here.
    const response = await request.get('/404.html')
    expect(response.status()).toBe(200)
    const html = await response.text()

    expect(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').toMatch(/^Page not found/)
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(canonicalOf(html)).toBe('')
    expect(html).toContain('Page not found')
  })

  test('is what the browser shows for an unknown address, and leads home', async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto('/this/is/not/a/page')

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    await page.getByRole('main').getByRole('link', { name: 'Back to the home page' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('button', { name: 'Select images' })).toBeVisible()

    expect(errors).toEqual([])
  })
})

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
    // Clicking while the page's own scripts are still loading makes WebKit log the cancelled
    // fetches as errors ("Cannot load .../rolldown-runtime-*.js due to access control checks"),
    // which would fail the error check below for a reason that is about the test, not the page.
    await page.waitForLoadState('networkidle')
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
    expect(locations.some((location) => location.includes('404'))).toBe(false)

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
