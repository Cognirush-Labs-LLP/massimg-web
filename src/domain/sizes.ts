const BYTES_PER_UNIT = 1024
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

/** Formats a size for the interface using the active interface locale. */
export function formatUiSize(bytes: number, locales?: Intl.LocalesArgument): string {
  const { value, unit } = scaleBytes(bytes)
  const formattedValue = new Intl.NumberFormat(locales, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)

  return `${formattedValue} ${unit}`
}
