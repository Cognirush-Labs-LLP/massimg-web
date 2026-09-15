import { describe, expect, it } from 'vitest'
import {
  CICP_UNSPECIFIED,
  classifySourceOrientation,
  isMirroredOrientation,
  isUnspecifiedCicp,
  ownsWholeBuffer,
} from './frame'
import type { OrientationValue } from './frame'

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
