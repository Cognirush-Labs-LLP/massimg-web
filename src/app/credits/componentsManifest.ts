// The credited third-party components (R-V4), read from the same
// 3rd_party_licenses/components.json that scripts/check-licenses.mjs audits and
// scripts/copy-licenses.mjs copies into dist/. One manifest, so the page and the licence gate
// can never credit different sets (Technical Design §7.2).

/** One credited component. Values are data, not interface strings: they are never translated. */
export interface CreditedComponent {
  /** Directory under 3rd_party_licenses/. Two entries may share one directory. */
  directory: string
  name: string
  /** Human-readable licence name, which may describe a dual licence. */
  license: string
  /** SPDX identifier, or null where no single identifier is honest for this component. */
  licenseId: string | null
  sourceUrl: string
  files: readonly string[]
}

// Eagerly bundled at build time, with the glob rooted at the project root — the same mechanism
// content.ts uses, and for the same reason: identical behaviour in `pnpm dev`, the client build
// and vite-ssg's Node prerender pass, with no runtime fetch. A relative import would pull a file
// outside tsconfig.app.json's `include` into the program.
const manifestFiles = import.meta.glob('/3rd_party_licenses/components.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validates the manifest's shape and returns its components sorted by name.
 *
 * Throws rather than filtering bad entries out: a component that is bundled but silently
 * dropped from this page is the licence-compliance failure the page exists to prevent, so
 * silence is the worst available outcome.
 */
export function parseComponentsManifest(raw: unknown): CreditedComponent[] {
  const entries = (raw as { components?: unknown })?.components
  if (!Array.isArray(entries)) {
    throw new Error('components.json: expected a { "components": [...] } object')
  }

  const parsed = entries.map((entry, index): CreditedComponent => {
    const candidate = entry as Partial<CreditedComponent>
    const label = isNonEmptyString(candidate.name) ? candidate.name : `components[${index}]`

    for (const field of ['directory', 'name', 'license', 'sourceUrl'] as const) {
      if (!isNonEmptyString(candidate[field])) {
        throw new Error(`components.json: ${label} has no ${field}`)
      }
    }
    if (!(candidate.licenseId === null || isNonEmptyString(candidate.licenseId))) {
      throw new Error(`components.json: ${label} needs an SPDX licenseId or null`)
    }
    if (!candidate.sourceUrl!.startsWith('https://')) {
      throw new Error(`components.json: ${label} has a non-https sourceUrl`)
    }
    if (
      !Array.isArray(candidate.files) ||
      candidate.files.length === 0 ||
      !candidate.files.every(isNonEmptyString)
    ) {
      throw new Error(`components.json: ${label} lists no licence files`)
    }

    return {
      directory: candidate.directory!,
      name: candidate.name!,
      license: candidate.license!,
      licenseId: candidate.licenseId!,
      sourceUrl: candidate.sourceUrl!,
      files: [...candidate.files],
    }
  })

  const names = parsed.map((component) => component.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) {
    throw new Error(`components.json: "${duplicate}" appears more than once`)
  }

  return parsed.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

export const creditedComponents: readonly CreditedComponent[] = parseComponentsManifest(
  manifestFiles['/3rd_party_licenses/components.json'],
)

/**
 * The URL of one licence text, served from our own origin by scripts/copy-licenses.mjs. Pure
 * string building with no browser API, so it is safe during the Node prerender pass.
 */
export function licenseTextUrl(component: CreditedComponent, file: string): string {
  return `/3rd_party_licenses/${component.directory}/${file}`
}

/** A source URL as link text: the scheme carries no information for a reader. */
export function sourceLinkText(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '')
}
