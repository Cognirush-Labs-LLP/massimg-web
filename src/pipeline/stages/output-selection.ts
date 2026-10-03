// The byte-size decision shared by every format after it has produced its best encoded candidate
// (Functional Design R-X24/R-X45). Kept pure so the equality boundary and format/change matrix are
// pinned without importing the WASM-backed execution module into Vitest.

export type OutputSelectionPlan = 'source' | 'encoded' | 'encoded-larger'

export function planOutputSelection(input: {
  sourceBytes: number
  encodedBytes: number
  sameFormat: boolean
  sourceSatisfiesRequest: boolean
}): OutputSelectionPlan {
  if (!input.sameFormat) return 'encoded'

  if (input.sourceSatisfiesRequest && input.encodedBytes >= input.sourceBytes) {
    return 'source'
  }

  return !input.sourceSatisfiesRequest && input.encodedBytes > input.sourceBytes
    ? 'encoded-larger'
    : 'encoded'
}
