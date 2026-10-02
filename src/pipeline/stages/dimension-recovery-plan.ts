// Pure planning for T36-A's verified smaller-dimension suggestion. Encoders are injected so the
// search is unit-testable without loading WASM. Only an actually measured fit can be returned;
// monotonic encoded size makes the probes efficient, but is never trusted for correctness.

import type { PixelSize } from '@/domain/edit'

export const DIMENSION_RECOVERY_MAX_PROBES = 8
/** A recovery suggestion must fit without dropping below this user-visible quality position. */
export const DIMENSION_RECOVERY_MIN_SLIDER = 30

export interface DimensionProbe extends PixelSize {
  edge: number
  bytes: number
}

export interface DimensionRecoveryFit extends PixelSize {
  bytes: number
  probes: DimensionProbe[]
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive whole number, got ${value}`)
  }
}

/** Aspect-preserving dimensions whose long edge is exactly `edge`. */
export function dimensionsForLongEdge(current: PixelSize, edge: number): PixelSize {
  assertPositiveInteger(current.width, 'width')
  assertPositiveInteger(current.height, 'height')
  assertPositiveInteger(edge, 'edge')

  const long = Math.max(current.width, current.height)
  const scale = edge / long

  return current.width >= current.height
    ? { width: edge, height: Math.max(1, Math.round(current.height * scale)) }
    : { width: Math.max(1, Math.round(current.width * scale)), height: edge }
}

function largestFit(targetBytes: number, probes: readonly DimensionProbe[]): DimensionProbe | null {
  return probes.reduce<DimensionProbe | null>(
    (best, probe) =>
      probe.bytes <= targetBytes && (best === null || probe.edge > best.edge) ? probe : best,
    null,
  )
}

function nextEdge(
  targetBytes: number,
  currentEdge: number,
  currentBytes: number,
  probes: readonly DimensionProbe[],
  finalAttempt: boolean,
): number | null {
  const fit = largestFit(targetBytes, probes)
  const tried = new Set(probes.map((probe) => probe.edge))

  if (fit === null) {
    if (finalAttempt && !tried.has(1)) {
      return 1
    }

    const misses = [
      { edge: currentEdge, bytes: currentBytes },
      ...probes.filter((probe) => probe.bytes > targetBytes),
    ].sort((a, b) => a.edge - b.edge)
    const smallestMiss = misses[0]!
    const estimate = Math.max(
      1,
      Math.min(
        smallestMiss.edge - 1,
        Math.floor(smallestMiss.edge * Math.sqrt(targetBytes / smallestMiss.bytes)),
      ),
    )

    if (!tried.has(estimate) && estimate < currentEdge) {
      return estimate
    }

    return tried.has(1) ? null : 1
  }

  const higherMiss = [
    { edge: currentEdge, bytes: currentBytes },
    ...probes.filter((probe) => probe.bytes > targetBytes),
  ]
    .filter((probe) => probe.edge > fit.edge)
    .sort((a, b) => a.edge - b.edge)[0]

  if (higherMiss === undefined || higherMiss.edge - fit.edge <= 1) {
    return null
  }

  const midpoint = Math.floor((fit.edge + higherMiss.edge) / 2)

  return tried.has(midpoint) ? null : midpoint
}

export async function searchSmallerDimensions(
  options: {
    current: PixelSize
    targetBytes: number
    achievedBytes: number
    maxProbes?: number
  },
  encode: (size: PixelSize) => Promise<number>,
): Promise<DimensionRecoveryFit | null> {
  const { current, targetBytes, achievedBytes, maxProbes = DIMENSION_RECOVERY_MAX_PROBES } = options
  assertPositiveInteger(current.width, 'width')
  assertPositiveInteger(current.height, 'height')
  assertPositiveInteger(targetBytes, 'targetBytes')
  assertPositiveInteger(achievedBytes, 'achievedBytes')
  assertPositiveInteger(maxProbes, 'maxProbes')

  if (maxProbes > DIMENSION_RECOVERY_MAX_PROBES) {
    throw new RangeError(
      `maxProbes cannot exceed ${DIMENSION_RECOVERY_MAX_PROBES}, got ${maxProbes}`,
    )
  }

  const currentEdge = Math.max(current.width, current.height)
  const probes: DimensionProbe[] = []

  for (let attempt = 0; attempt < maxProbes; attempt += 1) {
    const edge = nextEdge(
      targetBytes,
      currentEdge,
      achievedBytes,
      probes,
      attempt === maxProbes - 1,
    )

    if (edge === null || edge >= currentEdge) {
      break
    }

    const size = dimensionsForLongEdge(current, edge)
    const bytes = await encode(size)
    probes.push({ ...size, edge, bytes })

    if (edge === 1 && bytes > targetBytes) {
      break
    }
  }

  const fit = largestFit(targetBytes, probes)

  return fit === null ? null : { width: fit.width, height: fit.height, bytes: fit.bytes, probes }
}
