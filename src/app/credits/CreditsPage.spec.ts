import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CreditsPage from './CreditsPage.vue'
import { operator } from '@/config/site'
import { creditedComponents, licenseTextUrl } from './componentsManifest'

// Deliberately mounted with no router plugin, no Pinia and no matchMedia stub (contrast
// SiteShell.spec.ts, which needs the last two): this page must render from manifest data alone,
// because vite-ssg prerenders it in Node where none of those exist.
function mountPage() {
  return mount(CreditsPage)
}

describe('CreditsPage (R-V4)', () => {
  it('renders one entry per credited component', () => {
    expect(mountPage().findAll('li.component')).toHaveLength(creditedComponents.length)
  })

  // A table of these four columns cannot fit a phone, so it always carried a horizontal
  // scroller. This layout must stay table-free for that reason.
  it('uses no table, so no viewport width can need a horizontal scroller', () => {
    const wrapper = mountPage()
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.findAll('li.component h2')).toHaveLength(creditedComponents.length)
  })

  it('names every component and its license', () => {
    const text = mountPage().text()
    for (const component of creditedComponents) {
      expect(text).toContain(component.name)
      expect(text).toContain(component.license)
    }
  })

  it("states this application's own license above the component table", () => {
    const wrapper = mountPage()
    const appLicense = wrapper.find('.app-license a')

    expect(appLicense.text()).toContain('AGPL')
    expect(appLicense.attributes('href')).toBe(operator.sourceUrl)
  })

  it('links every component to its upstream source, opened safely', () => {
    const wrapper = mountPage()
    const hrefs = wrapper
      .findAll('li.component')
      .map((item) => item.findAll('a').find((link) => !link.classes('license-file')))

    expect(hrefs).toHaveLength(creditedComponents.length)
    for (const [index, link] of hrefs.entries()) {
      const component = creditedComponents[index]
      expect(link?.attributes('href')).toBe(component?.sourceUrl)
      expect(link?.attributes('href')).toMatch(/^https:\/\//)
      expect(link?.attributes('target')).toBe('_blank')
      expect(link?.attributes('rel')).toBe('noopener')
    }
  })

  it('links every licence file on our own origin, with no traversal', () => {
    const wrapper = mountPage()
    const links = wrapper.findAll('a.license-file')
    const expected = creditedComponents.flatMap((component) =>
      component.files.map((file) => licenseTextUrl(component, file)),
    )

    expect(links.map((link) => link.attributes('href'))).toEqual(expected)
    for (const link of links) {
      const href = link.attributes('href') ?? ''
      expect(href.startsWith('/3rd_party_licenses/')).toBe(true)
      expect(href).not.toContain('..')
    }
  })

  it('covers every directory in 3rd_party_licenses/ — the T49 done-when, at component level', () => {
    const hrefs = mountPage()
      .findAll('a.license-file')
      .map((link) => link.attributes('href') ?? '')

    for (const component of creditedComponents) {
      expect(
        hrefs.some((href) => href.startsWith(`/3rd_party_licenses/${component.directory}/`)),
      ).toBe(true)
    }
  })

  it('shows the SPDX identifier only where it differs from the licence name', () => {
    const rows = mountPage().findAll('li.component')

    for (const [index, row] of rows.entries()) {
      const component = creditedComponents[index]
      if (component === undefined) continue

      if (component.licenseId === null || component.license.includes(component.licenseId)) {
        // No bare "MIT (MIT)" restatement.
        expect(row.text()).not.toContain(`(${component.licenseId})`)
      } else {
        expect(row.text()).toContain(`(${component.licenseId})`)
      }
      expect(row.text()).toContain(component.license)
    }
  })
})
