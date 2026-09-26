import { describe, expect, it } from 'vitest'
import {
  SIZE_SEARCH_MAX_ITERATIONS,
  SizeTargetError,
  nextSizeProbe,
  runSizeSearch,
  sizeSearchBand,
  sizeSearchOutcome,
  sizeTargetCaveats,
  type SizeCandidate,
  type SizeProbe,
} from './size-plan'
import type { Caveat } from '@/domain/types'

const WHOLE_SLIDER = { low: 10, high: 100 }

/** A probe list, written as pairs so the tests read as the tables they are. */
function probes(...pairs: [slider: number, bytes: number][]): SizeProbe[] {
  return pairs.map(([slider, bytes]) => ({ slider, bytes }))
}

/**
 * Walks a whole search over a size model, returning the sliders probed in order.
 *
 * The model is "what would this image weigh at that slider position", which is the only thing the
 * search ever learns about the encoder.
 */
function walk(
  targetBytes: number,
  size: (slider: number) => number,
  band = WHOLE_SLIDER,
  maxIterations: number = SIZE_SEARCH_MAX_ITERATIONS,
): number[] {
  const taken: SizeProbe[] = []

  for (;;) {
    const slider = nextSizeProbe(targetBytes, band, taken, maxIterations)

    if (slider === null) {
      return taken.map((probe) => probe.slider)
    }

    taken.push({ slider, bytes: size(slider) })
  }
}

/** A smooth, monotone size curve: bigger at higher quality, as JPEG, WebP and AVIF measure. */
function smoothCurve(slider: number): number {
  return Math.round(1000 * Math.exp(slider / 22))
}

function candidate(bytes: number, caveats: Caveat[] = []): SizeCandidate {
  return { bytes: new Uint8Array(bytes), caveats }
}

describe('sizeSearchBand', () => {
  it('offers the whole slider for every still format', () => {
    for (const format of ['jpeg', 'png', 'webp', 'avif', 'gif'] as const) {
      expect(sizeSearchBand(format, false), format).toEqual({ low: 10, high: 100 })
    }
  })

  it('offers the whole slider for the animated formats that have a quality axis', () => {
    expect(sizeSearchBand('webp', true)).toEqual({ low: 10, high: 100 })
    expect(sizeSearchBand('gif', true)).toEqual({ low: 10, high: 100 })
  })

  // R-Q15: an animated PNG is lossless at every slider position, so every probe returns the same
  // file. A one-position band turns that from eight wasted encodes into one.
  it('gives animated PNG a single position, because R-Q15 leaves it no axis', () => {
    expect(sizeSearchBand('png', true)).toEqual({ low: 100, high: 100 })
  })
})

describe('nextSizeProbe', () => {
  it('probes the bottom of the band first', () => {
    expect(nextSizeProbe(10_000, WHOLE_SLIDER, [])).toBe(10)
  })

  // R-Q3: the smallest file the format can produce is already over the target. Nothing above it can
  // be smaller, so the search is over after one encode rather than after eight.
  it('stops after one probe when the lowest quality already misses the target', () => {
    expect(walk(5_000, () => 9_000)).toEqual([10])
  })

  it('stops after two probes when the highest quality already fits', () => {
    // R-Q2's other half: the target is a ceiling, not a goal, so a generous one is answered by the
    // best quality the slider offers rather than by climbing towards the target.
    expect(walk(200_000, smoothCurve)).toEqual([10, 100])
  })

  // T28 measured `--lossy` to be completely inert on flat animations, and §7.4 records the same
  // shape for PNG's `minimum`. Probing both ends catches it without a test for it: an axis that
  // does nothing returns the same bytes at the top as at the bottom, so the top fits whenever the
  // bottom did, and the search ends there.
  it('spends two probes, not eight, on an axis that does nothing', () => {
    expect(walk(2_000, () => 1_043)).toEqual([10, 100])
  })

  it('spends one probe on an inert axis whose single size misses the target', () => {
    expect(walk(500, () => 1_043)).toEqual([10])
  })

  it('spends one probe on a single-position band', () => {
    expect(walk(50_000, () => 1_000, { low: 100, high: 100 })).toEqual([100])
  })

  // §7.4's PNG axis: below the lossless point every position that can be quantized returns the
  // identical file, so the axis has two outcomes rather than a size curve. The third probe lands on
  // the plateau, ties with the first, and the search stops there rather than spending five more
  // encodes moving a boundary the user never sees.
  it('stops on a two-valued axis as soon as a probe ties with the best fit', () => {
    const twoValued = (slider: number) => (slider < 85 ? 20_000 : 90_000)

    expect(walk(50_000, twoValued)).toEqual([10, 100, 55])
  })

  it('does not stop on a tie between two probes that both miss', () => {
    // The miss side being a plateau says nothing about whether a better fit exists below it.
    const taken = probes([10, 1_000], [100, 90_000], [55, 90_000])

    expect(nextSizeProbe(20_000, WHOLE_SLIDER, taken)).toBe(32)
  })

  it('bisects the interior once both ends are known', () => {
    // 10 fits, 100 misses, so the next probe is the midpoint of the two.
    expect(nextSizeProbe(20_000, WHOLE_SLIDER, probes([10, 1_000], [100, 90_000]))).toBe(55)
    // 55 also fits, so the interval is (55, 100).
    expect(
      nextSizeProbe(20_000, WHOLE_SLIDER, probes([10, 1_000], [100, 90_000], [55, 5_000])),
    ).toBe(77)
  })

  it('stops when the interval has closed', () => {
    expect(
      nextSizeProbe(20_000, WHOLE_SLIDER, probes([10, 1_000], [41, 90_000], [40, 5_000])),
    ).toBe(null)
  })

  it('never exceeds the cap', () => {
    // A curve whose boundary needs the whole budget; the walk still stops at eight.
    expect(walk(smoothCurve(37), smoothCurve).length).toBe(SIZE_SEARCH_MAX_ITERATIONS)
  })

  it('honours a lower cap', () => {
    expect(walk(smoothCurve(37), smoothCurve, WHOLE_SLIDER, 3)).toEqual([10, 100, 55])
  })

  // The measured PNG and GIF axes are both non-monotone in places (T27's `target` sweep, T28's
  // `--lossy` band below 20), so the search must not bisect an interval whose ends contradict each
  // other. It stops instead, and the outcome is read off the probes.
  it('stops rather than bisecting when a higher probe fits than one that missed', () => {
    const taken = probes([10, 1_000], [100, 90_000], [55, 30_000], [77, 15_000])

    expect(nextSizeProbe(20_000, WHOLE_SLIDER, taken)).toBe(null)
    expect(sizeSearchOutcome(20_000, taken)).toEqual({ kind: 'fit', slider: 77, bytes: 15_000 })
  })

  it('refuses a target that is not a positive number of bytes', () => {
    expect(() => nextSizeProbe(0, WHOLE_SLIDER, [])).toThrow(SizeTargetError)
    expect(() => nextSizeProbe(-1, WHOLE_SLIDER, [])).toThrow(SizeTargetError)
    expect(() => nextSizeProbe(Number.NaN, WHOLE_SLIDER, [])).toThrow(SizeTargetError)
    expect(() => nextSizeProbe(Number.POSITIVE_INFINITY, WHOLE_SLIDER, [])).toThrow(SizeTargetError)
  })

  it('refuses an empty band', () => {
    expect(() => nextSizeProbe(1_000, { low: 100, high: 10 }, [])).toThrow(SizeTargetError)
  })

  // §7.5's cap is eight, and the claim in `SIZE_SEARCH_MAX_ITERATIONS` is that eight is enough to
  // land on the best position or one below it. Checked over every answer the band can have rather
  // than at a few points.
  it('lands on the best fitting position or one below it, for all 91 possible answers', () => {
    const gaps = new Set<number>()

    for (let boundary = 10; boundary <= 100; boundary += 1) {
      const target = smoothCurve(boundary)
      const taken = walk(target, smoothCurve).map((slider) => ({
        slider,
        bytes: smoothCurve(slider),
      }))
      const outcome = sizeSearchOutcome(target, taken)

      expect(outcome.kind, `slider ${boundary}`).toBe('fit')
      expect(taken.length, `slider ${boundary}`).toBeLessThanOrEqual(SIZE_SEARCH_MAX_ITERATIONS)
      gaps.add(boundary - outcome.slider)
    }

    expect([...gaps].sort()).toEqual([0, 1])
  })
})

describe('sizeSearchOutcome', () => {
  it('keeps the highest-quality probe that fits', () => {
    expect(sizeSearchOutcome(20_000, probes([10, 1_000], [55, 5_000], [77, 19_000]))).toEqual({
      kind: 'fit',
      slider: 77,
      bytes: 19_000,
    })
  })

  it('treats a file exactly on the target as fitting', () => {
    expect(sizeSearchOutcome(5_000, probes([10, 5_000]))).toEqual({
      kind: 'fit',
      slider: 10,
      bytes: 5_000,
    })
  })

  // R-Q3: the image is not failed and the target is not pretended to have been met.
  it('keeps the smallest achieved file when nothing fits', () => {
    expect(sizeSearchOutcome(1_000, probes([10, 9_000], [100, 20_000]))).toEqual({
      kind: 'unreachable',
      slider: 10,
      bytes: 9_000,
    })
  })

  it('keeps the higher quality of two equally sized misses', () => {
    expect(sizeSearchOutcome(1_000, probes([10, 9_000], [100, 9_000]))).toEqual({
      kind: 'unreachable',
      slider: 100,
      bytes: 9_000,
    })
  })

  it('refuses to answer before anything has been encoded', () => {
    expect(() => sizeSearchOutcome(1_000, [])).toThrow(SizeTargetError)
  })
})

describe('sizeTargetCaveats', () => {
  it('records nothing when the target was reached', () => {
    expect(sizeTargetCaveats(20_000, { kind: 'fit', slider: 55, bytes: 19_000 })).toEqual([])
  })

  // R-X46's row states the target and what was achieved.
  it('states both numbers when the target was not reached', () => {
    expect(sizeTargetCaveats(1_000, { kind: 'unreachable', slider: 10, bytes: 9_000 })).toEqual([
      { kind: 'size-target-not-reached', targetBytes: 1_000, achievedBytes: 9_000 },
    ])
  })
})

describe('runSizeSearch', () => {
  it('returns the highest-quality file that fits, and counts its probes', async () => {
    const asked: number[] = []
    const result = await runSizeSearch(
      { targetBytes: smoothCurve(60), band: WHOLE_SLIDER },
      async (slider) => {
        asked.push(slider)
        return candidate(smoothCurve(slider))
      },
    )

    expect(asked).toEqual([10, 100, 55, 77, 66, 60, 63, 61])
    expect(result.probes.length).toBe(8)
    expect(result.reachedTarget).toBe(true)
    expect(result.slider).toBe(60)
    expect(result.bytes.byteLength).toBe(smoothCurve(60))
    expect(result.caveats).toEqual([])
  })

  it('carries the kept candidate’s own caveats', async () => {
    const quantized: Caveat = { kind: 'png-quantized' }
    const result = await runSizeSearch(
      { targetBytes: 50_000, band: WHOLE_SLIDER },
      async (slider) => (slider > 55 ? candidate(90_000) : candidate(20_000, [quantized])),
    )

    expect(result.slider).toBe(55)
    expect(result.caveats).toEqual([quantized])
  })

  // R-Q3, end to end: the smallest achieved result is kept, the image is not failed, and the caveat
  // carries both numbers.
  it('keeps the smallest achieved file and records R-Q3’s caveat when the target is out of reach', async () => {
    const asked: number[] = []
    const result = await runSizeSearch(
      { targetBytes: 1_000, band: WHOLE_SLIDER },
      async (slider) => {
        asked.push(slider)
        return candidate(smoothCurve(slider))
      },
    )

    expect(asked).toEqual([10])
    expect(result.reachedTarget).toBe(false)
    expect(result.bytes.byteLength).toBe(smoothCurve(10))
    expect(result.caveats).toEqual([
      { kind: 'size-target-not-reached', targetBytes: 1_000, achievedBytes: smoothCurve(10) },
    ])
  })

  it('runs one encode for a single-position band', async () => {
    const asked: number[] = []
    const result = await runSizeSearch(
      { targetBytes: 50_000, band: sizeSearchBand('png', true) },
      async (slider) => {
        asked.push(slider)
        return candidate(4_000)
      },
    )

    expect(asked).toEqual([100])
    expect(result.slider).toBe(100)
    expect(result.reachedTarget).toBe(true)
  })

  // The memory note in `runSizeSearch`: the result refers to one candidate, the answer's, and holds
  // it without copying. On a large GIF each candidate is about 10 MB (T28), so which of the eight a
  // caller can still reach through the result is the whole of that claim.
  it('returns the winning candidate itself, and refers to no other', async () => {
    const produced = new Map<number, Uint8Array>()
    const result = await runSizeSearch(
      { targetBytes: smoothCurve(60), band: WHOLE_SLIDER },
      async (slider) => {
        const bytes = new Uint8Array(smoothCurve(slider))

        produced.set(slider, bytes)

        return { bytes, caveats: [] }
      },
    )

    expect(produced.size).toBe(8)
    expect(result.bytes).toBe(produced.get(result.slider))
    // `probes` carries sizes, not buffers, so nothing else in the result reaches a candidate.
    expect(result.probes.every((probe) => typeof probe.bytes === 'number')).toBe(true)
  })
})
