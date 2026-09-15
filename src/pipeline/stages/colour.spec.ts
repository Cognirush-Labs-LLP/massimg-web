import { describe, expect, it } from 'vitest'
import { readCicp, resolveFrameColour } from './colour'

// ---------------------------------------------------------------------------------------------
// ISO BMFF builders. Hand-built trees are what make the awkward cases testable at all: a HEIF file
// with an `nclx` box belonging to an auxiliary item, or an `ipma` using 16-bit property indices,
// cannot be produced by the encoders in this build.
// ---------------------------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const u8 = (value: number): Uint8Array => new Uint8Array([value])
const u16 = (value: number): Uint8Array => new Uint8Array([value >> 8, value & 0xff])
const u32 = (value: number): Uint8Array =>
  new Uint8Array([value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
const ascii = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)))

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload)
  return concat([u32(body.length + 8), ascii(type), body])
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...payload: Uint8Array[]
): Uint8Array {
  return box(
    type,
    u8(version),
    new Uint8Array([flags >> 16, (flags >> 8) & 0xff, flags & 0xff]),
    ...payload,
  )
}

const nclxColr = (
  primaries: number,
  transfer: number,
  matrix: number,
  fullRange = true,
): Uint8Array =>
  box('colr', ascii('nclx'), u16(primaries), u16(transfer), u16(matrix), u8(fullRange ? 0x80 : 0))

const profColr = (length = 32): Uint8Array => box('colr', ascii('prof'), new Uint8Array(length))

interface Association {
  itemId: number
  /** 1-based indices into `ipco`'s children. */
  indices: number[]
}

function ipma(
  associations: Association[],
  { wideIndices = false, wideItemIds = false } = {},
): Uint8Array {
  const entries = associations.map(({ itemId, indices }) =>
    concat([
      wideItemIds ? u32(itemId) : u16(itemId),
      u8(indices.length),
      ...indices.map((index) => (wideIndices ? u16(index) : u8(index))),
    ]),
  )
  return fullBox('ipma', wideItemIds ? 1 : 0, wideIndices ? 1 : 0, u32(entries.length), ...entries)
}

interface FileShape {
  primaryItem?: number | null
  properties: Uint8Array[]
  associations: Association[]
  ipmaOptions?: { wideIndices?: boolean; wideItemIds?: boolean }
  /** QuickTime-derived files write `meta` without its FullBox version/flags header. */
  metaWithoutFullBoxHeader?: boolean
  brand?: string
}

function heifFile({
  primaryItem = 1,
  properties,
  associations,
  ipmaOptions,
  metaWithoutFullBoxHeader = false,
  brand = 'avif',
}: FileShape): Uint8Array {
  const metaChildren = concat([
    ...(primaryItem === null ? [] : [fullBox('pitm', 0, 0, u16(primaryItem))]),
    box('iprp', box('ipco', ...properties), ipma(associations, ipmaOptions)),
  ])
  const meta = metaWithoutFullBoxHeader
    ? box('meta', metaChildren)
    : box('meta', u8(0), new Uint8Array(3), metaChildren)

  return concat([
    box('ftyp', ascii(brand), u32(0), ascii(brand)),
    meta,
    box('mdat', new Uint8Array(8)),
  ])
}

const DISPLAY_P3 = { primaries: 12, transfer: 13, matrix: 6, fullRange: true }

describe('readCicp', () => {
  it('reads the nclx box associated with the primary item', () => {
    const file = heifFile({
      properties: [box('ispe', new Uint8Array(12)), nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [1, 2] }],
    })
    expect(readCicp(file)).toEqual(DISPLAY_P3)
  })

  it('reads the full-range flag', () => {
    const file = heifFile({
      properties: [nclxColr(12, 13, 6, false)],
      associations: [{ itemId: 1, indices: [1] }],
    })
    expect(readCicp(file)?.fullRange).toBe(false)
  })

  // One `ipco` is shared by every item in a HEIF file, so a property's position says nothing about
  // whose it is. Hand-built because no file in the local test set is arranged this way — the real
  // AVIF there associates both of its `colr` boxes with the *primary* item — and a case that cannot
  // be produced from a real file is exactly the one a unit test has to cover.
  it('ignores an nclx box belonging to an auxiliary item', () => {
    const file = heifFile({
      primaryItem: 1,
      properties: [box('ispe', new Uint8Array(12)), nclxColr(2, 2, 2)],
      associations: [
        { itemId: 1, indices: [1] },
        { itemId: 2, indices: [1, 2] },
      ],
    })
    expect(readCicp(file)).toBeNull()
  })

  it('ignores an ICC profile colr box and keeps looking', () => {
    const file = heifFile({
      properties: [profColr(), nclxColr(9, 16, 9)],
      associations: [{ itemId: 1, indices: [1, 2] }],
    })
    expect(readCicp(file)).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true })
  })

  it('returns null when the primary item has only an ICC profile', () => {
    const file = heifFile({
      properties: [profColr()],
      associations: [{ itemId: 1, indices: [1] }],
    })
    expect(readCicp(file)).toBeNull()
  })

  // "Unspecified" is a present signal that says nothing. It is reported as present rather than
  // collapsed to untagged: absent and present-and-uninformative are different, and the encoder is
  // what decides they amount to the same thing.
  it('reports an all-unspecified nclx as present rather than as nothing', () => {
    const file = heifFile({
      properties: [nclxColr(2, 2, 2)],
      associations: [{ itemId: 1, indices: [1] }],
    })
    expect(readCicp(file)).toEqual({ primaries: 2, transfer: 2, matrix: 2, fullRange: true })
  })

  it('reads 16-bit property indices when the ipma flags ask for them', () => {
    const file = heifFile({
      properties: [box('ispe', new Uint8Array(12)), nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [1, 2] }],
      ipmaOptions: { wideIndices: true },
    })
    expect(readCicp(file)).toEqual(DISPLAY_P3)
  })

  it('reads 32-bit item ids when the ipma version asks for them', () => {
    const file = heifFile({
      properties: [nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [1] }],
      ipmaOptions: { wideItemIds: true },
    })
    expect(readCicp(file)).toEqual(DISPLAY_P3)
  })

  it('finds the properties of a QuickTime-style meta box with no FullBox header', () => {
    const file = heifFile({
      properties: [nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [1] }],
      metaWithoutFullBoxHeader: true,
    })
    expect(readCicp(file)).toEqual(DISPLAY_P3)
  })

  it('resolves against the declared primary item, not the first one', () => {
    const file = heifFile({
      primaryItem: 2,
      properties: [nclxColr(1, 1, 1), nclxColr(12, 13, 6)],
      associations: [
        { itemId: 1, indices: [1] },
        { itemId: 2, indices: [2] },
      ],
    })
    expect(readCicp(file)).toEqual(DISPLAY_P3)
  })

  it('returns null when there is no pitm to resolve against', () => {
    const file = heifFile({
      primaryItem: null,
      properties: [nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [1] }],
    })
    expect(readCicp(file)).toBeNull()
  })

  it('returns null for a property index that points past the end of ipco', () => {
    const file = heifFile({
      properties: [nclxColr(12, 13, 6)],
      associations: [{ itemId: 1, indices: [7] }],
    })
    expect(readCicp(file)).toBeNull()
  })

  // A box that *fits* its parent but is too short for the fields its type implies. `readBoxes`
  // validates the first property and cannot validate the second, so these reach the field readers
  // with nothing to read.
  //
  // Built with no trailing `mdat`, so the degenerate box is the last thing in the buffer: a
  // `DataView` read past a box but still inside the buffer returns neighbouring bytes rather than
  // throwing, and a file that happened to have more data after it would hide the fault.
  //
  // Why this matters more than an ordinary parse failure: a `RangeError` escaping `decodeFrame` is
  // mapped by pipeline/worker.ts to `{ kind: 'out-of-memory' }`, so a malformed file would be
  // reported to the user as the machine running out of memory rather than as an unreadable image.
  describe('structurally valid but degenerate boxes', () => {
    function fileEndingWith(trailing: Uint8Array[], leading: Uint8Array[] = []): Uint8Array {
      const meta = box('meta', u8(0), new Uint8Array(3), concat([...leading, ...trailing]))
      return concat([box('ftyp', ascii('avif'), u32(0), ascii('avif')), meta])
    }

    const validIpma = ipma([{ itemId: 1, indices: [1] }])
    const validPitm = fullBox('pitm', 0, 0, u16(1))
    const ipco = box('ipco', nclxColr(12, 13, 6))

    for (const payloadBytes of [0, 1, 2, 3]) {
      it(`does not throw on a pitm with ${payloadBytes} payload bytes, last in the buffer`, () => {
        const file = fileEndingWith(
          [box('pitm', new Uint8Array(payloadBytes))],
          [box('iprp', ipco, validIpma)],
        )
        expect(() => readCicp(file)).not.toThrow()
        expect(readCicp(file)).toBeNull()
      })

      it(`does not throw on an ipma with ${payloadBytes} payload bytes, last in the buffer`, () => {
        const file = fileEndingWith(
          [box('iprp', ipco, box('ipma', new Uint8Array(payloadBytes)))],
          [validPitm],
        )
        expect(() => readCicp(file)).not.toThrow()
        expect(readCicp(file)).toBeNull()
      })
    }

    it('still reads a well-formed file laid out the same way, with no trailing mdat', () => {
      const file = fileEndingWith([box('iprp', ipco, validIpma)], [validPitm])
      expect(readCicp(file)).toEqual(DISPLAY_P3)
    })
  })

  describe('malformed and non-container input', () => {
    it('returns null for a JPEG', () => {
      expect(
        readCicp(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)])),
      ).toBeNull()
    })

    it('returns null for an empty or tiny buffer', () => {
      expect(readCicp(new Uint8Array(0))).toBeNull()
      expect(readCicp(new Uint8Array(8))).toBeNull()
    })

    it('returns null, without throwing, for a box claiming to be larger than the file', () => {
      const file = heifFile({
        properties: [nclxColr(12, 13, 6)],
        associations: [{ itemId: 1, indices: [1] }],
      })
      const lying = new Uint8Array(file)
      // Overwrite the `meta` box's size with something past the end of the buffer.
      const metaStart = file.indexOf(0x6d) // first 'm'; the ftyp box above contains none
      new DataView(lying.buffer).setUint32(metaStart - 4, 0x7fffffff)
      expect(() => readCicp(lying)).not.toThrow()
      expect(readCicp(lying)).toBeNull()
    })

    it('returns null, without throwing, for a truncated container', () => {
      const file = heifFile({
        properties: [nclxColr(12, 13, 6)],
        associations: [{ itemId: 1, indices: [1] }],
      })
      for (const cut of [20, 40, 60, file.length - 4]) {
        expect(() => readCicp(file.subarray(0, cut))).not.toThrow()
      }
    })
  })

  // The committed fixtures are not read here: src/** compiles without Node types, so a unit test
  // cannot open a file. They are parsed by this same code against real encoder output in
  // tests/e2e/decode.spec.ts, which drives cicp-p3.avif and untagged.avif through the real decoder
  // on all three engines.
})

describe('resolveFrameColour', () => {
  const profile = new Uint8Array([1, 2, 3])
  const cicpFile = heifFile({
    properties: [nclxColr(12, 13, 6)],
    associations: [{ itemId: 1, indices: [1] }],
  })

  it('prefers an embedded ICC profile over CICP when the container carries both', () => {
    expect(resolveFrameColour({ profile, description: 'Display P3' }, cicpFile)).toEqual({
      kind: 'icc',
      profile,
      description: 'Display P3',
    })
  })

  it('falls back to CICP when there is no profile', () => {
    expect(resolveFrameColour(null, cicpFile)).toEqual({ kind: 'cicp', cicp: DISPLAY_P3 })
  })

  // R-I14's case, and only this case: neither signal present. A CICP-signalled image reaching this
  // branch is the silent colour shift R-I35 exists to prevent.
  it('reports untagged only when neither signal is present', () => {
    expect(resolveFrameColour(null, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      kind: 'untagged',
    })
  })

  it('keeps a null profile description rather than inventing one', () => {
    expect(resolveFrameColour({ profile, description: null }, cicpFile)).toEqual({
      kind: 'icc',
      profile,
      description: null,
    })
  })
})
