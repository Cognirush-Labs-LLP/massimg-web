import { describe, expect, it } from 'vitest'
import type { NamingInput } from './naming'
import { resolveOutputNames } from './naming'

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

  it('uses the canonical extension for every selected output format', () => {
    expect(
      resolveOutputNames([
        input({ name: 'photo.JPEG', formatSetting: 'jpeg' }),
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
    ).toEqual(['photo.jpg', 'graphic.png', 'photo.webp', 'animation.avif', 'animation.gif'])
  })

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
