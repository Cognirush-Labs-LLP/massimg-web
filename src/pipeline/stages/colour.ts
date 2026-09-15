// Reading CICP colour signalling out of HEIF-family containers (R-I35, Technical Design §7.7).
//
// This module exists because of a measurement, not a theory. ImageMagick does not surface CICP at
// all: a real HEIC whose colour is signalled only by an `nclx` box reports `getColorProfile()` as
// null and `profileNames` as empty, exposes no attribute carrying the values, and returns its own
// *default* BT.709 primaries from `image.chromaticity` for every file — including a Display P3 one —
// so chromaticity is not evidence either. A13's open half is therefore answered: ImageMagick
// neither applies nor reports CICP on decode, and a pipeline that only asks ImageMagick for an ICC
// profile treats such an image as untagged sRGB and shifts its colour silently.
//
// So the `colr` box is parsed here, from the source bytes, before ImageMagick sees them.
//
// Pure: no codec import, so this is unit-testable under Vitest.

import type { Cicp, FrameColour } from './frame'

/** Stop conditions for a file that is malformed or hostile rather than merely unusual. */
const MAX_BOX_DEPTH = 8
const MAX_BOXES_PER_LEVEL = 4096

/** ISO BMFF boxes whose payload is a sequence of further boxes, on the path to `ipco`. */
const CONTAINER_BOXES: ReadonlySet<string> = new Set(['meta', 'iprp'])

interface Box {
  type: string
  /** Offset of the box's first byte, i.e. of its size field. */
  start: number
  /** Offset of the first payload byte, after the size and type (and any 64-bit size). */
  payload: number
  /** Offset one past the box's last byte. */
  end: number
}

function fourCharCode(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

/**
 * Reads the boxes directly inside `[start, end)`.
 *
 * Every size is validated against the enclosing range before it is used, so a box claiming to be
 * larger than its parent (or smaller than its own header) ends the walk rather than reading past
 * the buffer.
 */
function readBoxes(view: DataView, bytes: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let offset = start

  while (offset + 8 <= end && boxes.length < MAX_BOXES_PER_LEVEL) {
    let size = view.getUint32(offset)
    const type = fourCharCode(bytes, offset + 4)
    let header = 8

    if (size === 1) {
      if (offset + 16 > end) break
      const large = view.getBigUint64(offset + 8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(large)
      header = 16
    } else if (size === 0) {
      // "to end of file", legal only for the last box.
      size = end - offset
    }

    if (size < header || offset + size > end) break

    boxes.push({ type, start: offset, payload: offset + header, end: offset + size })
    offset += size
  }

  return boxes
}

/**
 * The children of a container box.
 *
 * `meta` is a FullBox, so its four version/flags bytes come before its children — except in
 * QuickTime-derived files, where the same box has no such header. Guessing wrong loses every child,
 * so both layouts are tried and the one that yields a plausible first child wins.
 */
function childrenOf(view: DataView, bytes: Uint8Array, box: Box): Box[] {
  if (box.type !== 'meta') {
    return readBoxes(view, bytes, box.payload, box.end)
  }

  const withFullBoxHeader = readBoxes(view, bytes, box.payload + 4, box.end)
  if (withFullBoxHeader.length > 0) {
    return withFullBoxHeader
  }
  return readBoxes(view, bytes, box.payload, box.end)
}

/** Depth-first search for one box type along the container path. */
function findBox(
  view: DataView,
  bytes: Uint8Array,
  boxes: Box[],
  type: string,
  depth: number,
): Box | null {
  if (depth > MAX_BOX_DEPTH) {
    return null
  }
  for (const box of boxes) {
    if (box.type === type) {
      return box
    }
    if (CONTAINER_BOXES.has(box.type)) {
      const found = findBox(view, bytes, childrenOf(view, bytes, box), type, depth + 1)
      if (found) {
        return found
      }
    }
  }
  return null
}

/**
 * `pitm`: which item is the image the file is *of*. Absent means there is nothing to resolve.
 *
 * The version/flags read is bound-checked like every other read here. `readBoxes` guarantees a box
 * *fits* in its parent, not that it is long enough to hold the fields its type implies, so a
 * structurally valid but degenerate FullBox — one with a header and no payload — reaches this with
 * nothing to read. Letting the `DataView` throw would be worse than returning null: a `RangeError`
 * escaping `decodeFrame` is mapped by `pipeline/worker.ts` to `{ kind: 'out-of-memory' }`, so a
 * malformed file would be reported to the user as the machine running out of memory.
 */
function readPrimaryItemId(view: DataView, box: Box): number | null {
  if (box.payload + 4 > box.end) {
    return null
  }
  const version = view.getUint8(box.payload)
  if (version === 0) {
    return box.payload + 6 <= box.end ? view.getUint16(box.payload + 4) : null
  }
  return box.payload + 8 <= box.end ? view.getUint32(box.payload + 4) : null
}

/**
 * `ipma`: the 1-based `ipco` property indices associated with each item.
 *
 * Reading this is what stops the parser from returning the wrong item's colour. One `ipco` is shared
 * by every item in the file, including auxiliary ones such as an alpha plane, and a property's index
 * says nothing about which item it belongs to — only `ipma` does. Taking the first `nclx` in the
 * file therefore risks reporting an auxiliary item's colour, typically signalled "unspecified", as
 * the photograph's.
 *
 * Measured on the real AVIF in the local test set (verification/t23-decode/results.json): its
 * primary item is associated with *both* `colr` boxes — an ICC profile and an `nclx` of 2/2/2 — and
 * its auxiliary item with none. So on that file the distinction does not bite, and what governs is
 * `resolveFrameColour`'s ICC-over-CICP precedence instead. The association is still read rather than
 * assumed, because nothing in the format guarantees the convenient arrangement.
 *
 * The version/flags read is bound-checked for the reason given on `readPrimaryItemId`.
 */
function readPropertyIndicesFor(view: DataView, box: Box, itemId: number): number[] {
  if (box.payload + 4 > box.end) {
    return []
  }
  const version = view.getUint8(box.payload)
  const flags = view.getUint32(box.payload) & 0xffffff
  const wideIndices = (flags & 1) === 1
  const wideItemIds = version >= 1

  let offset = box.payload + 4
  if (offset + 4 > box.end) {
    return []
  }
  const entryCount = view.getUint32(offset)
  offset += 4

  for (let entry = 0; entry < entryCount && entry < MAX_BOXES_PER_LEVEL; entry++) {
    const idSize = wideItemIds ? 4 : 2
    if (offset + idSize + 1 > box.end) {
      return []
    }
    const id = wideItemIds ? view.getUint32(offset) : view.getUint16(offset)
    offset += idSize
    const associationCount = view.getUint8(offset)
    offset += 1

    const associationSize = wideIndices ? 2 : 1
    if (offset + associationCount * associationSize > box.end) {
      return []
    }

    if (id === itemId) {
      const indices: number[] = []
      for (let i = 0; i < associationCount; i++) {
        const at = offset + i * associationSize
        // The top bit is `essential`, not part of the index.
        indices.push(wideIndices ? view.getUint16(at) & 0x7fff : view.getUint8(at) & 0x7f)
      }
      return indices
    }

    offset += associationCount * associationSize
  }

  return []
}

/** A `colr` box's payload: a four-character colour type, then type-specific data. */
function readNclx(view: DataView, bytes: Uint8Array, box: Box): Cicp | null {
  if (box.payload + 4 > box.end || fourCharCode(bytes, box.payload) !== 'nclx') {
    return null
  }
  // colour_type(4) + primaries(2) + transfer(2) + matrix(2) + full_range_flag(1)
  if (box.payload + 11 > box.end) {
    return null
  }
  return {
    primaries: view.getUint16(box.payload + 4),
    transfer: view.getUint16(box.payload + 6),
    matrix: view.getUint16(box.payload + 8),
    fullRange: ((bytes[box.payload + 10] ?? 0) & 0x80) !== 0,
  }
}

/**
 * The CICP values signalled for the file's **primary item**, or null if there are none.
 *
 * Returns null for anything that is not a HEIF-family container, for a container with no `ipco`,
 * and for a primary item with no `colr`/`nclx` property. Null means "this file does not signal
 * colour this way" — it does not mean sRGB, and the caller decides what absence implies (R-I14).
 */
export function readCicp(source: Uint8Array): Cicp | null {
  // Every HEIF-family file starts with an `ftyp` box. Checking it first means a JPEG or a PNG costs
  // one comparison rather than a box walk over compressed data that happens to look like sizes.
  if (source.byteLength < 16 || fourCharCode(source, 4) !== 'ftyp') {
    return null
  }

  const view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const topLevel = readBoxes(view, source, 0, source.byteLength)

  const meta = topLevel.find((box) => box.type === 'meta')
  if (!meta) {
    return null
  }
  const metaChildren = childrenOf(view, source, meta)

  const ipco = findBox(view, source, metaChildren, 'ipco', 0)
  if (!ipco) {
    return null
  }
  const properties = readBoxes(view, source, ipco.payload, ipco.end)

  const pitm = metaChildren.find((box) => box.type === 'pitm')
  const ipma = findBox(view, source, metaChildren, 'ipma', 0)
  if (!pitm || !ipma) {
    return null
  }

  const primaryItemId = readPrimaryItemId(view, pitm)
  if (primaryItemId === null) {
    return null
  }

  // ISO/IEC 14496-12 allows more than one `colr`; a profile takes precedence over `nclx` where both
  // are associated with the same item, matching R-I12's "the embedded ICC profile is preserved".
  // Only the `nclx` is returned here, because the profile is ImageMagick's to report and `decode.ts`
  // asks it first.
  for (const index of readPropertyIndicesFor(view, ipma, primaryItemId)) {
    const property = properties[index - 1]
    if (property?.type === 'colr') {
      const cicp = readNclx(view, source, property)
      if (cicp) {
        return cicp
      }
    }
  }

  return null
}

/**
 * The frame's colour, from what the decoder found and what the container says.
 *
 * The order is the whole point. An embedded ICC profile wins, because R-I12 names the profile as
 * the thing preserved and R-I35 is written for the case where there is *no* profile. CICP is
 * consulted only when there is no profile, and "neither" is its own answer rather than a silent
 * assumption of sRGB — the encoder is what acts on `untagged` (R-I14), not this.
 */
export function resolveFrameColour(
  icc: { profile: Uint8Array; description: string | null } | null,
  source: Uint8Array,
): FrameColour {
  if (icc) {
    return { kind: 'icc', profile: icc.profile, description: icc.description }
  }

  const cicp = readCicp(source)
  return cicp ? { kind: 'cicp', cicp } : { kind: 'untagged' }
}
