import { describe, expect, it } from 'vitest'
import { computeGridLayout, computeGridWindow, TILE_GAP, TILE_META_HEIGHT } from './gridWindow'

describe('computeGridLayout', () => {
  it('fits as many columns of at least the minimum tile width as the container allows', () => {
    // 5 columns of 168px + 4 gaps of 10px = 880px; a 6th column would need 890px.
    const layout = computeGridLayout(885, 100)
    expect(layout.columns).toBe(5)
    expect(layout.tileWidth).toBeCloseTo((885 - TILE_GAP * 4) / 5)
  })

  it('never drops below one column, even narrower than the minimum tile width', () => {
    const layout = computeGridLayout(50, 10)
    expect(layout.columns).toBe(1)
    expect(layout.tileWidth).toBeGreaterThan(0)
  })

  it('derives row height from tile width plus the fixed meta block and one gap', () => {
    const layout = computeGridLayout(400, 10)
    expect(layout.rowHeight).toBeCloseTo(layout.tileWidth + TILE_META_HEIGHT + TILE_GAP)
  })

  it('computes row count from item count and column count, and zero for an empty batch', () => {
    expect(computeGridLayout(400, 0).rowCount).toBe(0)
    const layout = computeGridLayout(400, 21)
    expect(layout.rowCount).toBe(Math.ceil(21 / layout.columns))
  })

  it('never yields a column count below the true minimum, protecting against zero width', () => {
    const layout = computeGridLayout(0, 5)
    expect(layout.columns).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(layout.tileWidth)).toBe(true)
  })
})

describe('computeGridWindow', () => {
  it('returns an empty window for an empty batch', () => {
    const layout = computeGridLayout(400, 0)
    const window_ = computeGridWindow(layout, 0, 600, 0)
    expect(window_.renderLastIndex).toBeLessThan(window_.renderFirstIndex)
    expect(window_.topSpacerHeight).toBe(0)
    expect(window_.bottomSpacerHeight).toBe(0)
  })

  it('renders every row when the whole grid fits in the viewport', () => {
    const layout = computeGridLayout(400, 12) // some number of columns, a handful of rows
    const window_ = computeGridWindow(layout, 0, layout.rowHeight * layout.rowCount, 12)
    expect(window_.renderFirstIndex).toBe(0)
    expect(window_.renderLastIndex).toBe(11)
    expect(window_.topSpacerHeight).toBe(0)
    expect(window_.bottomSpacerHeight).toBe(0)
  })

  it('renders only the visible rows plus one buffer row on each side when scrolled mid-batch', () => {
    // Force a known shape: 1 column (very narrow container) so rows and items line up 1:1.
    const layout = computeGridLayout(1, 500)
    expect(layout.columns).toBe(1)

    const viewportHeight = layout.rowHeight * 3 // 3 rows visible at once
    const scrollTop = layout.rowHeight * 50 // scrolled 50 rows down

    const window_ = computeGridWindow(layout, scrollTop, viewportHeight, 500)

    // Visible rows 50-52 (viewport covers exactly 3 rows), +/- 1 buffer row = 49-53.
    expect(window_.renderFirstIndex).toBe(49)
    expect(window_.renderLastIndex).toBe(53)
    expect(window_.topSpacerHeight).toBeCloseTo(49 * layout.rowHeight)
    expect(window_.bottomSpacerHeight).toBeCloseTo((layout.rowCount - 1 - 53) * layout.rowHeight)
  })

  it('requests a wider window than it renders, per R-G10s near-visible thumbnail budget', () => {
    const layout = computeGridLayout(1, 500)
    const window_ = computeGridWindow(layout, layout.rowHeight * 50, layout.rowHeight * 3, 500)

    expect(window_.requestFirstIndex).toBeLessThanOrEqual(window_.renderFirstIndex)
    expect(window_.requestLastIndex).toBeGreaterThanOrEqual(window_.renderLastIndex)
  })

  it('clamps the render window at the start and end of the batch without going negative', () => {
    const layout = computeGridLayout(1, 5)

    const atStart = computeGridWindow(layout, 0, layout.rowHeight * 2, 5)
    expect(atStart.renderFirstIndex).toBe(0)
    expect(atStart.topSpacerHeight).toBe(0)

    const atEnd = computeGridWindow(layout, layout.rowHeight * 100, layout.rowHeight * 2, 5)
    expect(atEnd.renderLastIndex).toBe(4)
    expect(atEnd.bottomSpacerHeight).toBe(0)
  })

  it('a fast scroll produces disjoint windows rather than one that grows to cover everything passed', () => {
    // This is the property that keeps setVisible() calls small while scrolling quickly (R-G10) —
    // the window's *size* stays bounded by the viewport + buffer, it does not accumulate history.
    const layout = computeGridLayout(1, 500)
    const viewportHeight = layout.rowHeight * 3

    // Away from row 0 on both sides, so neither window's buffer is clipped by the start-of-batch
    // clamp — that clamping is real and correct (see the "clamps... without going negative" test
    // above), but would make the two spans legitimately unequal and isn't what this test is about.
    const early = computeGridWindow(layout, layout.rowHeight * 10, viewportHeight, 500)
    const late = computeGridWindow(layout, layout.rowHeight * 200, viewportHeight, 500)

    const earlySpan = early.requestLastIndex - early.requestFirstIndex
    const lateSpan = late.requestLastIndex - late.requestFirstIndex
    expect(lateSpan).toBe(earlySpan)
    expect(late.requestFirstIndex).toBeGreaterThan(early.requestLastIndex)
  })
})
