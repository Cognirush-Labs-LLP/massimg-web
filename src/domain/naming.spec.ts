import { describe, expect, it } from 'vitest'
import type { NamingInput } from './naming'
import { resolveOutputNames, resolveShareNames } from './naming'

function input(overrides: Partial<NamingInput> & Pick<NamingInput, 'name'>): NamingInput {
  const { name, ...otherOverrides } = overrides

  return {
    name,
    relativePath: null,
    sourceFormat: 'jpeg',
    formatSetting: 'dont-change',
    resolvedFormat: 'jpeg',
    ...otherOverrides,
  }
}

describe('output naming', () => {
  it("reproduces original extension spelling and case under Don't change", () => {
    expect(
      resolveOutputNames([
        input({ name: 'photo.JPG' }),
        input({ name: 'image.jpeg' }),
        input({ name: 'graphic.PnG', sourceFormat: 'png', resolvedFormat: 'png' }),
      ]),
    ).toEqual(['photo.JPG', 'image.jpeg', 'graphic.PnG'])
  })

  it('uses the canonical extension for a genuine format conversion', () => {
    expect(
      resolveOutputNames([
        input({ name: 'graphic.JPEG', formatSetting: 'png', resolvedFormat: 'png' }),
        input({ name: 'photo.JPEG', formatSetting: 'webp', resolvedFormat: 'webp' }),
        input({
          name: 'animation.GIF',
          sourceFormat: 'gif',
          formatSetting: 'avif',
          resolvedFormat: 'avif',
        }),
        input({ name: 'animation.JPEG', formatSetting: 'gif', resolvedFormat: 'gif' }),
      ]),
    ).toEqual(['graphic.png', 'photo.webp', 'animation.avif', 'animation.gif'])
  })

  it('preserves the original extension when an explicit selection names the same format as the source', () => {
    expect(resolveOutputNames([input({ name: 'photo.JPEG', formatSetting: 'jpeg' })])).toEqual([
      'photo.JPEG',
    ])
  })

  interface ExtensionCase {
    sourceName: string
    formatSetting: NamingInput['formatSetting']
    sourceFormat: NamingInput['sourceFormat']
    resolvedFormat: NamingInput['resolvedFormat']
    expectedName: string
  }

  const EXTENSION_CASES = [
    {
      sourceName: 'photo.JPG',
      formatSetting: 'dont-change',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'photo.JPG',
    },
    {
      sourceName: 'photo.JPG',
      formatSetting: 'jpeg',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'photo.JPG',
    },
    {
      sourceName: 'photo.jpeg',
      formatSetting: 'dont-change',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'photo.jpeg',
    },
    {
      sourceName: 'photo.jpeg',
      formatSetting: 'jpeg',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'photo.jpeg',
    },
    {
      sourceName: 'photo.PNG',
      formatSetting: 'dont-change',
      sourceFormat: 'png',
      resolvedFormat: 'png',
      expectedName: 'photo.PNG',
    },
    {
      sourceName: 'photo.PNG',
      formatSetting: 'png',
      sourceFormat: 'png',
      resolvedFormat: 'png',
      expectedName: 'photo.PNG',
    },
    {
      sourceName: 'photo.JPEG',
      formatSetting: 'webp',
      sourceFormat: 'jpeg',
      resolvedFormat: 'webp',
      expectedName: 'photo.webp',
    },
    {
      sourceName: 'camera_raw_file',
      formatSetting: 'dont-change',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'camera_raw_file',
    },
    {
      sourceName: 'camera_raw_file',
      formatSetting: 'jpeg',
      sourceFormat: 'jpeg',
      resolvedFormat: 'jpeg',
      expectedName: 'camera_raw_file',
    },
    {
      sourceName: 'camera_raw_file',
      formatSetting: 'png',
      sourceFormat: 'jpeg',
      resolvedFormat: 'png',
      expectedName: 'camera_raw_file.png',
    },
  ] as const satisfies readonly ExtensionCase[]

  it.each(EXTENSION_CASES)(
    '$sourceName under $formatSetting ($sourceFormat -> $resolvedFormat) resolves to $expectedName',
    ({ sourceName, formatSetting, sourceFormat, resolvedFormat, expectedName }) => {
      expect(
        resolveOutputNames([
          input({ name: sourceName, formatSetting, sourceFormat, resolvedFormat }),
        ]),
      ).toEqual([expectedName])
    },
  )

  it("uses the resolved canonical extension for a Don't change fallback or substitution", () => {
    expect(
      resolveOutputNames([
        input({ name: 'camera.HEIC', sourceFormat: 'heic', resolvedFormat: 'jpeg' }),
        input({ name: 'motion.JPEG', resolvedFormat: 'webp' }),
      ]),
    ).toEqual(['camera.jpg', 'motion.webp'])
  })

  it("preserves the original extension under Don't change even when content and extension differ", () => {
    expect(resolveOutputNames([input({ name: 'mislabelled.PNG' })])).toEqual(['mislabelled.PNG'])
  })

  it('suffixes conversions that map multiple inputs onto one name', () => {
    expect(
      resolveOutputNames([
        input({ name: 'photo.png', sourceFormat: 'png', formatSetting: 'jpeg' }),
        input({ name: 'photo.webp', sourceFormat: 'webp', formatSetting: 'jpeg' }),
        input({ name: 'photo.gif', sourceFormat: 'gif', formatSetting: 'jpeg' }),
      ]),
    ).toEqual(['photo.jpg', 'photo-1.jpg', 'photo-2.jpg'])
  })

  it('skips suffixes already occupied by an earlier natural output name', () => {
    expect(
      resolveOutputNames([
        input({ name: 'photo.png', sourceFormat: 'png', formatSetting: 'jpeg' }),
        input({ name: 'photo-1.png', sourceFormat: 'png', formatSetting: 'jpeg' }),
        input({ name: 'photo.webp', sourceFormat: 'webp', formatSetting: 'jpeg' }),
      ]),
    ).toEqual(['photo.jpg', 'photo-1.jpg', 'photo-2.jpg'])
  })

  it('does not rename identical output names in different folders', () => {
    expect(
      resolveOutputNames([
        input({
          name: 'photo.PNG',
          relativePath: 'a/photo.PNG',
          sourceFormat: 'png',
          resolvedFormat: 'png',
        }),
        input({
          name: 'photo.PNG',
          relativePath: 'b/photo.PNG',
          sourceFormat: 'png',
          resolvedFormat: 'png',
        }),
        input({
          name: 'photo.PNG',
          relativePath: 'b/nested/photo.PNG',
          sourceFormat: 'png',
          resolvedFormat: 'png',
        }),
      ]),
    ).toEqual(['a/photo.PNG', 'b/photo.PNG', 'b/nested/photo.PNG'])
  })

  it('resolves collisions independently inside each folder', () => {
    expect(
      resolveOutputNames([
        input({
          name: 'photo.png',
          relativePath: 'a/photo.png',
          sourceFormat: 'png',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo.webp',
          relativePath: 'a/photo.webp',
          sourceFormat: 'webp',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo.png',
          relativePath: 'b/photo.png',
          sourceFormat: 'png',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo.webp',
          relativePath: 'b/photo.webp',
          sourceFormat: 'webp',
          formatSetting: 'jpeg',
        }),
      ]),
    ).toEqual(['a/photo.jpg', 'a/photo-1.jpg', 'b/photo.jpg', 'b/photo-1.jpg'])
  })

  it('keeps dots in the base name and inserts suffixes before the final extension', () => {
    expect(
      resolveOutputNames([
        input({ name: 'holiday.photo.JpG' }),
        input({ name: 'holiday.photo.JpG' }),
      ]),
    ).toEqual(['holiday.photo.JpG', 'holiday.photo-1.JpG'])
  })
})

describe('share naming (R-X53)', () => {
  it('flattens every directory away, keeping input order', () => {
    expect(
      resolveShareNames([
        input({ name: 'beach.jpg', relativePath: 'holiday/day1/beach.jpg' }),
        input({ name: 'hotel.jpg', relativePath: 'holiday/day2/hotel.jpg' }),
        input({ name: 'cover.jpg', relativePath: 'holiday/cover.jpg' }),
        input({ name: 'loose.jpg' }),
      ]),
    ).toEqual(['beach.jpg', 'hotel.jpg', 'cover.jpg', 'loose.jpg'])
  })

  // The one case resolveOutputNames deliberately does not catch: a share payload has no
  // directory tree, so two same-named files from different folders do collide here.
  it('resolves a cross-directory collision globally, in grid order', () => {
    const inputs = [
      input({
        name: 'photo.PNG',
        relativePath: 'a/photo.PNG',
        sourceFormat: 'png',
        resolvedFormat: 'png',
      }),
      input({
        name: 'photo.PNG',
        relativePath: 'b/photo.PNG',
        sourceFormat: 'png',
        resolvedFormat: 'png',
      }),
      input({
        name: 'photo.PNG',
        relativePath: 'b/nested/photo.PNG',
        sourceFormat: 'png',
        resolvedFormat: 'png',
      }),
    ]

    expect(resolveShareNames(inputs)).toEqual(['photo.PNG', 'photo-1.PNG', 'photo-2.PNG'])
    // Same inputs, unchanged under the ZIP's directory-scoped rule (R-X22) — the two scopes are
    // live at once for a Share-eligible folder run and must not interfere.
    expect(resolveOutputNames(inputs)).toEqual(['a/photo.PNG', 'b/photo.PNG', 'b/nested/photo.PNG'])
  })

  it('is stable against grid order: the earlier image keeps the unsuffixed name', () => {
    const a = input({
      name: 'photo.png',
      relativePath: 'a/photo.png',
      sourceFormat: 'png',
      resolvedFormat: 'png',
    })
    const b = input({
      name: 'photo.png',
      relativePath: 'b/photo.png',
      sourceFormat: 'png',
      resolvedFormat: 'png',
    })

    expect(resolveShareNames([a, b])).toEqual(['photo.png', 'photo-1.png'])
    expect(resolveShareNames([b, a])).toEqual(['photo.png', 'photo-1.png'])
  })

  it('also collides on names that only meet after a format conversion', () => {
    expect(
      resolveShareNames([
        input({
          name: 'photo.png',
          relativePath: 'a/photo.png',
          sourceFormat: 'png',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo.webp',
          relativePath: 'b/photo.webp',
          sourceFormat: 'webp',
          formatSetting: 'jpeg',
        }),
      ]),
    ).toEqual(['photo.jpg', 'photo-1.jpg'])
  })

  it('skips a suffix already occupied by an earlier natural name', () => {
    expect(
      resolveShareNames([
        input({
          name: 'photo.png',
          relativePath: 'a/photo.png',
          sourceFormat: 'png',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo-1.png',
          relativePath: 'b/photo-1.png',
          sourceFormat: 'png',
          formatSetting: 'jpeg',
        }),
        input({
          name: 'photo.webp',
          relativePath: 'c/photo.webp',
          sourceFormat: 'webp',
          formatSetting: 'jpeg',
        }),
      ]),
    ).toEqual(['photo.jpg', 'photo-1.jpg', 'photo-2.jpg'])
  })

  it('applies the same extension rules as the ZIP path (R-X43/R-X44)', () => {
    expect(
      resolveShareNames([
        input({ name: 'photo.JPG', relativePath: 'a/photo.JPG' }),
        input({ name: 'image.jpeg', relativePath: 'a/image.jpeg', formatSetting: 'jpeg' }),
        input({
          name: 'camera.HEIC',
          relativePath: 'b/camera.HEIC',
          sourceFormat: 'heic',
          resolvedFormat: 'jpeg',
        }),
        input({
          name: 'extensionless',
          relativePath: 'b/extensionless',
          formatSetting: 'png',
          resolvedFormat: 'png',
        }),
      ]),
    ).toEqual(['photo.JPG', 'image.jpeg', 'camera.jpg', 'extensionless.png'])
  })

  it('keeps dots in the base name and inserts the suffix before the final extension', () => {
    expect(
      resolveShareNames([
        input({ name: 'holiday.photo.JpG', relativePath: 'a/holiday.photo.JpG' }),
        input({ name: 'holiday.photo.JpG', relativePath: 'b/holiday.photo.JpG' }),
      ]),
    ).toEqual(['holiday.photo.JpG', 'holiday.photo-1.JpG'])
  })

  it('returns nothing for no inputs', () => {
    expect(resolveShareNames([])).toEqual([])
  })

  it('agrees with the ZIP basename for a lone file, whatever directory it came from', () => {
    // Why a 1-image run needs no separate naming pass: one file cannot collide under either
    // scope, so the sink's ZIP basename already *is* its Share name (R-X49's "same direct
    // output"). Asserted rather than assumed, because run-archive.ts relies on it.
    for (const relativePath of [null, 'deep/nested/photo.JPG']) {
      const only = input({ name: 'photo.JPG', relativePath })
      const [zipPath] = resolveOutputNames([only])
      const [shareName] = resolveShareNames([only])
      expect(zipPath?.slice(zipPath.lastIndexOf('/') + 1)).toBe(shareName)
    }
  })
})
