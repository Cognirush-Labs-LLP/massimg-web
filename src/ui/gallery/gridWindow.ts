// Pure grid virtualization math for the Gallery grid (T33-B, Technical Design §10.4, R-G10). Kept
// free of the DOM so the windowing logic is table-driven-testable the same way domain/edit.ts's
// arithmetic is, even though this lives under ui/ because its constants (tile minimum width, meta
// block height) are presentation details rather than reusable domain logic.
//
// GalleryGrid.vue supplies real measurements (container width, scroll position, viewport height);
// this module never touches the DOM itself.

/** docs/ui-design.md §6's mockup minimum grid tile width. */
export const MIN_TILE_WIDTH = 168
/** Filename line + "W×H · size" line beneath the square thumbnail. */
export const TILE_META_HEIGHT = 44
export const TILE_GAP = 10
/** Extra rows rendered beyond the viewport on each side, to avoid a blank flash while scrolling. */
export const RENDER_BUFFER_ROWS = 1
/** Extra rows requested from the thumbnail service on each side — R-G10's "near-visible". */
export const REQUEST_BUFFER_ROWS = 1

export interface GridLayout {
  columns: number
  tileWidth: number
  rowHeight: number
  rowCount: number
}

/** Column count and row height for a grid of `itemCount` tiles at `containerWidth` px wide. */
export function computeGridLayout(containerWidth: number, itemCount: number): GridLayout {
  const safeWidth = Math.max(containerWidth, MIN_TILE_WIDTH)
  const columns = Math.max(1, Math.floor((safeWidth + TILE_GAP) / (MIN_TILE_WIDTH + TILE_GAP)))
  const tileWidth = (safeWidth - TILE_GAP * (columns - 1)) / columns
  const rowHeight = tileWidth + TILE_META_HEIGHT + TILE_GAP
  const rowCount = itemCount === 0 ? 0 : Math.ceil(itemCount / columns)

  return { columns, tileWidth, rowHeight, rowCount }
}

export interface GridWindow {
  /** Inclusive item-index range to actually render (visible rows + the render buffer). */
  renderFirstIndex: number
  renderLastIndex: number
  /** Inclusive item-index range to hand the thumbnail service (visible rows + the request buffer). */
  requestFirstIndex: number
  requestLastIndex: number
  /** Spacer heights, in px, that hold scrollbar geometry steady around the rendered rows. */
  topSpacerHeight: number
  bottomSpacerHeight: number
}

const EMPTY_WINDOW: GridWindow = {
  renderFirstIndex: 0,
  renderLastIndex: -1,
  requestFirstIndex: 0,
  requestLastIndex: -1,
  topSpacerHeight: 0,
  bottomSpacerHeight: 0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Which rows are visible/near-visible for the given scroll position, and the spacers around them. */
export function computeGridWindow(
  layout: GridLayout,
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
): GridWindow {
  if (itemCount === 0 || layout.rowCount === 0 || layout.rowHeight <= 0) {
    return EMPTY_WINDOW
  }

  const lastRow = layout.rowCount - 1
  const clampedScrollTop = Math.max(0, scrollTop)
  const firstVisibleRow = Math.floor(clampedScrollTop / layout.rowHeight)
  // ceil(...) - 1 rather than floor(...): when the viewport's bottom edge lands exactly on a row
  // boundary, that next row has 0px actually visible and must not count as "visible".
  const lastVisibleRow = Math.max(
    firstVisibleRow,
    Math.ceil(Math.max(0, clampedScrollTop + viewportHeight) / layout.rowHeight) - 1,
  )

  const renderFirstRow = clamp(firstVisibleRow - RENDER_BUFFER_ROWS, 0, lastRow)
  const renderLastRow = clamp(lastVisibleRow + RENDER_BUFFER_ROWS, 0, lastRow)
  const requestFirstRow = clamp(firstVisibleRow - REQUEST_BUFFER_ROWS, 0, lastRow)
  const requestLastRow = clamp(lastVisibleRow + REQUEST_BUFFER_ROWS, 0, lastRow)

  return {
    renderFirstIndex: renderFirstRow * layout.columns,
    renderLastIndex: Math.min(itemCount - 1, (renderLastRow + 1) * layout.columns - 1),
    requestFirstIndex: requestFirstRow * layout.columns,
    requestLastIndex: Math.min(itemCount - 1, (requestLastRow + 1) * layout.columns - 1),
    topSpacerHeight: renderFirstRow * layout.rowHeight,
    bottomSpacerHeight: (lastRow - renderLastRow) * layout.rowHeight,
  }
}
