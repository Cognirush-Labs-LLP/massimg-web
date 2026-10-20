import { describe, expect, it } from 'vitest'
import {
  creditedComponents,
  licenseTextUrl,
  parseComponentsManifest,
  sourceLinkText,
} from './componentsManifest'

// Every directory that must be credited (R-V4, Technical Design §7.2). Listed literally rather
// than derived from the manifest: deriving it would make this assertion vacuous, since a
// manifest with entries deleted would still agree with itself. Reconciliation against the real
// directory listing lives in scripts/check-licenses.mjs, which runs in CI — vitest here has no
// `node` lib (tsconfig.app.json), so it cannot read the tree.
const REQUIRED_DIRECTORIES = [
  'imagemagick',
  'libde265',
  'libheif',
  'libwebp',
  'aom',
  'lcms2',
  'libjpeg-turbo',
  'libpng',
  'gifsicle',
  'oxipng',
  'libimagequant',
  'upng-js',
  'apng-optimizer',
  'client-zip',
]

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    directory: 'oxipng',
    name: 'oxipng',
    license: 'MIT',
    licenseId: 'MIT',
    sourceUrl: 'https://github.com/oxipng/oxipng',
    files: ['LICENSE'],
    ...overrides,
  }
}

describe('the committed manifest', () => {
  it('parses, and credits every directory that holds licence text', () => {
    const directories = new Set(creditedComponents.map((component) => component.directory))
    for (const directory of REQUIRED_DIRECTORIES) {
      expect(directories).toContain(directory)
    }
    expect(directories.size).toBe(REQUIRED_DIRECTORIES.length)
  })

  it('gives every component a name, a licence, an https source and at least one licence file', () => {
    for (const component of creditedComponents) {
      expect(component.name).not.toBe('')
      expect(component.license).not.toBe('')
      expect(component.sourceUrl).toMatch(/^https:\/\//)
      expect(component.files.length).toBeGreaterThan(0)
    }
  })

  it('is sorted by name, so the page order does not follow JSON authoring order', () => {
    const names = creditedComponents.map((component) => component.name)
    expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names)
  })
})

describe('parseComponentsManifest', () => {
  it('rejects a missing required field', () => {
    const entry = validEntry()
    delete entry.license
    expect(() => parseComponentsManifest({ components: [entry] })).toThrow(/license/)
  })

  it('rejects a non-https source URL', () => {
    expect(() =>
      parseComponentsManifest({ components: [validEntry({ sourceUrl: 'http://example.com' })] }),
    ).toThrow(/non-https/)
  })

  it('rejects an empty file list, which would credit a component with no licence text', () => {
    expect(() => parseComponentsManifest({ components: [validEntry({ files: [] })] })).toThrow(
      /licence files/,
    )
  })

  it('rejects a duplicated component name', () => {
    expect(() => parseComponentsManifest({ components: [validEntry(), validEntry()] })).toThrow(
      /more than once/,
    )
  })

  it('accepts a null licenseId, which is how a dual licence is expressed', () => {
    const parsed = parseComponentsManifest({ components: [validEntry({ licenseId: null })] })
    expect(parsed[0]?.licenseId).toBeNull()
  })

  it('rejects anything that is not a components array', () => {
    expect(() => parseComponentsManifest({})).toThrow()
    expect(() => parseComponentsManifest(null)).toThrow()
  })
})

describe('licenseTextUrl', () => {
  it('builds an origin-relative path for every component and file, with no traversal', () => {
    for (const component of creditedComponents) {
      for (const file of component.files) {
        const url = licenseTextUrl(component, file)
        expect(url).toBe(`/3rd_party_licenses/${component.directory}/${file}`)
        expect(url).not.toContain('..')
        expect(url.startsWith('/')).toBe(true)
      }
    }
  })
})

describe('sourceLinkText', () => {
  it('strips the scheme and any trailing slash', () => {
    expect(sourceLinkText('https://github.com/oxipng/oxipng')).toBe('github.com/oxipng/oxipng')
    expect(sourceLinkText('https://aomedia.googlesource.com/aom/')).toBe(
      'aomedia.googlesource.com/aom',
    )
  })
})
