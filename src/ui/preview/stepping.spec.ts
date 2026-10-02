import { describe, expect, it } from 'vitest'
import { wrappedIndex } from './stepping'

describe('wrappedIndex (R-P7)', () => {
  it('moves forward and backward within the batch', () => {
    expect(wrappedIndex(0, 3, 1)).toBe(1)
    expect(wrappedIndex(1, 3, 1)).toBe(2)
    expect(wrappedIndex(2, 3, -1)).toBe(1)
  })

  it('wraps at both ends', () => {
    expect(wrappedIndex(2, 3, 1)).toBe(0)
    expect(wrappedIndex(0, 3, -1)).toBe(2)
  })

  it('stays put on a batch of one', () => {
    expect(wrappedIndex(0, 1, 1)).toBe(0)
    expect(wrappedIndex(0, 1, -1)).toBe(0)
  })

  it('wraps a step larger than the batch', () => {
    expect(wrappedIndex(0, 3, 7)).toBe(1)
    expect(wrappedIndex(0, 3, -7)).toBe(2)
  })

  it('answers zero for an empty batch rather than a negative index', () => {
    expect(wrappedIndex(0, 0, 1)).toBe(0)
    expect(wrappedIndex(0, 0, -1)).toBe(0)
  })
})
