export const BYTES_PER_UNIT = 1000
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

interface ScaledSize {
  value: number
  unit: (typeof SIZE_UNITS)[number]
}

function scaleBytes(bytes: number): ScaledSize {
  let value = bytes
  let unitIndex = 0

  while (value >= BYTES_PER_UNIT && unitIndex < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT
    unitIndex += 1
  }

  return { value, unit: SIZE_UNITS[unitIndex]! }
}

/** Formats a size for the English, machine-readable report. */
export function formatReportSize(bytes: number): string {
  const { value, unit } = scaleBytes(bytes)

  return `${value.toFixed(2)} ${unit}`
}

/**
 * Which way an encode moved a file's size, and by how much, for the Preview comparison pill
 * (R-P5, T36).
 *
 * `direction` is what the interface signals with a glyph as well as a colour (R-K8); the percentage
 * is a magnitude and is always positive. An increase is never suppressed and never rounds down into
 * nothing: `belowOnePercent` exists so the interface can say "less than 1%" rather than print the
 * "0%" R-P5 explicitly forbids for a file that did get bigger.
 */
export interface SizeComparison {
  direction: 'reduction' | 'increase' | 'unchanged'
  /** Percent of the input, always positive, rounded to a whole number. */
  percent: number
  belowOnePercent: boolean
}

export function describeSizeComparison(inputBytes: number, outputBytes: number): SizeComparison {
  if (inputBytes <= 0 || !Number.isFinite(inputBytes) || !Number.isFinite(outputBytes)) {
    return { direction: 'unchanged', percent: 0, belowOnePercent: false }
  }

  if (outputBytes === inputBytes) {
    return { direction: 'unchanged', percent: 0, belowOnePercent: false }
  }

  const change = ((outputBytes - inputBytes) / inputBytes) * 100
  const magnitude = Math.abs(change)

  return {
    direction: change > 0 ? 'increase' : 'reduction',
    percent: Math.round(magnitude),
    belowOnePercent: magnitude < 1,
  }
}

/**
 * Formats a size for the interface using the active interface locale.
 *
 * `fractionDigits` defaults to 2; the Preview comparison pill passes 1 below the side-panel
 * breakpoint to keep the figures from crowding the narrow toolbar.
 */
export function formatUiSize(
  bytes: number,
  locales?: Intl.LocalesArgument,
  fractionDigits = 2,
): string {
  const { value, unit } = scaleBytes(bytes)
  const formattedValue = new Intl.NumberFormat(locales, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)

  return `${formattedValue} ${unit}`
}
