import type { Caveat, EncodableFormat, Format } from './types'

export type FormatSetting = 'dont-change' | EncodableFormat

export type FormatResolution =
  | {
      kind: 'resolved'
      format: EncodableFormat
      isAnimated: boolean
      caveats: Caveat[]
    }
  | {
      kind: 'rejected'
      reason: 'animated-avif-input'
    }

const ENCODABLE_FORMATS = new Set<Format>(['jpeg', 'png', 'webp', 'avif', 'gif'])
const ANIMATED_FORMATS = new Set<EncodableFormat>(['png', 'webp', 'gif'])

function isEncodableFormat(format: Format): format is EncodableFormat {
  return ENCODABLE_FORMATS.has(format)
}

export function supportsAnimation(format: EncodableFormat): boolean {
  return ANIMATED_FORMATS.has(format)
}

export function supportsAlpha(format: EncodableFormat): boolean {
  return format !== 'jpeg'
}

/**
 * Whether an image's *effective* output format supports alpha, for Edit mode's background row
 * (R-C13/R-C14; T37) and the Edit draft store's default fill on fresh entry. Composes
 * `resolveFormat`/`supportsAlpha` rather than re-deriving format resolution a second time —
 * the same path `domain/job.ts`'s `resolveSettings` uses.
 */
export function isAlphaCapable(
  inputFormat: Format,
  isAnimated: boolean,
  setting: FormatSetting,
): boolean {
  const resolution = resolveFormat(inputFormat, isAnimated, setting)
  return resolution.kind === 'resolved' && supportsAlpha(resolution.format)
}

const MIME_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
} as const satisfies Record<EncodableFormat, string>

/**
 * The media type to give a `Blob` of this format's encoded bytes, so the Preview frame can hand them
 * to an `<img>` and let the browser apply the embedded colour profile itself (R-I16, T36).
 *
 * An animated PNG is `image/png`: APNG has no media type of its own, which is the same reason R-F1
 * does not offer it as a separate format choice.
 */
export function mimeForFormat(format: EncodableFormat): string {
  return MIME_TYPES[format]
}

/**
 * R-Q4's disabling mechanism: which formats make repeated size-target encoding prohibitively
 * expensive, and why. T30/assumptions.md D1 measured every format through the shipped search and
 * found none prohibitive, so this returns `null` for all five today — the mechanism exists so a
 * future re-measurement is a data change here, not new UI work in the Size control.
 */
export function sizeTargetDisabledReason(format: EncodableFormat): string | null {
  switch (format) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'avif':
    case 'gif':
      return null
    default: {
      const unknown: never = format
      throw new RangeError(`unsupported format: ${JSON.stringify(unknown)}`)
    }
  }
}

/** Resolves a batch format choice for one input image. */
export function resolveFormat(
  inputFormat: Format,
  isAnimated: boolean,
  setting: FormatSetting,
): FormatResolution {
  if (inputFormat === 'avif' && isAnimated) {
    return { kind: 'rejected', reason: 'animated-avif-input' }
  }

  const requestedFormat =
    setting === 'dont-change' ? (isEncodableFormat(inputFormat) ? inputFormat : 'jpeg') : setting

  if (isAnimated && !supportsAnimation(requestedFormat)) {
    return {
      kind: 'resolved',
      format: 'webp',
      isAnimated: true,
      caveats: [{ kind: 'animation-substituted' }],
    }
  }

  return {
    kind: 'resolved',
    format: requestedFormat,
    isAnimated,
    caveats: [],
  }
}
