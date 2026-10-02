import { describe, expect, it } from 'vitest'
import {
  DIMENSION_RECOVERY_MAX_PROBES,
  DIMENSION_RECOVERY_MIN_SLIDER,
  dimensionsForLongEdge,
  searchSmallerDimensions,
} from './dimension-recovery-plan'

it('requires dimension suggestions to fit at quality 30 or better', () => {
  expect(DIMENSION_RECOVERY_MIN_SLIDER).toBe(30)
})

describe('dimensionsForLongEdge', () => {
  it('preserves aspect ratio for landscape and portrait inputs', () => {
    expect(dimensionsForLongEdge({ width: 4000, height: 3000 }, 2000)).toEqual({
      width: 2000,
      height: 1500,
    })
    expect(dimensionsForLongEdge({ width: 3000, height: 4000 }, 1000)).toEqual({
      width: 750,
      height: 1000,
    })
  })
})

describe('searchSmallerDimensions', () => {
  it('seeds the first probe from the square-root area estimate', async () => {
    const asked: number[] = []

    await searchSmallerDimensions(
      {
        current: { width: 4000, height: 3000 },
        targetBytes: 250_000,
        achievedBytes: 1_000_000,
      },
      async (size) => {
        asked.push(Math.max(size.width, size.height))
        return 250_000
      },
    )

    expect(asked[0]).toBe(2000)
  })

  it('never exceeds the additional-probe budget', async () => {
    const asked: number[] = []

    await searchSmallerDimensions(
      {
        current: { width: 4096, height: 3072 },
        targetBytes: 10_000,
        achievedBytes: 1_000_000,
      },
      async (size) => {
        asked.push(Math.max(size.width, size.height))
        return size.width * size.height
      },
    )

    expect(asked.length).toBeLessThanOrEqual(DIMENSION_RECOVERY_MAX_PROBES)
  })

  it('uses the reserved one-pixel probe and returns no suggestion when even it misses', async () => {
    const asked: number[] = []
    const fit = await searchSmallerDimensions(
      {
        current: { width: 4000, height: 3000 },
        targetBytes: 1,
        achievedBytes: 1_000_000,
      },
      async (size) => {
        asked.push(Math.max(size.width, size.height))
        return 2
      },
    )

    expect(asked.at(-1)).toBe(1)
    expect(fit).toBeNull()
  })

  it('returns the largest dimension actually measured to fit despite non-monotonic bytes', async () => {
    const measured = new Map<number, number>([
      [2000, 900],
      [3000, 1100],
      [2500, 800],
      [2750, 1200],
      [2625, 700],
    ])
    const fit = await searchSmallerDimensions(
      {
        current: { width: 4000, height: 3000 },
        targetBytes: 1000,
        achievedBytes: 4000,
        maxProbes: 5,
      },
      async (size) => measured.get(Math.max(size.width, size.height)) ?? 5000,
    )

    expect(fit).toMatchObject({ width: 2625, bytes: 700 })
    expect(fit?.probes.every((probe) => measured.has(probe.edge))).toBe(true)
  })

  it('rejects invalid targets and dimensions', async () => {
    await expect(
      searchSmallerDimensions(
        { current: { width: 0, height: 1 }, targetBytes: 1, achievedBytes: 2 },
        async () => 1,
      ),
    ).rejects.toThrow(RangeError)
    await expect(
      searchSmallerDimensions(
        { current: { width: 1, height: 1 }, targetBytes: 0, achievedBytes: 2 },
        async () => 1,
      ),
    ).rejects.toThrow(RangeError)
  })
})
