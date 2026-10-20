import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// T49, R-V4. The done-when — "the credits page covers every directory in 3rd_party_licenses/" —
// is asserted against the real directory listing rather than against the manifest the page is
// built from: a manifest with entries deleted would still agree with itself, so only the disk
// can falsify it. scripts/check-licenses.mjs enforces the same thing in CI at commit level;
// this is the user-visible half.

// tests/e2e has no DOM lib (tsconfig.node.json), so this page-side read is declared minimally,
// following the same convention as tests/e2e/i18n-rtl.spec.ts.
declare const document: {
  documentElement: { scrollWidth: number; clientWidth: number }
  querySelectorAll: (selector: string) => Iterable<Element>
}
declare interface Element {
  tagName: string
  className: string
  scrollWidth: number
  clientWidth: number
}
declare function getComputedStyle(element: Element): { overflowX: string }

const LICENSES_DIR = join(process.cwd(), '3rd_party_licenses')

function componentDirectories(): string[] {
  return readdirSync(LICENSES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

test('credits the application itself and every bundled component', async ({ page }) => {
  await page.goto('/credits')

  await expect(page.getByRole('heading', { level: 1, name: 'Credits and licenses' })).toBeVisible()
  await expect(page.getByRole('link', { name: /AGPL v3/ })).toBeVisible()

  const hrefs = await page
    .locator('a.license-file')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))

  const directories = componentDirectories()
  expect(directories.length).toBeGreaterThan(0)
  for (const directory of directories) {
    expect(
      hrefs.some((href) => href.startsWith(`/3rd_party_licenses/${directory}/`)),
      `3rd_party_licenses/${directory}/ is credited on the page`,
    ).toBe(true)
  }
})

test('serves every linked licence text as readable plain text', async ({ page, request }) => {
  await page.goto('/credits')

  const hrefs = await page
    .locator('a.license-file')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))
  expect(hrefs.length).toBeGreaterThan(0)

  for (const href of hrefs) {
    const response = await request.get(href)
    expect(response.status(), `${href} is served`).toBe(200)
    // Plain text rather than a download: these files have no extension, so without the
    // serve-third-party-licenses plugin (dev/preview) or .htaccess (production, T52) a browser
    // offers to save them instead of showing them.
    expect(response.headers()['content-type'], `${href} content type`).toContain('text/plain')
    expect((await response.text()).trim().length, `${href} is non-empty`).toBeGreaterThan(0)
  }
})

test('refuses a traversal attempt through the licence path', async ({ request }) => {
  // Percent-encoded, because an HTTP client resolves a literal `../` in the path before the
  // request is ever sent — only the encoded form actually reaches the middleware.
  const response = await request.get('/3rd_party_licenses/oxipng/%2e%2e%2f%2e%2e%2fpackage.json')
  expect(response.status()).not.toBe(200)
})

test('has no accessibility violations', async ({ page }) => {
  await page.goto('/credits')
  const results = await new AxeBuilder({ page }).include('.credits-page').analyze()
  expect(results.violations).toEqual([])
})

test('needs no horizontal scroller at any width, and holds no table', async ({ page }) => {
  // The first version of this page was a four-column table. Its source-URL column alone is
  // wider than a phone, so it carried a horizontal scroller at every size, including wide
  // screens with room to spare. Checked across the range rather than at one width, because that
  // is exactly what the table version passed at.
  for (const width of [390, 480, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/credits')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const overflow = await page.evaluate(() => ({
      page: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      // Only elements that actually clip can show a scrollbar of their own. An element with
      // `overflow-x: visible` cannot — anything too wide inside it spills out and makes the
      // *page* scroll, which the assertion above catches. Inline elements are excluded by the
      // same rule: their clientWidth is 0 by definition, so measuring them compares nothing.
      scrollers: [...document.querySelectorAll('.credits-page *')]
        .filter(
          (element) =>
            getComputedStyle(element).overflowX !== 'visible' &&
            element.scrollWidth > element.clientWidth,
        )
        .map((element) => `${element.tagName}.${element.className}`),
    }))

    expect(
      overflow.page.scrollWidth,
      `page does not scroll sideways at ${width}px`,
    ).toBeLessThanOrEqual(overflow.page.clientWidth)
    expect(overflow.scrollers, `nothing scrolls sideways at ${width}px`).toEqual([])
  }

  expect(await page.locator('table').count()).toBe(0)
})
