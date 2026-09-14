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

function resolveQuality(
  setting: QualitySetting,
  format: ResolvedSettings['format'],
): ResolvedQuality {
  if (setting.kind === 'size') {
    return setting
  }

  if (format === 'png') {
    const value = 70 + ((setting.value - 10) * 30) / 90

    return { kind: 'quality', value, lossless: value >= 95 }
  }

  return {
    kind: 'quality',
    value: setting.value,
    lossless: format !== 'jpeg' && setting.value > 95,
  }
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
      isAnimated: format.isAnimated,
      alpha: supportsAlpha(format.format)
        ? { kind: 'preserve' }
        : { kind: 'flatten', background: opaque(background ?? OPAQUE_WHITE) },
    },
    caveats: format.caveats,
  }
}
