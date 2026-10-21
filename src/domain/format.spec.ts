import { describe, expect, it } from 'vitest'
import {
  mimeForFormat,
  resolveFormat,
  sizeTargetDisabledReason,
  supportsAlpha,
  supportsAnimation,
  type FormatResolution,
  type FormatSetting,
} from './format'
import type { EncodableFormat, Format } from './types'

const SETTINGS = [
  'dont-change',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
] as const satisfies readonly FormatSetting[]

const RESOLVED_JPEG = {
  kind: 'resolved',
  format: 'jpeg',
  isAnimated: false,
  caveats: [],
} as const satisfies FormatResolution

const RESOLVED_PNG = {
  kind: 'resolved',
  format: 'png',
  isAnimated: false,
  caveats: [],
} as const satisfies FormatResolution

const RESOLVED_WEBP = {
  kind: 'resolved',
  format: 'webp',
  isAnimated: false,
  caveats: [],
} as const satisfies FormatResolution

const RESOLVED_AVIF = {
  kind: 'resolved',
  format: 'avif',
  isAnimated: false,
  caveats: [],
} as const satisfies FormatResolution

const RESOLVED_GIF = {
  kind: 'resolved',
  format: 'gif',
  isAnimated: false,
  caveats: [],
} as const satisfies FormatResolution

const ANIMATED_PNG = {
  kind: 'resolved',
  format: 'png',
  isAnimated: true,
  caveats: [],
} as const satisfies FormatResolution

const ANIMATED_WEBP = {
  kind: 'resolved',
  format: 'webp',
  isAnimated: true,
  caveats: [],
} as const satisfies FormatResolution

const ANIMATED_GIF = {
  kind: 'resolved',
  format: 'gif',
  isAnimated: true,
  caveats: [],
} as const satisfies FormatResolution

const ANIMATION_SUBSTITUTED = {
  kind: 'resolved',
  format: 'webp',
  isAnimated: true,
  caveats: [{ kind: 'animation-substituted' }],
} as const satisfies FormatResolution

const ANIMATED_AVIF_REJECTED = {
  kind: 'rejected',
  reason: 'animated-avif-input',
} as const satisfies FormatResolution

type ExpectedBySetting = readonly [
  FormatResolution,
  FormatResolution,
  FormatResolution,
  FormatResolution,
  FormatResolution,
  FormatResolution,
]

interface FormatMatrixRow {
  inputFormat: Format
  isAnimated: boolean
  expected: ExpectedBySetting
}

const STILL_EXPLICIT_FORMATS = [
  RESOLVED_JPEG,
  RESOLVED_PNG,
  RESOLVED_WEBP,
  RESOLVED_AVIF,
  RESOLVED_GIF,
] as const

const ANIMATED_EXPLICIT_FORMATS = [
  ANIMATION_SUBSTITUTED,
  ANIMATED_PNG,
  ANIMATED_WEBP,
  ANIMATION_SUBSTITUTED,
  ANIMATED_GIF,
] as const

const FORMAT_MATRIX = [
  { inputFormat: 'jpeg', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'png', isAnimated: false, expected: [RESOLVED_PNG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'webp', isAnimated: false, expected: [RESOLVED_WEBP, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'avif', isAnimated: false, expected: [RESOLVED_AVIF, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'gif', isAnimated: false, expected: [RESOLVED_GIF, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'bmp', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'tiff', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'jxl', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'jp2', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'heic', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  { inputFormat: 'heif', isAnimated: false, expected: [RESOLVED_JPEG, ...STILL_EXPLICIT_FORMATS] },
  {
    inputFormat: 'jpeg',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'png',
    isAnimated: true,
    expected: [ANIMATED_PNG, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'webp',
    isAnimated: true,
    expected: [ANIMATED_WEBP, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'avif',
    isAnimated: true,
    expected: [
      ANIMATED_AVIF_REJECTED,
      ANIMATED_AVIF_REJECTED,
      ANIMATED_AVIF_REJECTED,
      ANIMATED_AVIF_REJECTED,
      ANIMATED_AVIF_REJECTED,
      ANIMATED_AVIF_REJECTED,
    ],
  },
  {
    inputFormat: 'gif',
    isAnimated: true,
    expected: [ANIMATED_GIF, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'bmp',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'tiff',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'jxl',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'jp2',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'heic',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
  {
    inputFormat: 'heif',
    isAnimated: true,
    expected: [ANIMATION_SUBSTITUTED, ...ANIMATED_EXPLICIT_FORMATS],
  },
] as const satisfies readonly FormatMatrixRow[]

const FORMAT_CASES = FORMAT_MATRIX.flatMap(({ inputFormat, isAnimated, expected }) =>
  SETTINGS.map((setting, index) => ({
    inputFormat,
    isAnimated,
    setting,
    expected: expected[index]!,
  })),
)

describe('format routing', () => {
  it('contains every input format, animated flag, and batch setting combination exactly once', () => {
    expect(FORMAT_CASES).toHaveLength(11 * 2 * 6)
    expect(
      new Set(
        FORMAT_CASES.map(
          ({ inputFormat, isAnimated, setting }) => `${inputFormat}:${isAnimated}:${setting}`,
        ),
      ).size,
    ).toBe(FORMAT_CASES.length)
  })

  it.each(FORMAT_CASES)(
    'routes $inputFormat (animated=$isAnimated) under $setting',
    ({ inputFormat, isAnimated, setting, expected }) => {
      expect(resolveFormat(inputFormat, isAnimated, setting, true)).toEqual(expected)
    },
  )

  describe('without WebP for animated images', () => {
    it.each([
      ['gif', 'jpeg', 'jpeg'],
      ['gif', 'avif', 'avif'],
      ['png', 'jpeg', 'jpeg'],
      ['webp', 'avif', 'avif'],
      ['heic', 'dont-change', 'jpeg'],
    ] as const)(
      'writes animated %s as a still %s from its first frame under %s',
      (inputFormat, setting, format) => {
        expect(resolveFormat(inputFormat, true, setting, false)).toEqual({
          kind: 'resolved',
          format: setting === 'dont-change' ? format : setting,
          isAnimated: false,
          caveats: [{ kind: 'animation-flattened' }],
        })
      },
    )

    it.each(
      FORMAT_CASES.filter(
        ({ expected }) => expected.kind !== 'resolved' || !expected.caveats.length,
      ),
    )(
      'leaves $inputFormat (animated=$isAnimated) under $setting as it was',
      ({ inputFormat, isAnimated, setting, expected }) => {
        expect(resolveFormat(inputFormat, isAnimated, setting, false)).toEqual(expected)
      },
    )
  })

  it.each([
    ['jpeg', false],
    ['png', true],
    ['webp', true],
    ['avif', true],
    ['gif', true],
  ] as const satisfies readonly (readonly [EncodableFormat, boolean])[])(
    'reports alpha capability for %s',
    (format, expected) => {
      expect(supportsAlpha(format)).toBe(expected)
    },
  )

  it.each([
    ['jpeg', false],
    ['png', true],
    ['webp', true],
    ['avif', false],
    ['gif', true],
  ] as const satisfies readonly (readonly [EncodableFormat, boolean])[])(
    'reports animation capability for %s',
    (format, expected) => {
      expect(supportsAnimation(format)).toBe(expected)
    },
  )

  it.each(['jpeg', 'png', 'webp', 'avif', 'gif'] as const satisfies readonly EncodableFormat[])(
    'does not disable size targeting for %s (T30/D1: none measured prohibitive)',
    (format) => {
      expect(sizeTargetDisabledReason(format)).toBeNull()
    },
  )

  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
    ['gif', 'image/gif'],
  ] as const satisfies readonly (readonly [EncodableFormat, string])[])(
    'gives %s the media type %s',
    (format, expected) => {
      expect(mimeForFormat(format)).toBe(expected)
    },
  )

  it('gives an animated PNG the still PNG media type, since APNG has none of its own', () => {
    expect(mimeForFormat('png')).toBe('image/png')
  })
})
