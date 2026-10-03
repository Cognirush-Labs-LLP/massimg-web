import { describe, expect, it } from 'vitest'
import { planOutputSelection } from './output-selection'

describe('planOutputSelection', () => {
  it.each([
    ['larger', 101],
    ['equal', 100],
  ] as const)(
    'keeps an eligible source when the encoded candidate is %s',
    (_label, encodedBytes) => {
      expect(
        planOutputSelection({
          sourceBytes: 100,
          encodedBytes,
          sameFormat: true,
          sourceSatisfiesRequest: true,
        }),
      ).toBe('source')
    },
  )

  it('keeps a smaller encoded candidate', () => {
    expect(
      planOutputSelection({
        sourceBytes: 100,
        encodedBytes: 99,
        sameFormat: true,
        sourceSatisfiesRequest: true,
      }),
    ).toBe('encoded')
  })

  it('retains and marks a larger same-format candidate when the source cannot satisfy the request', () => {
    expect(
      planOutputSelection({
        sourceBytes: 100,
        encodedBytes: 101,
        sameFormat: true,
        sourceSatisfiesRequest: false,
      }),
    ).toBe('encoded-larger')
  })

  it('never compares a format conversion with the source', () => {
    expect(
      planOutputSelection({
        sourceBytes: 100,
        encodedBytes: 1000,
        sameFormat: false,
        sourceSatisfiesRequest: false,
      }),
    ).toBe('encoded')
  })
})
