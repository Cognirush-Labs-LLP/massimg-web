import { describe, expect, it } from 'vitest'

import { nextToken } from './protocol'

describe('nextToken', () => {
  it('is strictly increasing, so "newer" is a comparison rather than a lookup', () => {
    const tokens = Array.from({ length: 100 }, () => nextToken() as number)

    for (const [index, token] of tokens.entries()) {
      if (index > 0) {
        expect(token).toBeGreaterThan(tokens[index - 1] as number)
      }
    }
  })

  it('never repeats a token across calls', () => {
    const tokens = Array.from({ length: 50 }, () => nextToken() as number)

    expect(new Set(tokens).size).toBe(tokens.length)
  })
})
