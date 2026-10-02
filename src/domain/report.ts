import { formatReportSize } from './sizes'
import type { Caveat, Rgba, SizeTargetSkipReason } from './types'

export interface ReportFile {
  name: string
  /** Path relative to the selected folder root, when the input came from a folder. */
  relativePath: string | null
}

export interface ReportSuccess {
  file: ReportFile
  inputBytes: number
  outputBytes: number
  caveats: Caveat[]
}

export interface ReportFailure {
  file: ReportFile
  reason: string
}

export interface ReportSkippedImage {
  file: ReportFile
  reason: string | SizeTargetSkipReason
}

export interface ReportSettings {
  quality: number | string
  format: string
  dimension: string
}

export interface ReportSource {
  run: string
  settings: ReportSettings
  successes: ReportSuccess[]
  failures: ReportFailure[]
  skippedImages: ReportSkippedImage[]
  /** Accepted for classification output completeness, but deliberately never represented in a report. */
  nonImages?: ReportFile[]
}

export interface ReportIssueModel {
  file: string
  reason: string
}

export interface ReportNoteModel {
  file: string
  note: string
}

export interface ReportModel {
  Run: string
  Summary: {
    'Images processed': number
    Succeeded: number
    Failed: number
    Skipped: number
    'Input size': string
    'Output size': string
    Saved: string
    'Exact bytes': {
      Input: number
      Output: number
      Saved: number
    }
  }
  Settings: {
    Quality: number | string
    Format: string
    Dimension: string
  }
  Failed: ReportIssueModel[]
  Skipped: ReportIssueModel[]
  Notes: ReportNoteModel[]
}

function reportPath(file: ReportFile): string {
  return file.relativePath ?? file.name
}

function formatSaved(inputBytes: number, savedBytes: number): string {
  const size =
    savedBytes < 0 ? `-${formatReportSize(Math.abs(savedBytes))}` : formatReportSize(savedBytes)
  const percentage = inputBytes === 0 ? 0 : (savedBytes / inputBytes) * 100

  return `${size} (${percentage.toFixed(1)}%)`
}

function formatFill(fill: Rgba): string {
  if (fill.r === 255 && fill.g === 255 && fill.b === 255) {
    return 'white'
  }

  if (fill.r === 0 && fill.g === 0 && fill.b === 0) {
    return 'black'
  }

  return `rgb(${fill.r}, ${fill.g}, ${fill.b})`
}

/** Converts one member of R-X46's closed caveat set into report text. */
export function formatCaveat(caveat: Caveat): string {
  switch (caveat.kind) {
    case 'transparency-flattened':
      return `Transparency flattened to ${formatFill(caveat.fill)}; output format has no alpha channel`
    case 'animation-substituted':
      return 'Animation substituted; output written as WebP because the chosen format cannot animate'
    case 'metadata-removed':
      return caveat.gpsDataRemoved
        ? 'Metadata removed, including GPS data'
        : 'Metadata removed; GPS data was not among it'
    case 'original-kept':
      return 'Original kept; re-encoding produced a larger file'
    case 'output-larger-than-input':
      return `Output larger than input; input ${formatReportSize(caveat.inputBytes)}, output ${formatReportSize(caveat.outputBytes)}`
    case 'png-quantized':
      return 'PNG quantized; PNG was not written losslessly'
    case 'colour-converted':
      return 'Colour converted to sRGB; output format could not carry the source colour information'
    case 'auxiliary-images-dropped':
      return 'Auxiliary images dropped; only the primary image was processed'
  }
}

export function formatSkippedReason(reason: string | SizeTargetSkipReason): string {
  if (typeof reason === 'string') return reason

  return `Size target not reached; target ${formatReportSize(reason.targetBytes)}, smallest achieved ${formatReportSize(reason.achievedBytes)}, ${reason.width}×${reason.height} ${reason.format.toUpperCase()}`
}

/** Builds the complete, serialisable report model from reportable run outcomes. */
export function buildReport(source: ReportSource): ReportModel {
  const inputBytes = source.successes.reduce((total, success) => total + success.inputBytes, 0)
  const outputBytes = source.successes.reduce((total, success) => total + success.outputBytes, 0)
  const savedBytes = inputBytes - outputBytes

  return {
    Run: source.run,
    Summary: {
      'Images processed':
        source.successes.length + source.failures.length + source.skippedImages.length,
      Succeeded: source.successes.length,
      Failed: source.failures.length,
      Skipped: source.skippedImages.length,
      'Input size': formatReportSize(inputBytes),
      'Output size': formatReportSize(outputBytes),
      Saved: formatSaved(inputBytes, savedBytes),
      'Exact bytes': {
        Input: inputBytes,
        Output: outputBytes,
        Saved: savedBytes,
      },
    },
    Settings: {
      Quality: source.settings.quality,
      Format: source.settings.format,
      Dimension: source.settings.dimension,
    },
    Failed: source.failures.map((failure) => ({
      file: reportPath(failure.file),
      reason: failure.reason,
    })),
    Skipped: source.skippedImages.map((skipped) => ({
      file: reportPath(skipped.file),
      reason: formatSkippedReason(skipped.reason),
    })),
    Notes: source.successes.flatMap((success) => {
      if (success.caveats.length === 0) {
        return []
      }

      return [
        {
          file: reportPath(success.file),
          note: success.caveats.map(formatCaveat).join('; '),
        },
      ]
    }),
  }
}

function scalar(value: string | number): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

function issueLines(issue: ReportIssueModel): string[] {
  return [`  - file: ${scalar(issue.file)}`, `    reason: ${scalar(issue.reason)}`]
}

function noteLines(note: ReportNoteModel): string[] {
  return [`  - file: ${scalar(note.file)}`, `    note: ${scalar(note.note)}`]
}

function listSection<T>(
  name: 'Failed' | 'Skipped' | 'Notes',
  entries: T[],
  linesFor: (entry: T) => string[],
): string[] {
  return entries.length === 0
    ? [`${name}: []`]
    : [`${name}:`, ...entries.flatMap((entry) => linesFor(entry))]
}

/** Serialises a report model as locale-independent YAML with a visible comment title. */
export function serializeReport(report: ReportModel): string {
  return [
    '# Mass Image Compressor',
    `Run: ${scalar(report.Run)}`,
    '',
    'Summary:',
    `  Images processed: ${report.Summary['Images processed']}`,
    `  Succeeded: ${report.Summary.Succeeded}`,
    `  Failed: ${report.Summary.Failed}`,
    `  Skipped: ${report.Summary.Skipped}`,
    `  Input size: ${scalar(report.Summary['Input size'])}`,
    `  Output size: ${scalar(report.Summary['Output size'])}`,
    `  Saved: ${scalar(report.Summary.Saved)}`,
    '  Exact bytes:',
    `    Input: ${report.Summary['Exact bytes'].Input}`,
    `    Output: ${report.Summary['Exact bytes'].Output}`,
    `    Saved: ${report.Summary['Exact bytes'].Saved}`,
    '',
    'Settings:',
    `  Quality: ${scalar(report.Settings.Quality)}`,
    `  Format: ${scalar(report.Settings.Format)}`,
    `  Dimension: ${scalar(report.Settings.Dimension)}`,
    '',
    ...listSection('Failed', report.Failed, issueLines),
    '',
    ...listSection('Skipped', report.Skipped, issueLines),
    '',
    ...listSection('Notes', report.Notes, noteLines),
    '',
  ].join('\n')
}
