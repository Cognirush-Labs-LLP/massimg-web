// @vitest-environment node
//
// Node rather than jsdom: nothing here touches the DOM, and the §6 table allocates frames up to
// 8000×6000 RGBA (192 MB), which is typed-array work with no reason to run inside jsdom's realm.

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CROP_LIMITS,
  editOpsFor,
  hasSpill,
  resolveCropGeometry,
  resolveCropOutput,
  resolveEditedSize,
  rotateSize,
} from '@/domain/edit'
import type { CropGeometryInput, PixelSize, ResolvedCropGeometry } from '@/domain/edit'
import type { AlphaHandling, EditOp, EditRecord, NormalisedRect, Rgba } from '@/domain/types'

import { EditError, applyEdit } from './edit'
import { ownsWholeBuffer } from './frame'
import type { Frame, FrameColour } from './frame'

// The worked example of Technical Design §6, verbatim. Mirrors WORKED_EXAMPLE in
// src/domain/edit.spec.ts, which proves the arithmetic; this file proves the pixels.
const SOURCE = { width: 4000, height: 3000 } as const satisfies PixelSize
const FRAME = { width: 800, height: 600 } as const satisfies PixelSize
const CENTRED_CROP = { left: 200, top: 150, width: 400, height: 300 } as const

const WORKED_EXAMPLE = [
  { zoom: 1, output: { width: 2000, height: 1500 }, spills: false },
  { zoom: 2, output: { width: 1000, height: 750 }, spills: false },
  { zoom: 0.5, output: { width: 4000, height: 3000 }, spills: false },
  { zoom: 0.25, output: { width: 8000, height: 6000 }, spills: true },
] as const

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, a: 1 } as const satisfies Rgba
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 } as const satisfies Rgba
const PRESERVE = { kind: 'preserve' } as const satisfies AlphaHandling

const QUARTER_TURNS = [0, 1, 2, 3] as const

/** A table case that allocates a 192 MB output and checks 48 M pixels against the oracle. */
const LARGE_TIMEOUT = 120_000

// ---------------------------------------------------------------------------------------------
// Fixtures and the oracle
// ---------------------------------------------------------------------------------------------

/**
 * The bytes a coordinate-encoded source carries at (x, y): the low byte of each coordinate in R
 * and G, both high nibbles in B, opaque. Unique for any source under 4096×4096, so every output
 * pixel names the source pixel it came from.
 */
function encodedPixel(x: number, y: number): [number, number, number, number] {
  return [x & 0xff, y & 0xff, ((x >> 8) << 4) | (y >> 8), 255]
}

function coordinateFrame(size: PixelSize, colour: FrameColour = { kind: 'untagged' }): Frame {
  const pixels = new Uint8Array(size.width * size.height * 4)

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      pixels.set(encodedPixel(x, y), (y * size.width + x) * 4)
    }
  }

  return { ...size, pixels, colour, sourceOrientation: { kind: 'absent' } }
}

function frameOf(size: PixelSize, bytes: readonly number[]): Frame {
  return {
    ...size,
    pixels: Uint8Array.from(bytes),
    colour: { kind: 'untagged' },
    sourceOrientation: { kind: 'absent' },
  }
}

function fillBytes(background: Rgba, alpha: AlphaHandling): number[] {
  const a = alpha.kind === 'flatten' ? 255 : Math.round(background.a * 255)
  return [background.r, background.g, background.b, a]
}

type OracleStep =
  | { kind: 'rotate'; quarterTurns: number; input: PixelSize }
  | { kind: 'crop'; offsetX: number; offsetY: number; input: PixelSize; fill: number[] }

/**
 * Sizes each op's input by walking forward. Crop placement is taken from `resolveCropOutput`,
 * which is the prediction under test; rotation is restated here from first principles.
 */
function oracleSteps(source: PixelSize, ops: readonly EditOp[], alpha: AlphaHandling) {
  const steps: OracleStep[] = []
  let size = source

  for (const op of ops) {
    if (op.kind === 'rotate') {
      steps.push({ kind: 'rotate', quarterTurns: op.quarterTurns, input: size })
      size = rotateSize(size, op.quarterTurns)
    } else {
      const output = resolveCropOutput(op.rect, size)
      steps.push({
        kind: 'crop',
        offsetX: output.placement.offsetX,
        offsetY: output.placement.offsetY,
        input: size,
        fill: fillBytes(op.background, alpha),
      })
      size = output.size
    }
  }

  return { steps, size }
}

/**
 * Checks every output pixel against a per-pixel inverse mapping, written independently of the
 * stage's forward row copies: each output coordinate is walked back through the ops to either a
 * source coordinate or a spill fill. Returns the first few mismatches and the total.
 */
function oracleMismatches(
  output: Frame,
  source: PixelSize,
  ops: readonly EditOp[],
  alpha: AlphaHandling = PRESERVE,
): { count: number; first: string[] } {
  const { steps, size } = oracleSteps(source, ops, alpha)
  const first: string[] = []
  let count = 0

  if (output.width !== size.width || output.height !== size.height) {
    return {
      count: 1,
      first: [`size ${output.width}x${output.height}, expected ${size.width}x${size.height}`],
    }
  }

  for (let v = 0; v < output.height; v += 1) {
    for (let u = 0; u < output.width; u += 1) {
      let x = u
      let y = v
      let fill: number[] | null = null

      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index]!
        const { width, height } = step.input

        if (step.kind === 'crop') {
          x -= step.offsetX
          y -= step.offsetY
          if (x < 0 || y < 0 || x >= width || y >= height) {
            fill = step.fill
            break
          }
        } else if (step.quarterTurns === 1) {
          // Clockwise: the output's column u came from source row height-1-u.
          const nextX = y
          y = height - 1 - x
          x = nextX
        } else if (step.quarterTurns === 2) {
          x = width - 1 - x
          y = height - 1 - y
        } else if (step.quarterTurns === 3) {
          const nextX = width - 1 - y
          y = x
          x = nextX
        }
      }

      const expected = fill ?? encodedPixel(x, y)
      const offset = (v * output.width + u) * 4

      if (
        output.pixels[offset] !== expected[0] ||
        output.pixels[offset + 1] !== expected[1] ||
        output.pixels[offset + 2] !== expected[2] ||
        output.pixels[offset + 3] !== expected[3]
      ) {
        count += 1
        if (first.length < 5) {
          first.push(
            `(${u}, ${v}): got ${Array.from(output.pixels.subarray(offset, offset + 4))}, expected ${expected}`,
          )
        }
      }
    }
  }

  return { count, first }
}

function pixelAt(frame: Frame, x: number, y: number): number[] {
  const offset = (y * frame.width + x) * 4
  return Array.from(frame.pixels.subarray(offset, offset + 4))
}

function edit(ops: EditOp[]): EditRecord {
  return { ops, version: 1 }
}

function crop(rect: NormalisedRect, background: Rgba = OPAQUE_WHITE): EditOp {
  return { kind: 'crop', rect, zoom: 1, background }
}

function rotate(quarterTurns: 0 | 1 | 2 | 3): EditOp {
  return { kind: 'rotate', quarterTurns }
}

function geometry(overrides: Partial<CropGeometryInput>): ResolvedCropGeometry {
  const resolved = resolveCropGeometry({
    source: SOURCE,
    quarterTurns: 0,
    frame: FRAME,
    zoom: 1,
    rect: CENTRED_CROP,
    ratio: { kind: 'free' },
    limits: DEFAULT_CROP_LIMITS,
    ...overrides,
  })

  if (resolved.kind !== 'resolved') {
    throw new Error(`expected resolved geometry, received ${resolved.reason}`)
  }

  return resolved
}

// ---------------------------------------------------------------------------------------------
// Technical Design §6 — the worked example, to the pixel
// ---------------------------------------------------------------------------------------------

describe('the §6 worked example through the edit stage', () => {
  // Shared: with `preserve` alpha no case writes into the frame it is given.
  const source = coordinateFrame(SOURCE)

  describe.each(WORKED_EXAMPLE)('zoom $zoom', (row) => {
    it.each(QUARTER_TURNS)(
      'matches domain/edit.ts to the pixel with %i quarter turns composed on top',
      (quarterTurns) => {
        const resolved = geometry({ zoom: row.zoom, quarterTurns })
        const ops = editOpsFor(resolved, row.zoom, OPAQUE_WHITE)
        const { frame, caveats } = applyEdit(source, edit(ops), PRESERVE)

        const size = { width: frame.width, height: frame.height }
        expect(size).toEqual(resolved.output.size)
        expect(size).toEqual(resolveEditedSize(SOURCE, ops))
        if (quarterTurns === 0) {
          expect(size).toEqual(row.output)
          expect(hasSpill(resolved.output.spill)).toBe(row.spills)
        }
        expect(frame.pixels.byteLength).toBe(size.width * size.height * 4)
        expect(oracleMismatches(frame, SOURCE, ops)).toEqual({ count: 0, first: [] })
        expect(caveats).toEqual([])
      },
      LARGE_TIMEOUT,
    )
  })

  it(
    'centres the 4000×3000 source in the 8000×6000 spill row and fills all four sides',
    () => {
      const ops = editOpsFor(geometry({ zoom: 0.25 }), 0.25, { r: 10, g: 20, b: 30, a: 1 })
      const { frame } = applyEdit(source, edit(ops), PRESERVE)
      const fill = [10, 20, 30, 255]

      expect([frame.width, frame.height]).toEqual([8000, 6000])
      // Stated literally rather than through the oracle: the source occupies [2000, 6000) × [1500, 4500).
      expect(pixelAt(frame, 1999, 1500)).toEqual(fill)
      expect(pixelAt(frame, 2000, 1499)).toEqual(fill)
      expect(pixelAt(frame, 2000, 1500)).toEqual(encodedPixel(0, 0))
      expect(pixelAt(frame, 5999, 4499)).toEqual(encodedPixel(3999, 2999))
      expect(pixelAt(frame, 6000, 4499)).toEqual(fill)
      expect(pixelAt(frame, 5999, 4500)).toEqual(fill)
      expect(pixelAt(frame, 0, 0)).toEqual(fill)
      expect(pixelAt(frame, 7999, 5999)).toEqual(fill)

      let filled = 0
      for (let offset = 0; offset < frame.pixels.length; offset += 4) {
        if (
          frame.pixels[offset + 3] === 255 &&
          frame.pixels[offset] === 10 &&
          frame.pixels[offset + 1] === 20 &&
          frame.pixels[offset + 2] === 30
        ) {
          filled += 1
        }
      }
      expect(filled).toBe(8000 * 6000 - 4000 * 3000)
    },
    LARGE_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------
// Spill fill
// ---------------------------------------------------------------------------------------------

describe('spill fill', () => {
  const small = { width: 40, height: 30 } as const
  const spillAllSides = { x: -0.5, y: -0.5, width: 2, height: 2 }

  it.each([
    ['transparent', TRANSPARENT, [0, 0, 0, 0]],
    ['half-transparent', { r: 10, g: 20, b: 30, a: 0.5 }, [10, 20, 30, 128]],
    ['opaque', { r: 200, g: 100, b: 50, a: 1 }, [200, 100, 50, 255]],
  ] as const)(
    'writes a %s background verbatim when the format keeps alpha',
    (_, background, bytes) => {
      const ops = [crop(spillAllSides, background)]
      const { frame, caveats } = applyEdit(coordinateFrame(small), edit(ops), PRESERVE)

      expect([frame.width, frame.height]).toEqual([80, 60])
      expect(pixelAt(frame, 0, 0)).toEqual(bytes)
      expect(pixelAt(frame, 79, 59)).toEqual(bytes)
      expect(pixelAt(frame, 20, 15)).toEqual(encodedPixel(0, 0))
      expect(oracleMismatches(frame, small, ops)).toEqual({ count: 0, first: [] })
      expect(caveats).toEqual([])
    },
  )

  it('fills only the overhanging side when the rectangle spills one edge', () => {
    const ops = [crop({ x: 0.5, y: 0, width: 1, height: 1 }, { r: 1, g: 2, b: 3, a: 1 })]
    const { frame } = applyEdit(coordinateFrame(small), edit(ops), PRESERVE)

    expect([frame.width, frame.height]).toEqual([40, 30])
    expect(pixelAt(frame, 0, 0)).toEqual(encodedPixel(20, 0))
    expect(pixelAt(frame, 19, 29)).toEqual(encodedPixel(39, 29))
    expect(pixelAt(frame, 20, 0)).toEqual([1, 2, 3, 255])
    expect(oracleMismatches(frame, small, ops)).toEqual({ count: 0, first: [] })
  })

  it('exports the stored background opaque when the format has no alpha (R-C14, R-C15)', () => {
    const background = { r: 12, g: 34, b: 56, a: 0 }
    const ops = [crop(spillAllSides, background)]
    const alpha = { kind: 'flatten', background: { ...background, a: 1 } } as const
    const { frame, caveats } = applyEdit(coordinateFrame(small), edit(ops), alpha)

    expect(pixelAt(frame, 0, 0)).toEqual([12, 34, 56, 255])
    expect(oracleMismatches(frame, small, ops, alpha)).toEqual({ count: 0, first: [] })
    // The spill was never transparent, so nothing was flattened and nothing is disclosed.
    expect(caveats).toEqual([])
    // The record still holds the transparent choice for a later switch back (R-C15).
    expect(background.a).toBe(0)
  })

  // A crop that misses the image entirely is legal: R-C12 keeps the rectangle inside the frame, not
  // over the image. The image lying past the right edge was once a negative copy length, which
  // `subarray` read as a from-the-end index (leaking source pixels into the fill) or which overran
  // the output (a RangeError the worker would report as out-of-memory).
  it.each([
    ['right of', { x: -2, y: 0, width: 1, height: 1 }],
    ['left of', { x: 2, y: 0, width: 1, height: 1 }],
    ['below', { x: 0, y: -2, width: 1, height: 1 }],
    ['above', { x: 0, y: 2, width: 1, height: 1 }],
    ['diagonally past the bottom-right of', { x: -1.5, y: -1.2, width: 0.8, height: 3 }],
  ] as const)('produces only fill when the image lies wholly %s the output', (_, rect) => {
    const ops = [crop(rect, { r: 5, g: 6, b: 7, a: 1 })]
    const { frame } = applyEdit(coordinateFrame(small), edit(ops), PRESERVE)

    expect({ width: frame.width, height: frame.height }).toEqual(resolveEditedSize(small, ops))
    expect(oracleMismatches(frame, small, ops)).toEqual({ count: 0, first: [] })
  })

  it('fills a crop placed beside the image at zoom 0.25, as the interface allows', () => {
    // The §6 image is drawn 200×150 in the middle of the 800×600 frame; this rectangle sits in the
    // empty strip to its left, so the source lands past the output's right edge.
    const resolved = geometry({ zoom: 0.25, rect: { left: 0, top: 250, width: 250, height: 100 } })
    const ops = editOpsFor(resolved, 0.25, { r: 5, g: 6, b: 7, a: 1 })
    const source = coordinateFrame(SOURCE)
    const { frame } = applyEdit(source, edit(ops), PRESERVE)

    expect([frame.width, frame.height]).toEqual([5000, 2000])
    expect(resolved.output.placement.offsetX).toBeGreaterThan(frame.width)
    expect(oracleMismatches(frame, SOURCE, ops)).toEqual({ count: 0, first: [] })
  })
})

// ---------------------------------------------------------------------------------------------
// Walking the ops generically
// ---------------------------------------------------------------------------------------------

describe('walking EditRecord.ops', () => {
  // Odd, unequal dimensions, so an off-by-one or a swapped axis cannot hide.
  const size = { width: 7, height: 5 } as const

  it('turns clockwise', () => {
    // A B      rotate 1      A
    //                        B
    const { frame } = applyEdit(
      frameOf({ width: 2, height: 1 }, [1, 1, 1, 255, 2, 2, 2, 255]),
      edit([rotate(1)]),
      PRESERVE,
    )

    expect([frame.width, frame.height]).toEqual([1, 2])
    expect(Array.from(frame.pixels)).toEqual([1, 1, 1, 255, 2, 2, 2, 255])

    const turned = applyEdit(
      frameOf({ width: 1, height: 2 }, [1, 1, 1, 255, 2, 2, 2, 255]),
      edit([rotate(1)]),
      PRESERVE,
    )
    expect(Array.from(turned.frame.pixels)).toEqual([2, 2, 2, 255, 1, 1, 1, 255])
  })

  const cases: [string, EditOp[]][] = [
    ['no ops', []],
    ['rotate 0', [rotate(0)]],
    ['rotate 1', [rotate(1)]],
    ['rotate 2', [rotate(2)]],
    ['rotate 3', [rotate(3)]],
    ['rotate then rotate', [rotate(1), rotate(1)]],
    ['crop then rotate', [crop({ x: 0.1, y: 0.2, width: 0.5, height: 0.7 }), rotate(1)]],
    ['rotate then crop', [rotate(3), crop({ x: -0.25, y: 0.3, width: 1.1, height: 0.45 })]],
    [
      'crop then crop',
      [
        crop({ x: -0.3, y: -0.1, width: 1.4, height: 1.3 }, TRANSPARENT),
        crop({ x: 0.2, y: 0.25, width: 0.5, height: 0.6 }),
      ],
    ],
    [
      'rotate, crop, rotate, crop',
      [
        rotate(1),
        crop({ x: 0, y: 0.2, width: 1, height: 0.6 }),
        rotate(2),
        crop({ x: -0.5, y: 0, width: 1.5, height: 1 }, TRANSPARENT),
      ],
    ],
  ]

  it.each(cases)('%s matches resolveEditedSize and the oracle', (_, ops) => {
    const { frame } = applyEdit(coordinateFrame(size), edit(ops), PRESERVE)

    expect({ width: frame.width, height: frame.height }).toEqual(resolveEditedSize(size, ops))
    expect(oracleMismatches(frame, size, ops)).toEqual({ count: 0, first: [] })
  })

  it('makes two single turns identical to one half turn, and four to none', () => {
    const twice = applyEdit(coordinateFrame(size), edit([rotate(1), rotate(1)]), PRESERVE).frame
    const half = applyEdit(coordinateFrame(size), edit([rotate(2)]), PRESERVE).frame
    const four = applyEdit(
      coordinateFrame(size),
      edit([rotate(1), rotate(3), rotate(2), rotate(2)]),
      PRESERVE,
    ).frame

    expect(Array.from(twice.pixels)).toEqual(Array.from(half.pixels))
    expect(Array.from(four.pixels)).toEqual(Array.from(coordinateFrame(size).pixels))
  })

  it('returns the frame untouched when no op changes it', () => {
    const source = coordinateFrame(size)
    const identity = [rotate(0), crop({ x: 0, y: 0, width: 1, height: 1 })]

    expect(applyEdit(source, edit(identity), PRESERVE).frame).toBe(source)
    expect(applyEdit(source, null, PRESERVE).frame).toBe(source)
  })

  it('refuses an operation it does not understand rather than skipping it', () => {
    const unknown = { kind: 'blur', radius: 2 } as unknown as EditOp

    expect(() => applyEdit(coordinateFrame(size), edit([rotate(1), unknown]), PRESERVE)).toThrow(
      EditError,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Alpha handling per output format
// ---------------------------------------------------------------------------------------------

describe('alpha handling', () => {
  const white = { kind: 'flatten', background: OPAQUE_WHITE } as const

  it('composites each alpha level over the fill exactly as round((c·a + bg·(255 − a)) / 255)', () => {
    const colours = [0, 1, 77, 128, 200, 254, 255]
    const background = { r: 13, g: 250, b: 128, a: 1 }
    const bytes: number[] = []

    for (let a = 0; a <= 255; a += 1) {
      for (const c of colours) {
        bytes.push(c, 255 - c, (c * 7) % 256, a)
      }
    }

    const size = { width: colours.length, height: 256 }
    const { frame, caveats } = applyEdit(frameOf(size, bytes), null, {
      kind: 'flatten',
      background,
    })
    const blend = (channel: number, bg: number, a: number) =>
      Math.round((channel * a + bg * (255 - a)) / 255)

    for (let offset = 0; offset < bytes.length; offset += 4) {
      const a = bytes[offset + 3]!
      expect(Array.from(frame.pixels.subarray(offset, offset + 4))).toEqual([
        blend(bytes[offset]!, 13, a),
        blend(bytes[offset + 1]!, 250, a),
        blend(bytes[offset + 2]!, 128, a),
        255,
      ])
    }
    expect(caveats).toEqual([{ kind: 'transparency-flattened', fill: background }])
  })

  it('flattens an unedited transparent source to white and discloses the fill (R-C17)', () => {
    const { frame, caveats } = applyEdit(
      frameOf({ width: 2, height: 1 }, [9, 9, 9, 255, 9, 9, 9, 0]),
      null,
      white,
    )

    expect(Array.from(frame.pixels)).toEqual([9, 9, 9, 255, 255, 255, 255, 255])
    expect(caveats).toEqual([{ kind: 'transparency-flattened', fill: OPAQUE_WHITE }])
  })

  it('discloses nothing for an opaque source, even when the format has no alpha', () => {
    const { caveats } = applyEdit(coordinateFrame({ width: 7, height: 5 }), null, white)

    expect(caveats).toEqual([])
  })

  it('discloses nothing when the crop discarded every transparent pixel', () => {
    // Left half transparent, right half opaque; the crop keeps only the right half.
    const source = frameOf(
      { width: 4, height: 1 },
      [1, 1, 1, 0, 2, 2, 2, 10, 3, 3, 3, 255, 4, 4, 4, 255],
    )
    const ops = [crop({ x: 0.5, y: 0, width: 0.5, height: 1 })]
    const { frame, caveats } = applyEdit(source, edit(ops), white)

    expect(Array.from(frame.pixels)).toEqual([3, 3, 3, 255, 4, 4, 4, 255])
    expect(caveats).toEqual([])
  })

  it('keeps transparency untouched and discloses nothing when the format has alpha (R-C13)', () => {
    const bytes = [1, 2, 3, 0, 4, 5, 6, 128]
    const { frame, caveats } = applyEdit(frameOf({ width: 2, height: 1 }, bytes), null, PRESERVE)

    expect(Array.from(frame.pixels)).toEqual(bytes)
    expect(caveats).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// What the frame carries through
// ---------------------------------------------------------------------------------------------

describe('frame contract', () => {
  const colours: FrameColour[] = [
    { kind: 'icc', profile: new Uint8Array([1, 2, 3]), description: 'Display P3' },
    { kind: 'cicp', cicp: { primaries: 12, transfer: 13, matrix: 6, fullRange: false } },
    { kind: 'untagged' },
  ]

  it.each(colours)(
    'carries $kind colour and the source orientation through unconverted',
    (colour) => {
      const source = {
        ...coordinateFrame({ width: 7, height: 5 }, colour),
        sourceOrientation: { kind: 'present', value: 6 },
      } as const
      const { frame } = applyEdit(
        source,
        edit([rotate(1), crop({ x: -0.1, y: 0, width: 1.2, height: 1 })]),
        PRESERVE,
      )

      expect(frame.colour).toBe(colour)
      expect(frame.sourceOrientation).toEqual({ kind: 'present', value: 6 })
    },
  )

  it.each<[string, EditOp[], AlphaHandling]>([
    ['rotate', [rotate(1)], PRESERVE],
    ['half turn', [rotate(2)], PRESERVE],
    ['crop', [crop({ x: -0.2, y: 0.1, width: 1.3, height: 0.5 })], PRESERVE],
    ['flatten only', [], { kind: 'flatten', background: OPAQUE_WHITE }],
  ])('returns pixels that own their whole buffer after %s', (_, ops, alpha) => {
    const { frame } = applyEdit(coordinateFrame({ width: 7, height: 5 }), edit(ops), alpha)

    expect(ownsWholeBuffer(frame.pixels)).toBe(true)
  })

  it('copies a frame whose pixels are a view rather than flattening someone else’s memory', () => {
    const backing = new Uint8Array(3 + 8)
    backing.set([7, 7, 7, 0, 7, 7, 7, 255], 3)
    const view = backing.subarray(3)
    const source: Frame = {
      width: 2,
      height: 1,
      pixels: view,
      colour: { kind: 'untagged' },
      sourceOrientation: { kind: 'absent' },
    }
    const { frame } = applyEdit(source, null, { kind: 'flatten', background: OPAQUE_WHITE })

    expect(ownsWholeBuffer(frame.pixels)).toBe(true)
    expect(Array.from(frame.pixels)).toEqual([255, 255, 255, 255, 7, 7, 7, 255])
    expect(Array.from(backing.subarray(3))).toEqual([7, 7, 7, 0, 7, 7, 7, 255])
  })
})
