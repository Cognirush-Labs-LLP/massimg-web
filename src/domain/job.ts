import { hasCropOp } from './edit'
import { resolveFormat, supportsAlpha, type FormatSetting, type FormatResolution } from './format'
import type {
  Caveat,
  EditRecord,
  Format,
  ResolvedDimension,
  ResolvedQuality,
  ResolvedSettings,
  Rgba,
} from './types'

export type QualitySetting =
  { kind: 'quality'; value: number } | { kind: 'size'; targetBytes: number }

export interface BatchSettings {
  quality: QualitySetting
  dimension: ResolvedDimension
  format: FormatSetting
}

export interface SettingsImage {
  sourceFormat: Format
  isAnimated: boolean
  edit: EditRecord | null
}

export type SettingsResolution =
  | {
      kind: 'resolved'
      settings: ResolvedSettings
      caveats: Caveat[]
    }
  | Extract<FormatResolution, { kind: 'rejected' }>

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba

/** The lowest position the quality slider offers (Functional Design §4.1). */
export const QUALITY_SLIDER_MIN = 10
/** The highest position the quality slider offers (Functional Design §4.1). */
export const QUALITY_SLIDER_MAX = 100

/**
 * One slider position, mapped onto what the chosen format's encoder is actually asked for
 * (Functional Design §7.1, R-Q5, R-Q11, R-Q12; Technical Design §7.4).
 *
 * Exported because the size-target search (T30) walks the slider itself: it encodes at a position,
 * measures, and moves. That search has to produce exactly the file the same slider position would
 * have produced in quality mode, so it maps through this function rather than carrying a second
 * copy of R-Q11's rescale and R-Q12's lossless point.
 *
 * The PNG value is deliberately *not* rounded here — see `png-plan.ts`'s `quantizerSettings`.
 */
export function qualityForSlider(
  slider: number,
  format: ResolvedSettings['format'],
): Extract<ResolvedQuality, { kind: 'quality' }> {
  if (format === 'png') {
    const value = 70 + ((slider - 10) * 30) / 90

    return { kind: 'quality', value, lossless: value >= 95 }
  }

  return {
    kind: 'quality',
    value: slider,
    lossless: format !== 'jpeg' && slider > 95,
  }
}

function resolveQuality(
  setting: QualitySetting,
  format: ResolvedSettings['format'],
): ResolvedQuality {
  if (setting.kind === 'size') {
    return setting
  }

  return qualityForSlider(setting.value, format)
}

function resolveDimension(
  dimension: ResolvedDimension,
  edit: EditRecord | null,
): ResolvedDimension {
  return edit !== null && hasCropOp(edit.ops) ? { kind: 'original' } : dimension
}

function cropBackground(edit: EditRecord | null): Rgba | null {
  if (edit === null) {
    return null
  }

  for (let index = edit.ops.length - 1; index >= 0; index -= 1) {
    const op = edit.ops[index]

    if (op?.kind === 'crop') {
      return op.background
    }
  }

  return null
}

function opaque(background: Rgba): Rgba {
  return { ...background, a: 1 }
}

/** Resolves batch-wide controls into the settings used for one image job. */
export function resolveSettings(image: SettingsImage, batch: BatchSettings): SettingsResolution {
  const format = resolveFormat(image.sourceFormat, image.isAnimated, batch.format)

  if (format.kind === 'rejected') {
    return format
  }

  const background = cropBackground(image.edit)

  return {
    kind: 'resolved',
    settings: {
      quality: resolveQuality(batch.quality, format.format),
      dimension: resolveDimension(batch.dimension, image.edit),
      format: format.format,
      sourceFormat: image.sourceFormat,
      isAnimated: format.isAnimated,
      alpha: supportsAlpha(format.format)
        ? { kind: 'preserve' }
        : { kind: 'flatten', background: opaque(background ?? OPAQUE_WHITE) },
    },
    caveats: format.caveats,
  }
}

/**
 * R-Q2's first half: whether the source file already *is* what the job asks for, so that an image
 * already under the target can be passed through rather than re-encoded.
 *
 * This is R-X45's test, applied to R-Q2 instead of to R-X24: the original may only be returned when
 * returning it gives the user what they asked for. A format change, any dimension rule, a rotation
 * or a crop all mean the source does not satisfy the request, however small it is, and the search
 * runs normally.
 *
 * It lives here rather than in the pipeline because R-X24 needs exactly the same test when it is
 * built, and two copies of it would be two places to get R-X45 wrong.
 */
export function requestIsSatisfiedBySource(
  settings: ResolvedSettings,
  edit: EditRecord | null,
): boolean {
  return (
    settings.format === settings.sourceFormat &&
    settings.dimension.kind === 'original' &&
    edit === null
  )
}
