import { describe, expect, it } from 'vitest'

// A fork changes the `operator` block in site.ts and expects the site to follow. That only holds
// while nothing else spells those values out, so this fails on any stray copy.
const sources = import.meta.glob(
  ['/src/**/*.{ts,vue,json}', '/content/**/*.md', '!/src/**/*.spec.ts', '!/src/config/site.ts'],
  { eager: true, query: '?raw', import: 'default' },
) as Record<string, string>

// Terms sections 10 and 11 name the upstream author and its redistribution conditions
// (NOTICE.txt). They describe Cognirush, not whoever deploys the build, so they stay literal.
function withoutUpstreamAttribution(path: string, text: string): string {
  if (!path.endsWith('/content/en/terms.md')) {
    return text
  }
  const start = text.indexOf('## 10.')
  const end = text.indexOf('## 12.')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return text.slice(0, start) + text.slice(end)
}

describe('operator values live only in src/config/site.ts', () => {
  it('scans the real source and content files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
    expect(Object.keys(sources)).toContain('/content/en/terms.md')
  })

  it.each([/cognirush/i, /massimg-web/i])('has no %s outside the config', (pattern) => {
    const offenders = Object.entries(sources)
      .filter(([path, text]) => pattern.test(withoutUpstreamAttribution(path, text)))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
