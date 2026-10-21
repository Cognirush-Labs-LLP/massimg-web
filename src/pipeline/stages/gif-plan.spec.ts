import { describe, expect, it } from 'vitest'
import { resolveSettings } from '@/domain/job'
import type { BatchSettings, SettingsImage } from '@/domain/job'
import type { QualitySettings } from './encode-plan'
import {
  GIFSICLE_INPUT_NAME,
  GIFSICLE_OUTPUT_PATH,
  GIF_LOSSY_AT_SLIDER_10,
  GIF_LOSSY_AT_SLIDER_95,
  GIF_OPTIMIZE_LEVEL,
  GIF_TICKS_PER_SECOND,
  GifPlanError,
  gifDelayCentiseconds,
  gifFrameDelays,
  gifLossyLevel,
  gifsicleCommand,
} from './gif-plan'

// The slider mapping is `domain/job.ts`'s. These tests drive the real `resolveSettings` rather than
// building a `QualitySettings` by hand, so that a change to where the lossless band starts is caught
// here instead of being mirrored into agreement — the same arrangement png-plan.spec.ts uses.
const IMAGE: SettingsImage = { sourceFormat: 'gif', isAnimated: true, edit: null }
const BATCH: BatchSettings = {
  quality: { kind: 'quality', value: 80 },
  dimension: { kind: 'original' },
  format: 'gif',
  animatedAsWebp: true,
}

function gifQuality(slider: number): QualitySettings {
  const resolution = resolveSettings(IMAGE, {
    ...BATCH,
    quality: { kind: 'quality', value: slider },
  })

  if (resolution.kind !== 'resolved' || resolution.settings.quality.kind !== 'quality') {
    throw new Error(`slider ${slider} did not resolve to a quality setting`)
  }

  return resolution.settings.quality
}

describe('gifDelayCentiseconds', () => {
  it('converts whole centiseconds exactly', () => {
    expect(gifDelayCentiseconds(0)).toBe(0)
    expect(gifDelayCentiseconds(10)).toBe(1)
    expect(gifDelayCentiseconds(40)).toBe(4)
    expect(gifDelayCentiseconds(120)).toBe(12)
    expect(gifDelayCentiseconds(655350)).toBe(65535)
  })

  it('rounds to the nearest centisecond', () => {
    expect(gifDelayCentiseconds(45)).toBe(5)
    expect(gifDelayCentiseconds(44)).toBe(4)
    expect(gifDelayCentiseconds(33)).toBe(3)
    expect(gifDelayCentiseconds(101)).toBe(10)
    expect(gifDelayCentiseconds(999)).toBe(100)
  })

  // The case that motivates the clamp: 0 is not "no delay" in GIF, it is "unspecified", and viewers
  // substitute something like 100 ms for it. Rounding 1 ms down would play the frame a hundred times
  // too slowly rather than ten.
  it('never turns a non-zero delay into zero', () => {
    expect(gifDelayCentiseconds(1)).toBe(1)
    expect(gifDelayCentiseconds(4)).toBe(1)
    expect(gifDelayCentiseconds(7)).toBe(1)
  })

  it('keeps an explicit zero at zero, so a GIF read and written back is unchanged', () => {
    expect(gifDelayCentiseconds(0)).toBe(0)
  })

  it('refuses a delay that is not a whole non-negative number of milliseconds', () => {
    expect(() => gifDelayCentiseconds(-1)).toThrow(GifPlanError)
    expect(() => gifDelayCentiseconds(12.5)).toThrow(GifPlanError)
    expect(() => gifDelayCentiseconds(Number.NaN)).toThrow(GifPlanError)
  })
})

describe('gifFrameDelays', () => {
  it('reports both units for the same decision', () => {
    expect(gifFrameDelays([40, 120, 40, 200, 80, 40])).toEqual({
      centiseconds: [4, 12, 4, 20, 8, 4],
      milliseconds: [40, 120, 40, 200, 80, 40],
    })
  })

  // The `anim-odd-delays.webp` set, which is the reason this conversion is ours rather than
  // ImageMagick's. The milliseconds it reports are what the written file will actually hold.
  it('reports what a set of odd delays really becomes', () => {
    expect(gifFrameDelays([45, 33, 7, 101, 999, 1])).toEqual({
      centiseconds: [5, 3, 1, 10, 100, 1],
      milliseconds: [50, 30, 10, 100, 1000, 10],
    })
  })

  it('handles an empty animation without inventing a frame', () => {
    expect(gifFrameDelays([])).toEqual({ centiseconds: [], milliseconds: [] })
  })
})

describe('gifLossyLevel', () => {
  it('asks for no lossy pass above slider 95 (R-Q5, §7.1)', () => {
    expect(gifLossyLevel(gifQuality(96))).toBeNull()
    expect(gifLossyLevel(gifQuality(100))).toBeNull()
  })

  it('takes a lossy pass at 95 and below', () => {
    expect(gifLossyLevel(gifQuality(95))).toBe(GIF_LOSSY_AT_SLIDER_95)
    expect(gifLossyLevel(gifQuality(10))).toBe(GIF_LOSSY_AT_SLIDER_10)
  })

  // Geometric, not linear: the measured size curve is logarithmic in the level, so multiplying is
  // what gives the slider an even response. See `gifLossyLevel` for the numbers.
  it('multiplies between the two measured ends', () => {
    expect(gifLossyLevel(gifQuality(85))).toBe(26)
    expect(gifLossyLevel(gifQuality(80))).toBe(30)
    expect(gifLossyLevel(gifQuality(60))).toBe(52)
    expect(gifLossyLevel(gifQuality(40))).toBe(89)
    expect(gifLossyLevel(gifQuality(20))).toBe(153)
  })

  // The midpoint of a geometric scale is its geometric mean, which is what proves the scale is not
  // secretly linear: linear would put slider 52.5 at 110, not at 63.
  it('puts the middle of the slider at the geometric middle of the range', () => {
    expect(gifLossyLevel(gifQuality(53))).toBe(62)
  })

  it('is monotonic: a lower slider never asks for a gentler pass', () => {
    let previous = 0

    for (let slider = 95; slider >= 10; slider -= 1) {
      const level = gifLossyLevel(gifQuality(slider))

      expect(level).not.toBeNull()
      expect(level as number).toBeGreaterThanOrEqual(previous)
      previous = level as number
    }
  })

  // gifsicle takes 1 to 200. Both ends of our band sit inside that, and the bottom sits above the
  // measured point where the option starts costing bytes instead of saving them.
  it('stays inside the levels that are measured to help', () => {
    for (let slider = 10; slider <= 95; slider += 1) {
      const level = gifLossyLevel(gifQuality(slider)) as number

      expect(level).toBeGreaterThanOrEqual(GIF_LOSSY_AT_SLIDER_95)
      expect(level).toBeLessThanOrEqual(GIF_LOSSY_AT_SLIDER_10)
    }
  })
})

describe('gifsicleCommand', () => {
  it('optimises at -O2 and writes into /out', () => {
    expect(gifsicleCommand(null)).toEqual([
      `-O${GIF_OPTIMIZE_LEVEL} ${GIFSICLE_INPUT_NAME} -o ${GIFSICLE_OUTPUT_PATH}`,
    ])
  })

  it('adds the lossy pass when there is one', () => {
    expect(gifsicleCommand(40)).toEqual([
      `-O${GIF_OPTIMIZE_LEVEL} --lossy=40 ${GIFSICLE_INPUT_NAME} -o ${GIFSICLE_OUTPUT_PATH}`,
    ])
  })

  // Nothing about timing or looping is passed: both are already in the file ImageMagick wrote, and a
  // second opinion here would be a second place for them to be wrong.
  it('says nothing about delays or the loop count', () => {
    const command = gifsicleCommand(150).join(' ')

    expect(command).not.toContain('--loopcount')
    expect(command).not.toContain('-d')
  })
})

describe('the settings this path pins', () => {
  it('uses -O2, not -O3 (§7.3)', () => {
    expect(GIF_OPTIMIZE_LEVEL).toBe(2)
  })

  // 100 ticks per second means `animationDelay` is centiseconds, which is what the file stores, so
  // the rounding above is the only rounding that happens.
  it('hands ImageMagick delays in the unit the container uses', () => {
    expect(GIF_TICKS_PER_SECOND).toBe(100)
  })
})
