import { describe, expect, it } from 'vitest'
import {
  AnimationShapeError,
  CICP_UNSPECIFIED,
  assertUniformAnimation,
  classifySourceOrientation,
  isMirroredOrientation,
  isUnspecifiedCicp,
  ownsWholeBuffer,
  sameFrameColour,
  singleFrameAnimation,
} from './frame'
import type { Animation, Frame, OrientationValue } from './frame'

const ALL_ORIENTATIONS: OrientationValue[] = [1, 2, 3, 4, 5, 6, 7, 8]

describe('classifySourceOrientation', () => {
  // The distinction the whole module exists for: a file with no tag, a file whose tag says
  // "upright", and a file whose tag asks for a transform are three different states. Collapsing the
  // first two is how "no orientation" quietly becomes "orientation 1" and back again.
  it('reads ImageMagick Orientation.Undefined (0) as absent, not as upright', () => {
    expect(classifySourceOrientation(0)).toEqual({ kind: 'absent' })
  })

  it('reads a tag that says upright as present, not as absent', () => {
    expect(classifySourceOrientation(1)).toEqual({ kind: 'present', value: 1 })
  })

  it('reads all eight values as present', () => {
    for (const value of ALL_ORIENTATIONS) {
      expect(classifySourceOrientation(value)).toEqual({ kind: 'present', value })
    }
  })

  it('treats a value no conforming file can carry as absent rather than trusting it', () => {
    for (const value of [-1, 9, 255, 1.5, Number.NaN]) {
      expect(classifySourceOrientation(value)).toEqual({ kind: 'absent' })
    }
  })
})

describe('isMirroredOrientation', () => {
  // A transform that is right for the four rotations can be wrong for all four flips, and the
  // mirrored cases are invisible in the output dimensions — 2 and 4 keep the source's dimensions
  // exactly as 1 and 3 do, and 5 and 7 swap them exactly as 6 and 8 do.
  it('names exactly 2, 4, 5 and 7', () => {
    expect(ALL_ORIENTATIONS.filter(isMirroredOrientation)).toEqual([2, 4, 5, 7])
  })

  it('pairs each mirrored value with a rotation of identical dimensions', () => {
    const swapsAxes = (value: OrientationValue): boolean => value >= 5
    for (const mirrored of [2, 4, 5, 7] as OrientationValue[]) {
      const rotation = ALL_ORIENTATIONS.find(
        (other) => !isMirroredOrientation(other) && swapsAxes(other) === swapsAxes(mirrored),
      )
      expect(rotation).toBeDefined()
    }
  })
})

describe('isUnspecifiedCicp', () => {
  const unspecified = {
    primaries: CICP_UNSPECIFIED,
    transfer: CICP_UNSPECIFIED,
    matrix: CICP_UNSPECIFIED,
    fullRange: true,
  }

  it('is true only when all three code points say unspecified', () => {
    expect(isUnspecifiedCicp(unspecified)).toBe(true)
  })

  it('is false when any one of them says something', () => {
    expect(isUnspecifiedCicp({ ...unspecified, primaries: 12 })).toBe(false)
    expect(isUnspecifiedCicp({ ...unspecified, transfer: 13 })).toBe(false)
    expect(isUnspecifiedCicp({ ...unspecified, matrix: 6 })).toBe(false)
  })

  it('does not treat the range flag as information', () => {
    expect(isUnspecifiedCicp({ ...unspecified, fullRange: false })).toBe(true)
  })
})

describe('ownsWholeBuffer', () => {
  // The guard behind T21's transfer-list hazard: transferring the `.buffer` of a view onto a codec
  // heap detaches the whole heap, not just the output.
  it('accepts a freshly allocated array', () => {
    expect(ownsWholeBuffer(new Uint8Array(16))).toBe(true)
  })

  it('rejects a window onto a larger buffer', () => {
    const heap = new Uint8Array(64)
    expect(ownsWholeBuffer(heap.subarray(0, 16))).toBe(false)
    expect(ownsWholeBuffer(heap.subarray(8, 24))).toBe(false)
  })

  it('accepts a copy taken out of a larger buffer', () => {
    const heap = new Uint8Array(64)
    expect(ownsWholeBuffer(heap.slice(8, 24))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// The animation representation (T29).
// ---------------------------------------------------------------------------------------------

function frame(overrides: Partial<Frame> = {}): Frame {
  const width = overrides.width ?? 4
  const height = overrides.height ?? 3

  return {
    width,
    height,
    pixels: new Uint8Array(width * height * 4),
    colour: { kind: 'untagged' },
    sourceOrientation: { kind: 'absent' },
    ...overrides,
  }
}

function animation(overrides: Partial<Animation> = {}): Animation {
  return {
    frames: [frame(), frame(), frame()],
    delaysMs: [40, 120, 40],
    loops: 3,
    ...overrides,
  }
}

describe('sameFrameColour', () => {
  const profile = new Uint8Array([1, 2, 3, 4])

  it('matches two untagged frames', () => {
    expect(sameFrameColour({ kind: 'untagged' }, { kind: 'untagged' })).toBe(true)
  })

  it('never matches across kinds', () => {
    expect(sameFrameColour({ kind: 'untagged' }, { kind: 'icc', profile, description: null })).toBe(
      false,
    )
  })

  // Structural, not by identity: the stages spread frames, so identity would hold by accident.
  it('matches equal profiles held in different buffers', () => {
    expect(
      sameFrameColour(
        { kind: 'icc', profile, description: 'P3' },
        { kind: 'icc', profile: new Uint8Array([1, 2, 3, 4]), description: 'P3' },
      ),
    ).toBe(true)
  })

  it('distinguishes profiles that differ in one byte, in length or in description', () => {
    expect(
      sameFrameColour(
        { kind: 'icc', profile, description: 'P3' },
        { kind: 'icc', profile: new Uint8Array([1, 2, 3, 5]), description: 'P3' },
      ),
    ).toBe(false)
    expect(
      sameFrameColour(
        { kind: 'icc', profile, description: 'P3' },
        { kind: 'icc', profile: new Uint8Array([1, 2, 3]), description: 'P3' },
      ),
    ).toBe(false)
    expect(
      sameFrameColour(
        { kind: 'icc', profile, description: 'P3' },
        { kind: 'icc', profile, description: 'sRGB' },
      ),
    ).toBe(false)
  })

  it('compares every CICP field, the range flag included', () => {
    const cicp = { primaries: 12, transfer: 13, matrix: 6, fullRange: true }

    expect(sameFrameColour({ kind: 'cicp', cicp }, { kind: 'cicp', cicp: { ...cicp } })).toBe(true)
    expect(
      sameFrameColour({ kind: 'cicp', cicp }, { kind: 'cicp', cicp: { ...cicp, matrix: 1 } }),
    ).toBe(false)
    expect(
      sameFrameColour(
        { kind: 'cicp', cicp },
        { kind: 'cicp', cicp: { ...cicp, fullRange: false } },
      ),
    ).toBe(false)
  })
})

describe('assertUniformAnimation', () => {
  it('accepts a well-formed animation', () => {
    expect(() => assertUniformAnimation(animation())).not.toThrow()
  })

  it('accepts a single-frame animation', () => {
    expect(() =>
      assertUniformAnimation({ frames: [frame()], delaysMs: [40], loops: 0 }),
    ).not.toThrow()
  })

  it('rejects an animation with no frames', () => {
    expect(() => assertUniformAnimation({ frames: [], delaysMs: [], loops: 0 })).toThrow(
      AnimationShapeError,
    )
  })

  it('rejects a frame count that disagrees with the delay count', () => {
    expect(() => assertUniformAnimation(animation({ delaysMs: [40, 120] }))).toThrow(
      /3 frames and 2 delays/,
    )
  })

  // The fault this function exists for: one frame out of many left at the wrong size by a stage
  // that mapped over the others correctly.
  it('rejects one frame of a different size', () => {
    const frames = [frame(), frame({ width: 8 }), frame()]

    expect(() => assertUniformAnimation(animation({ frames }))).toThrow(/frame 1 is 8x3/)
  })

  it('rejects a frame whose pixel count does not match its dimensions', () => {
    const frames = [frame(), { ...frame(), pixels: new Uint8Array(4) }, frame()]

    expect(() => assertUniformAnimation(animation({ frames }))).toThrow(/frame 1 holds 4 bytes/)
  })

  it('rejects a frame that is a window onto a larger buffer', () => {
    const heap = new Uint8Array(1024)
    const frames = [frame(), { ...frame(), pixels: heap.subarray(0, 48) }, frame()]

    expect(() => assertUniformAnimation(animation({ frames }))).toThrow(/does not own its buffer/)
  })

  it('rejects frames that describe their colour differently', () => {
    const tagged = frame({
      colour: { kind: 'icc', profile: new Uint8Array([9]), description: null },
    })

    expect(() => assertUniformAnimation(animation({ frames: [frame(), tagged, frame()] }))).toThrow(
      /frame 1 describes its colour as icc/,
    )
  })

  it('rejects frames that report different source orientations', () => {
    const oriented = frame({ sourceOrientation: { kind: 'present', value: 6 } })

    expect(() =>
      assertUniformAnimation(animation({ frames: [frame(), oriented, frame()] })),
    ).toThrow(/different source orientation/)
  })

  it('accepts frames that agree on a present orientation', () => {
    const frames = [1, 2, 3].map(() => frame({ sourceOrientation: { kind: 'present', value: 6 } }))

    expect(() => assertUniformAnimation(animation({ frames }))).not.toThrow()
  })

  it('rejects a negative or fractional loop count', () => {
    expect(() => assertUniformAnimation(animation({ loops: -1 }))).toThrow(/loop count/)
    expect(() => assertUniformAnimation(animation({ loops: 1.5 }))).toThrow(/loop count/)
  })

  // Zero is infinite, not missing, and must be accepted.
  it('accepts a loop count of zero', () => {
    expect(() => assertUniformAnimation(animation({ loops: 0 }))).not.toThrow()
  })

  it('rejects a negative or non-finite delay', () => {
    expect(() => assertUniformAnimation(animation({ delaysMs: [40, -1, 40] }))).toThrow(
      /frame 1 has a delay/,
    )
    expect(() => assertUniformAnimation(animation({ delaysMs: [40, Number.NaN, 40] }))).toThrow(
      /frame 1 has a delay/,
    )
  })

  // A zero delay is what a GIF frame with no Graphic Control Extension really says.
  it('accepts a zero delay', () => {
    expect(() => assertUniformAnimation(animation({ delaysMs: [0, 0, 0] }))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
// The still-to-animation adapter the GIF path uses (T28).
// ---------------------------------------------------------------------------------------------

describe('singleFrameAnimation', () => {
  it('wraps one frame without copying its pixels', () => {
    const only = frame()
    const wrapped = singleFrameAnimation(only)

    expect(wrapped.frames).toHaveLength(1)
    expect(wrapped.frames[0]).toBe(only)
  })

  // `loops: 1` is what makes ImageMagick write no NETSCAPE2.0 block at all (measured, T28), which is
  // what a still GIF should carry — and `delaysMs: [0]` is the same statement about duration.
  it('says played once, with no duration', () => {
    expect(singleFrameAnimation(frame())).toMatchObject({ delaysMs: [0], loops: 1 })
  })

  it('produces an animation that holds together', () => {
    expect(() => assertUniformAnimation(singleFrameAnimation(frame()))).not.toThrow()
  })
})
