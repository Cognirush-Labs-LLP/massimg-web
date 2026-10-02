import { hasCropOp, resolveEditedSize, type PixelSize } from './edit'
import { resolveResizedSize } from './dimension'
import { resolveFormat, supportsAlpha, type FormatSetting, type FormatResolution } from './format'
import type {
  Caveat,
  EditRecord,
  EncodableFormat,
  Format,
  ImageRecord,
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

/**
 * The primary action's facts-only meta line (Functional Design R-A2, R-F4; Technical Design §4.1).
 * A multi-image batch never resolves a single output format, so its label names the *setting*
 * ("original" under "Don't change", per R-F4's literal wording, unconditional on batch size —
 * otherwise the batch format the user picked). A single image's label instead goes through
 * `resolveFormat` so an R-F2 fallback (unencodable input to JPEG) or an R-F6 animated substitution
 * shows the real output format rather than the raw setting — except under "Don't change" itself,
 * where R-F4 still applies and no concrete format is named even though one is resolvable.
 */
export type PrimaryActionSummary =
  | { kind: 'empty' }
  | { kind: 'multi'; count: number; formatLabel: 'original' | EncodableFormat }
  | { kind: 'single'; formatLabel: 'original' | EncodableFormat; dimensions: PixelSize | null }

/**
 * The output size a single image would produce, for display only (never encoded from this). Crop
 * overrides the batch dimension rule and supplies its own size (R-D1); a rotation-only edit still
 * follows the batch rule, applied to the rotated size (R-D4). `null` when the source's own
 * dimensions haven't been probed yet (`ImageRecord.width`/`height` still 0, `imageMeta.ts`'s same
 * "pending" convention) — the meta line omits the figure rather than inventing one.
 *
 * Exported since T36: the Preview transform line (R-P's `abc.jpeg 1000×1000 → abc.webp 500×500`)
 * shows the same figure for the same image, and two copies of R-D1/R-D4 are two places to get the
 * crop override wrong. The size is for display only — nothing is ever encoded from it.
 */
export function singleImageDimensions(
  image: ImageRecord,
  dimension: ResolvedDimension,
): PixelSize | null {
  if (image.width === 0 || image.height === 0) {
    return null
  }

  const ops = image.edit?.ops ?? []
  const edited = resolveEditedSize({ width: image.width, height: image.height }, ops)

  return hasCropOp(ops) ? edited : resolveResizedSize(edited, dimension)
}

export function describePrimaryActionOutput(
  images: readonly ImageRecord[],
  batch: BatchSettings,
): PrimaryActionSummary {
  if (images.length === 0) {
    return { kind: 'empty' }
  }

  if (images.length > 1) {
    return {
      kind: 'multi',
      count: images.length,
      formatLabel: batch.format === 'dont-change' ? 'original' : batch.format,
    }
  }

  const image = images[0]!
  const dimensions = singleImageDimensions(image, batch.dimension)

  if (batch.format === 'dont-change') {
    return { kind: 'single', formatLabel: 'original', dimensions }
  }

  const resolution = resolveFormat(image.sourceFormat, image.isAnimated, batch.format)

  return {
    kind: 'single',
    // A rejected resolution (today, only an animated-AVIF source classify() hasn't filtered out
    // yet — R-F8's selection-time rejection is T39's) has no resolved format to name; fall back to
    // the raw setting rather than fabricating one.
    formatLabel: resolution.kind === 'resolved' ? resolution.format : batch.format,
    dimensions,
  }
}
