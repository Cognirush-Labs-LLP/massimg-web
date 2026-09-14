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
